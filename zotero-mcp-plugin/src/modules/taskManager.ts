import {
  PlusError,
  canonicalJSON,
  fingerprint,
  publicError,
  secureID,
  type ExecutionContext,
  type JsonObject,
  type OperationAdapter,
  type OperationPlan,
  type PlanStep,
  type StepOutcome,
} from "./plusTypes.ts";
import { TaskStore, type StepRecord, type TaskRecord } from "./taskStore.ts";
import { MutationCoordinator } from "./mutationCoordinator.ts";

export class TaskManager {
  private store: TaskStore;
  private canWrite: () => boolean;
  private adapters = new Map<string, OperationAdapter>();
  private coordinator = new MutationCoordinator();
  private owner: string;
  private lanes = new Set<string>();
  private active = new Map<
    string,
    { controller: AbortController; promise: Promise<void> }
  >();
  private pumping = false;
  private pumpRequested = false;
  private closing = false;
  private closed = false;
  private securityGeneration = 0;
  private log: (message: string) => void;

  constructor(
    store: TaskStore,
    canWrite: () => boolean,
    log: (message: string) => void = () => undefined,
  ) {
    this.store = store;
    this.canWrite = canWrite;
    this.log = log;
    this.owner = secureID("worker");
  }

  register(adapter: OperationAdapter): void {
    if (this.adapters.has(adapter.tool))
      throw new PlusError("DUPLICATE_ADAPTER", "工具执行器重复注册");
    this.adapters.set(adapter.tool, adapter);
  }

  adapter(tool: string): OperationAdapter {
    const adapter = this.adapters.get(tool);
    if (!adapter) throw new PlusError("UNKNOWN_TOOL", "没有该工具的安全执行器");
    return adapter;
  }

  async recover(): Promise<void> {
    await this.reconcileSteps(await this.store.prepareRecovery());
  }

  private async reconcileSteps(steps: StepRecord[]): Promise<void> {
    for (const step of steps) {
      const task = await this.store.getTask(step.taskID);
      let outcome: StepOutcome;
      try {
        outcome = await this.adapter(task.tool).reconcile(step);
      } catch {
        outcome = {
          state: "needs_review",
          error: {
            code: "RECOVERY_UNCERTAIN",
            message: "无法证明中断操作的实际结果，禁止自动重试",
          },
        };
      }
      // 重启或查询待核查任务时只有只读对账，永远不以 lease 超时授权重新投递。
      outcome = ["succeeded", "externally_satisfied"].includes(outcome.state)
        ? { ...outcome, state: "externally_satisfied", retrySafe: false }
        : { ...outcome, state: "needs_review", retrySafe: false };
      await this.store.recoverResult(step, outcome);
    }
  }

  kick(): void {
    if (this.closing || !this.store.isHealthy()) return;
    if (this.pumping) {
      this.pumpRequested = true;
      return;
    }
    this.pumping = true;
    void this.pump()
      .catch(() => this.log("任务调度停止；请检查账本状态"))
      .finally(() => {
        this.pumping = false;
        if (this.pumpRequested) {
          this.pumpRequested = false;
          this.kick();
        }
      });
  }

  private async pump(): Promise<void> {
    if (!this.canWrite() || this.closing) return;
    const tasks = await this.store.readyTasks();
    for (const task of tasks) {
      if (this.closing || !this.canWrite()) break;
      const adapter = this.adapters.get(task.tool);
      if (!adapter) {
        await this.store.stop(task.id, "pause");
        continue;
      }
      if (this.lanes.has(adapter.lane)) continue;
      const step = await this.store.claim(task.id, this.owner);
      if (!step) continue;
      this.lanes.add(adapter.lane);
      const Abort =
        globalThis.AbortController ?? Zotero.getMainWindow().AbortController;
      const controller = new Abort();
      const promise = this.execute(task, step, adapter, controller).finally(
        () => {
          this.active.delete(step.attemptID!);
          this.lanes.delete(adapter.lane);
          // pump 可能尚在处理其他 lane，放到下一轮而不是递归调度。
          if (!this.closing) setTimeout(() => this.kick(), 0);
        },
      );
      this.active.set(step.attemptID!, { controller, promise });
    }
  }

  private async execute(
    task: TaskRecord,
    step: StepRecord,
    adapter: OperationAdapter,
    controller: AbortController,
  ): Promise<void> {
    let nativeStarted = false;
    const generation = this.securityGeneration;
    const heartbeat = setInterval(() => {
      if (this.closed) return;
      void this.store
        .heartbeat(step)
        .catch(() => this.log("任务 heartbeat 未写入；不启动新的尝试"));
    }, 20000);
    const context: ExecutionContext = {
      taskID: task.id,
      attemptID: step.attemptID!,
      signal: controller.signal,
      update: async (state, detail) => {
        if (this.closed) throw new PlusError("STALE_ATTEMPT", "执行器已关闭");
        await this.store.progress(step, state, detail);
      },
    };
    try {
      const outcome = await this.coordinator.run(adapter, async () => {
        if (!this.canWrite() || this.closing)
          await this.store.stop(task.id, "pause");
        await adapter.check(step);
        if (
          generation !== this.securityGeneration ||
          !this.canWrite() ||
          this.closing
        ) {
          await this.store.stop(task.id, "pause");
        }
        if (!(await this.store.beginNative(step))) return null;
        if (
          generation !== this.securityGeneration ||
          !this.canWrite() ||
          this.closing
        ) {
          await this.store.stop(task.id, "pause");
          throw new PlusError(
            "EXECUTION_PAUSED",
            "调用原生操作前权限已改变；没有提交，可重新预览后重试",
          );
        }
        nativeStarted = true;
        return adapter.execute(step, context);
      });
      if (outcome && !this.closed) await this.store.finish(step, outcome);
    } catch (error) {
      if (this.closed || !this.store.isHealthy()) return;
      let outcome: StepOutcome;
      if (!nativeStarted) {
        outcome = {
          state: "failed",
          error: publicError(error),
          retrySafe: true,
        };
      } else {
        try {
          const reconciled = await adapter.reconcile(step);
          outcome =
            reconciled.state === "succeeded"
              ? { ...reconciled, state: "externally_satisfied" }
              : reconciled;
        } catch {
          outcome = {
            state: "needs_review",
            error: publicError(error),
            retrySafe: false,
          };
        }
      }
      try {
        await this.store.finish(step, outcome);
      } catch {
        this.log("最终结果未落盘；保留执行意图供下次对账");
      }
    } finally {
      clearInterval(heartbeat);
    }
  }

  async suspend(
    reason: string,
    invalidateConfirmations = false,
  ): Promise<void> {
    this.securityGeneration++;
    if (!this.closed && this.store.isHealthy())
      await this.store.pauseAll(reason, invalidateConfirmations);
  }

  async status(taskID: string, args: JsonObject = {}): Promise<JsonObject> {
    if (!this.closing)
      await this.reconcileSteps(
        await this.store.reconciliationCandidates(taskID),
      );
    const { task, steps } = await this.store.taskSnapshot(taskID);
    const offset = args.offset ?? 0;
    const limit = args.limit ?? 100;
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      throw new PlusError("INVALID_ARGUMENT", "任务结果分页范围无效");
    }
    const counts: Record<string, number> = {};
    for (const step of steps)
      counts[step.state] = (counts[step.state] || 0) + 1;
    const { params: _params, ...summary } = task;
    return {
      ...summary,
      taskID,
      counts,
      total: steps.length,
      inFlightNotInterruptible: (counts.submitted || 0) + (counts.running || 0),
      items: steps.slice(offset, offset + limit).map((step) => ({
        id: step.id,
        ordinal: step.ordinal,
        state: step.state,
        phase: step.phase,
        result: step.outcome?.result,
        error: step.outcome?.error,
        retrySafe: step.outcome?.retrySafe === true,
      })),
      nextOffset: offset + limit < steps.length ? offset + limit : null,
      complete: offset + limit >= steps.length,
    };
  }

  async stop(taskID: string, action: "pause" | "cancel"): Promise<JsonObject> {
    await this.store.stop(taskID, action);
    return this.status(taskID);
  }

  controlAdapter(): OperationAdapter {
    const store = this.store;
    const adapterFor = (tool: string) => this.adapter(tool);
    return {
      tool: "task_control",
      lane: "mutation",
      async prepare(args: JsonObject): Promise<OperationPlan> {
        if (
          !["resume", "retry"].includes(args.action) ||
          typeof args.taskID !== "string"
        ) {
          throw new PlusError(
            "INVALID_ARGUMENT",
            "需要 taskID 和 resume/retry 操作",
          );
        }
        const task = await store.getTask(args.taskID);
        const steps = await store.getSteps(task.id);
        if (task.desiredState === "cancelled")
          throw new PlusError("TASK_CANCELLED", "已取消的任务不能恢复");
        if (
          steps.some((step) =>
            ["needs_review", "submitted", "running"].includes(step.state),
          )
        ) {
          throw new PlusError(
            "TASK_NEEDS_REVIEW",
            "请先核实仍在执行或结果不明的条目",
          );
        }
        const candidates = steps.filter(
          (step) =>
            step.state === "pending" ||
            (args.action === "retry" &&
              step.state === "failed" &&
              step.outcome?.retrySafe),
        );
        if (!candidates.length)
          throw new PlusError("NOTHING_TO_RESUME", "没有可安全恢复的条目");
        for (const step of candidates) await adapterFor(task.tool).check(step);
        const snapshot = canonicalJSON(await store.controlSnapshot(task.id));
        return {
          schemaVersion: 1,
          tool: "task_control",
          libraryID: task.libraryID,
          params: args,
          warnings: [
            "只恢复原授权范围中未执行或已证明无副作用的条目；不恢复取消或待核查项",
          ],
          steps: [
            {
              id: task.id,
              input: { ...args, snapshot },
              targets: [],
              fingerprint: await fingerprint(snapshot),
              preview: {
                taskID: task.id,
                action: args.action,
                eligible: candidates.length,
              },
            },
          ],
        };
      },
      async check(step: PlanStep): Promise<void> {
        const snapshot = canonicalJSON(
          await store.controlSnapshot(step.input.taskID),
        );
        if (snapshot !== step.input.snapshot)
          throw new PlusError("STATE_CHANGED", "任务状态已改变，请重新预览");
        const task = await store.getTask(step.input.taskID);
        for (const candidate of await store.getSteps(task.id)) {
          if (
            candidate.state === "pending" ||
            (step.input.action === "retry" &&
              candidate.state === "failed" &&
              candidate.outcome?.retrySafe)
          ) {
            await adapterFor(task.tool).check(candidate);
          }
        }
      },
      async execute(step: PlanStep): Promise<StepOutcome> {
        await store.resumeConfirmed(
          step.input.taskID,
          step.input.snapshot,
          step.input.action === "retry",
        );
        return {
          state: "succeeded",
          result: { taskID: step.input.taskID, action: step.input.action },
        };
      },
      async reconcile(step: PlanStep): Promise<StepOutcome> {
        const task = await store.getTask(step.input.taskID);
        return task.desiredState === "running"
          ? { state: "externally_satisfied", result: { taskID: task.id } }
          : {
              state: "needs_review",
              error: {
                code: "CONTROL_UNCERTAIN",
                message: "任务控制结果无法确认",
              },
            };
      },
    };
  }

  async shutdown(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    await this.suspend("shutdown", true).catch(() =>
      this.log("暂停状态未落盘，保留原有执行意图"),
    );
    for (const active of this.active.values()) active.controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(
        [...this.active.values()].map((entry) => entry.promise),
      ),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 5000);
      }),
    ]);
    if (timer) clearTimeout(timer);
    try {
      if (this.store.isHealthy()) await this.store.prepareRecovery();
    } finally {
      this.closed = true;
      await this.store.close();
    }
  }
}
