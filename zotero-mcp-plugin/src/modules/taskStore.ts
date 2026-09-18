import {
  PlusError,
  canonicalJSON,
  secureID,
  targetID,
  type JsonObject,
  type OperationPlan,
  type PlanStep,
  type StepOutcome,
  type StepState,
} from "./plusTypes.ts";

export interface LedgerConnection {
  queryAsync(sql: string, params?: any[]): Promise<any>;
  valueQueryAsync(sql: string, params?: any[]): Promise<any>;
  executeTransaction<T>(operation: () => Promise<T>): Promise<T>;
  closeDatabase(): Promise<void>;
}

export interface TaskRecord {
  id: string;
  tool: string;
  libraryID: number;
  state: string;
  desiredState: "running" | "paused" | "cancelled";
  createdAt: number;
  updatedAt: number;
  params: JsonObject;
}

export interface StepRecord extends PlanStep {
  taskID: string;
  ordinal: number;
  state: StepState;
  phase: string;
  attemptID: string | null;
  owner: string | null;
  leaseUntil: number | null;
  outcome: StepOutcome | null;
}

const PENDING_STATES = new Set(["pending", "submitted", "running"]);
const RESERVING_STATES = new Set([...PENDING_STATES, "needs_review"]);

export class TaskStore {
  private db: LedgerConnection;
  private healthy = false;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(db: LedgerConnection) {
    this.db = db;
  }

  async initialize(): Promise<void> {
    const version = Number(
      await this.db.valueQueryAsync("PRAGMA user_version"),
    );
    if (version > 1) {
      throw new PlusError(
        "LEDGER_VERSION_UNSUPPORTED",
        "任务数据库版本高于当前插件，禁止降级写入",
      );
    }
    const integrity = await this.db.valueQueryAsync("PRAGMA quick_check");
    if (integrity !== "ok") {
      throw new PlusError(
        "LEDGER_CORRUPT",
        "任务数据库检查失败，已保留原文件并停止写入",
      );
    }
    await this.db.queryAsync("PRAGMA journal_mode = WAL");
    await this.db.queryAsync("PRAGMA synchronous = FULL");
    await this.db.executeTransaction(async () => {
      await this.db.queryAsync(`CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, tool TEXT NOT NULL, libraryID INTEGER NOT NULL,
        state TEXT NOT NULL, desiredState TEXT NOT NULL,
        createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, paramsJSON TEXT NOT NULL
      )`);
      await this.db.queryAsync(`CREATE TABLE IF NOT EXISTS steps (
        taskID TEXT NOT NULL, ordinal INTEGER NOT NULL, id TEXT NOT NULL,
        specJSON TEXT NOT NULL, state TEXT NOT NULL, phase TEXT NOT NULL,
        attemptID TEXT, owner TEXT, leaseUntil INTEGER, outcomeJSON TEXT,
        PRIMARY KEY (taskID, ordinal)
      )`);
      await this.db.queryAsync(`CREATE TABLE IF NOT EXISTS confirmations (
        tokenHash TEXT PRIMARY KEY, requestHash TEXT NOT NULL,
        planJSON TEXT NOT NULL, expiresAt INTEGER NOT NULL, consumedBy TEXT
      )`);
      await this.db.queryAsync(`CREATE TABLE IF NOT EXISTS idempotency (
        key TEXT PRIMARY KEY, requestHash TEXT NOT NULL, taskID TEXT NOT NULL
      )`);
      await this.db.queryAsync(`CREATE TABLE IF NOT EXISTS reservations (
        target TEXT PRIMARY KEY, taskID TEXT NOT NULL
      )`);
      await this.db.queryAsync(`CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, taskID TEXT NOT NULL,
        createdAt INTEGER NOT NULL, kind TEXT NOT NULL, detailJSON TEXT NOT NULL
      )`);
      await this.db.queryAsync(
        "CREATE INDEX IF NOT EXISTS tasks_state ON tasks(desiredState, state, createdAt)",
      );
      await this.db.queryAsync(
        "CREATE INDEX IF NOT EXISTS steps_state ON steps(taskID, state)",
      );
      await this.db.queryAsync("PRAGMA user_version = 1");
    });
    this.healthy = true;
  }

  private assertHealthy(): void {
    if (!this.healthy)
      throw new PlusError(
        "LEDGER_UNAVAILABLE",
        "任务账本不可用，禁止接受新的写入",
      );
  }

  // 同一连接的事务串行；业务拒绝不使账本失效，I/O 或数据库错误则立即收口。
  private transaction<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(async () => {
      this.assertHealthy();
      try {
        return await this.db.executeTransaction(operation);
      } catch (error) {
        if (!(error instanceof PlusError)) this.healthy = false;
        throw error;
      }
    });
    this.tail = next.catch(() => undefined);
    return next;
  }

  async close(): Promise<void> {
    await this.tail;
    this.healthy = false;
    await this.db.closeDatabase();
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  async savePreview(
    tokenHash: string,
    requestHash: string,
    plan: OperationPlan,
    expiresAt: number,
  ): Promise<void> {
    await this.transaction(async () => {
      await this.db.queryAsync(
        "DELETE FROM confirmations WHERE consumedBy IS NULL AND expiresAt < ?",
        [Date.now()],
      );
      await this.db.queryAsync(
        "INSERT INTO confirmations (tokenHash, requestHash, planJSON, expiresAt) VALUES (?, ?, ?, ?)",
        [tokenHash, requestHash, canonicalJSON(plan), expiresAt],
      );
    });
  }

  // 读请求也经过同一连接的串行边界，不能看见另一请求尚未提交的幂等记录。
  async existingRequest(
    key: string,
    requestHash: string,
  ): Promise<string | null> {
    return this.transaction(() => this.readExistingRequest(key, requestHash));
  }

  async getTask(id: string): Promise<TaskRecord> {
    return this.transaction(() => this.readTask(id));
  }

  async getSteps(id: string): Promise<StepRecord[]> {
    return this.transaction(() => this.readSteps(id));
  }

  async taskSnapshot(
    id: string,
  ): Promise<{ task: TaskRecord; steps: StepRecord[] }> {
    return this.transaction(async () => ({
      task: await this.readTask(id),
      steps: await this.readSteps(id),
    }));
  }

  async controlSnapshot(id: string): Promise<JsonObject> {
    return this.transaction(() => this.readControlSnapshot(id));
  }

  async healthSummary(libraryID: number): Promise<JsonObject> {
    return this.transaction(async () => {
      const rows = await this.db.queryAsync(
        "SELECT state, COUNT(*) AS count FROM tasks WHERE libraryID = ? GROUP BY state",
        [libraryID],
      );
      const counts = Object.fromEntries(
        rows.map((row: any) => [row.state, Number(row.count)]),
      );
      return {
        interruptedCount:
          (counts.paused || 0) +
          (counts.pause_requested || 0) +
          (counts.interrupted || 0),
        needsReviewCount: counts.needs_review || 0,
        details: { ledgerAvailable: true, countsKnown: true, byState: counts },
      };
    });
  }

  private async readExistingRequest(
    key: string,
    requestHash: string,
  ): Promise<string | null> {
    this.assertHealthy();
    const rows = await this.db.queryAsync(
      "SELECT requestHash, taskID FROM idempotency WHERE key = ?",
      [key],
    );
    if (!rows.length) return null;
    if (rows[0].requestHash !== requestHash) {
      throw new PlusError("IDEMPOTENCY_CONFLICT", "该幂等键已用于不同的请求");
    }
    return rows[0].taskID;
  }

  async enqueue(
    tokenHash: string,
    requestHash: string,
    key: string,
  ): Promise<{ taskID: string; replayed: boolean }> {
    return this.transaction(async () => {
      const existing = await this.readExistingRequest(key, requestHash);
      if (existing) return { taskID: existing, replayed: true };
      const rows = await this.db.queryAsync(
        "SELECT * FROM confirmations WHERE tokenHash = ?",
        [tokenHash],
      );
      const confirmation = rows[0];
      if (!confirmation || confirmation.requestHash !== requestHash) {
        throw new PlusError(
          "CONFIRMATION_REQUIRED",
          "需要与当前请求一致的预览确认令牌",
        );
      }
      if (confirmation.consumedBy)
        throw new PlusError(
          "CONFIRMATION_USED",
          "确认令牌已消费，不能换幂等键重复执行",
        );
      if (confirmation.expiresAt < Date.now())
        throw new PlusError(
          "CONFIRMATION_EXPIRED",
          "确认令牌已过期，请重新预览",
        );
      const plan = JSON.parse(confirmation.planJSON) as OperationPlan;
      const eligible = plan.steps.filter(
        (step) => !step.skipReason && !step.blockers?.length,
      );
      if (!eligible.length)
        throw new PlusError("PLAN_NOT_EXECUTABLE", "没有可以安全执行的目标");
      if (plan.schemaVersion !== 1)
        throw new PlusError(
          "PLAN_VERSION_UNSUPPORTED",
          "预览版本不兼容，请重新预览",
        );
      const targets = [
        ...new Set(eligible.flatMap((step) => step.targets.map(targetID))),
      ];
      for (const target of targets) {
        const conflicts = await this.db.queryAsync(
          "SELECT taskID FROM reservations WHERE target = ?",
          [target],
        );
        if (conflicts.length) {
          throw new PlusError("TARGET_RESERVED", "目标已有待执行或待核查任务", {
            taskID: conflicts[0].taskID,
          });
        }
      }
      const now = Date.now();
      const id = secureID("task");
      await this.db.queryAsync(
        "INSERT INTO tasks VALUES (?, ?, ?, 'queued', 'running', ?, ?, ?)",
        [id, plan.tool, plan.libraryID, now, now, canonicalJSON(plan.params)],
      );
      for (const [ordinal, step] of plan.steps.entries()) {
        const blocked = step.skipReason || step.blockers?.[0]?.code;
        const outcome: StepOutcome | null = blocked
          ? { state: "skipped", result: { reason: blocked }, retrySafe: false }
          : null;
        await this.db.queryAsync(
          "INSERT INTO steps (taskID, ordinal, id, specJSON, state, phase, outcomeJSON) VALUES (?, ?, ?, ?, ?, ?, ?)",
          [
            id,
            ordinal,
            step.id,
            canonicalJSON(step),
            blocked ? "skipped" : "pending",
            "not_submitted",
            outcome ? canonicalJSON(outcome) : null,
          ],
        );
      }
      for (const target of targets) {
        await this.db.queryAsync("INSERT INTO reservations VALUES (?, ?)", [
          target,
          id,
        ]);
      }
      await this.db.queryAsync("INSERT INTO idempotency VALUES (?, ?, ?)", [
        key,
        requestHash,
        id,
      ]);
      await this.db.queryAsync(
        "UPDATE confirmations SET consumedBy = ? WHERE tokenHash = ?",
        [id, tokenHash],
      );
      await this.event(id, "accepted", {
        total: plan.steps.length,
        eligible: eligible.length,
      });
      return { taskID: id, replayed: false };
    });
  }

  private async event(
    taskID: string,
    kind: string,
    detail: JsonObject,
  ): Promise<void> {
    await this.db.queryAsync(
      "INSERT INTO events (taskID, createdAt, kind, detailJSON) VALUES (?, ?, ?, ?)",
      [taskID, Date.now(), kind, canonicalJSON(detail)],
    );
  }

  private taskSummaryFromRow(row: any): Omit<TaskRecord, "params"> {
    // Zotero 返回 mozIStorageRow 的 Proxy，并不是可展开或直接 JSON 化的普通对象。
    return {
      id: row.id,
      tool: row.tool,
      libraryID: row.libraryID,
      state: row.state,
      desiredState: row.desiredState,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private taskFromRow(row: any): TaskRecord {
    return {
      ...this.taskSummaryFromRow(row),
      params: JSON.parse(row.paramsJSON),
    };
  }

  private stepFromRow(row: any): StepRecord {
    return {
      ...JSON.parse(row.specJSON),
      taskID: row.taskID,
      ordinal: row.ordinal,
      id: row.id,
      state: row.state,
      phase: row.phase,
      attemptID: row.attemptID,
      owner: row.owner,
      leaseUntil: row.leaseUntil,
      outcome: row.outcomeJSON ? JSON.parse(row.outcomeJSON) : null,
    };
  }

  private async readTask(id: string): Promise<TaskRecord> {
    this.assertHealthy();
    const rows = await this.db.queryAsync("SELECT * FROM tasks WHERE id = ?", [
      id,
    ]);
    if (!rows.length)
      throw new PlusError(
        "TASK_NOT_FOUND",
        "找不到任务；旧插件纯内存 job 不能凭空恢复",
      );
    return this.taskFromRow(rows[0]);
  }

  private async readSteps(id: string): Promise<StepRecord[]> {
    this.assertHealthy();
    const rows = await this.db.queryAsync(
      "SELECT * FROM steps WHERE taskID = ? ORDER BY ordinal",
      [id],
    );
    return rows.map((row: any) => this.stepFromRow(row));
  }

  async list(args: JsonObject = {}): Promise<JsonObject> {
    return this.transaction(() => this.readList(args));
  }

  private async readList(args: JsonObject): Promise<JsonObject> {
    this.assertHealthy();
    const limit = Math.min(100, Math.max(1, Number(args.limit) || 20));
    const offset = Math.max(0, Number(args.offset) || 0);
    if (!Number.isInteger(limit) || !Number.isInteger(offset))
      throw new PlusError("INVALID_ARGUMENT", "分页参数必须是整数");
    const filters: string[] = [];
    const params: any[] = [];
    for (const field of ["libraryID", "state", "tool"]) {
      if (args[field] !== undefined) {
        filters.push(`${field} = ?`);
        params.push(args[field]);
      }
    }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const total = Number(
      await this.db.valueQueryAsync(
        `SELECT COUNT(*) FROM tasks ${where}`,
        params,
      ),
    );
    const rows = await this.db.queryAsync(
      `SELECT id, tool, libraryID, state, desiredState, createdAt, updatedAt FROM tasks ${where} ORDER BY createdAt DESC, id LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    return {
      tasks: rows.map((row: any) => this.taskSummaryFromRow(row)),
      total,
      complete: offset + rows.length >= total,
      nextOffset: offset + rows.length < total ? offset + rows.length : null,
    };
  }

  async readyTasks(): Promise<TaskRecord[]> {
    return this.transaction(async () => {
      const rows = await this.db.queryAsync(
        "SELECT * FROM tasks WHERE desiredState = 'running' AND state IN ('queued', 'running') ORDER BY createdAt, id",
      );
      return rows.map((row: any) => this.taskFromRow(row));
    });
  }

  async claim(taskID: string, owner: string): Promise<StepRecord | null> {
    return this.transaction(async () => {
      const task = await this.readTask(taskID);
      if (
        task.desiredState !== "running" ||
        !["queued", "running"].includes(task.state)
      )
        return null;
      const rows = await this.db.queryAsync(
        "SELECT * FROM steps WHERE taskID = ? AND state = 'pending' ORDER BY ordinal LIMIT 1",
        [taskID],
      );
      if (!rows.length) {
        await this.refreshTask(taskID);
        return null;
      }
      const row = rows[0];
      const attemptID = secureID("attempt");
      const leaseUntil = Date.now() + 60000;
      await this.db.queryAsync(
        "UPDATE steps SET state = 'submitted', phase = 'validating', attemptID = ?, owner = ?, leaseUntil = ? WHERE taskID = ? AND ordinal = ? AND state = 'pending'",
        [attemptID, owner, leaseUntil, taskID, row.ordinal],
      );
      await this.db.queryAsync(
        "UPDATE tasks SET state = 'running', updatedAt = ? WHERE id = ?",
        [Date.now(), taskID],
      );
      await this.event(taskID, "claimed", {
        ordinal: row.ordinal,
        attemptID,
        owner,
      });
      return {
        ...this.stepFromRow(row),
        state: "submitted",
        phase: "validating",
        attemptID,
        owner,
        leaseUntil,
      };
    });
  }

  private async currentAttempt(step: StepRecord): Promise<any> {
    const rows = await this.db.queryAsync(
      "SELECT * FROM steps WHERE taskID = ? AND ordinal = ?",
      [step.taskID, step.ordinal],
    );
    const current = rows[0];
    if (
      !current ||
      current.attemptID !== step.attemptID ||
      current.owner !== step.owner ||
      !["submitted", "running"].includes(current.state)
    ) {
      throw new PlusError("STALE_ATTEMPT", "旧执行实例不能覆盖当前任务状态");
    }
    return current;
  }

  async beginNative(step: StepRecord): Promise<boolean> {
    return this.transaction(async () => {
      await this.currentAttempt(step);
      const task = await this.readTask(step.taskID);
      if (task.desiredState !== "running") {
        await this.db.queryAsync(
          "UPDATE steps SET state = ?, phase = 'not_submitted', attemptID = NULL, owner = NULL, leaseUntil = NULL WHERE taskID = ? AND ordinal = ?",
          [
            task.desiredState === "cancelled" ? "cancelled" : "pending",
            step.taskID,
            step.ordinal,
          ],
        );
        await this.refreshTask(step.taskID);
        return false;
      }
      await this.db.queryAsync(
        "UPDATE steps SET phase = 'native_intent', leaseUntil = ? WHERE taskID = ? AND ordinal = ?",
        [Date.now() + 60000, step.taskID, step.ordinal],
      );
      await this.event(step.taskID, "native_intent", {
        ordinal: step.ordinal,
        attemptID: step.attemptID,
      });
      return true;
    });
  }

  async progress(
    step: StepRecord,
    state: "submitted" | "running",
    detail: JsonObject = {},
  ): Promise<void> {
    await this.transaction(async () => {
      await this.currentAttempt(step);
      await this.db.queryAsync(
        "UPDATE steps SET state = ?, phase = ?, leaseUntil = ? WHERE taskID = ? AND ordinal = ?",
        [
          state,
          state === "running" ? "native_running" : "native_queued",
          Date.now() + 60000,
          step.taskID,
          step.ordinal,
        ],
      );
      await this.db.queryAsync("UPDATE tasks SET updatedAt = ? WHERE id = ?", [
        Date.now(),
        step.taskID,
      ]);
      await this.event(step.taskID, "progress", {
        ordinal: step.ordinal,
        attemptID: step.attemptID,
        ...detail,
      });
    });
  }

  async heartbeat(step: StepRecord): Promise<void> {
    await this.transaction(async () => {
      await this.currentAttempt(step);
      await this.db.queryAsync(
        "UPDATE steps SET leaseUntil = ? WHERE taskID = ? AND ordinal = ?",
        [Date.now() + 60000, step.taskID, step.ordinal],
      );
    });
  }

  async finish(step: StepRecord, outcome: StepOutcome): Promise<void> {
    await this.transaction(async () => {
      await this.currentAttempt(step);
      await this.db.queryAsync(
        "UPDATE steps SET state = ?, phase = 'settled', outcomeJSON = ?, leaseUntil = NULL WHERE taskID = ? AND ordinal = ?",
        [outcome.state, canonicalJSON(outcome), step.taskID, step.ordinal],
      );
      await this.event(step.taskID, "settled", {
        ordinal: step.ordinal,
        attemptID: step.attemptID,
        state: outcome.state,
      });
      if (outcome.state === "needs_review") {
        await this.db.queryAsync(
          "UPDATE tasks SET desiredState = 'paused' WHERE id = ?",
          [step.taskID],
        );
      }
      await this.refreshTask(step.taskID);
    });
  }

  private async refreshTask(taskID: string): Promise<void> {
    const task = await this.readTask(taskID);
    const steps = await this.readSteps(taskID);
    const inFlight = steps.some((step) =>
      ["submitted", "running"].includes(step.state),
    );
    const pending = steps.some((step) => step.state === "pending");
    const uncertain = steps.some((step) => step.state === "needs_review");
    let state: string;
    if (inFlight)
      state =
        task.desiredState === "running"
          ? "running"
          : task.desiredState === "paused"
            ? "pause_requested"
            : "cancel_requested";
    else if (uncertain) state = "needs_review";
    else if (task.desiredState === "cancelled") state = "cancelled";
    else if (pending)
      state = task.desiredState === "paused" ? "paused" : "queued";
    else
      state = steps.some((step) => step.state === "failed")
        ? "completed_with_errors"
        : "completed";
    await this.db.queryAsync(
      "UPDATE tasks SET state = ?, updatedAt = ? WHERE id = ?",
      [state, Date.now(), taskID],
    );
    const retained = new Set(
      steps
        .filter((step) => RESERVING_STATES.has(step.state))
        .flatMap((step) => step.targets.map(targetID)),
    );
    const reservations = await this.db.queryAsync(
      "SELECT target FROM reservations WHERE taskID = ?",
      [taskID],
    );
    for (const row of reservations) {
      if (!retained.has(row.target))
        await this.db.queryAsync(
          "DELETE FROM reservations WHERE taskID = ? AND target = ?",
          [taskID, row.target],
        );
    }
  }

  async stop(taskID: string, action: "pause" | "cancel"): Promise<void> {
    await this.transaction(async () => {
      const task = await this.readTask(taskID);
      if (
        ["completed", "completed_with_errors", "cancelled", "failed"].includes(
          task.state,
        ) ||
        task.desiredState === "cancelled"
      )
        return;
      await this.db.queryAsync(
        "UPDATE tasks SET desiredState = ? WHERE id = ?",
        [action === "cancel" ? "cancelled" : "paused", taskID],
      );
      if (action === "cancel") {
        await this.db.queryAsync(
          "UPDATE steps SET state = 'cancelled', phase = 'not_submitted' WHERE taskID = ? AND state = 'pending'",
          [taskID],
        );
      }
      await this.event(taskID, action, {});
      await this.refreshTask(taskID);
    });
  }

  async pauseAll(
    reason: string,
    invalidateConfirmations = false,
  ): Promise<void> {
    await this.transaction(async () => {
      const rows = await this.db.queryAsync(
        "SELECT id FROM tasks WHERE desiredState = 'running' AND state NOT IN ('completed', 'completed_with_errors', 'cancelled', 'failed')",
      );
      for (const row of rows) {
        await this.db.queryAsync(
          "UPDATE tasks SET desiredState = 'paused' WHERE id = ?",
          [row.id],
        );
        await this.event(row.id, "paused", { reason });
        await this.refreshTask(row.id);
      }
      if (invalidateConfirmations)
        await this.db.queryAsync(
          "UPDATE confirmations SET expiresAt = 0 WHERE consumedBy IS NULL",
        );
    });
  }

  async prepareRecovery(): Promise<StepRecord[]> {
    return this.transaction(async () => {
      await this.db.queryAsync(
        "UPDATE tasks SET desiredState = 'paused' WHERE desiredState = 'running' AND state NOT IN ('completed', 'completed_with_errors', 'cancelled', 'failed')",
      );
      await this.db.queryAsync(
        "UPDATE confirmations SET expiresAt = 0 WHERE consumedBy IS NULL",
      );
      const rows = await this.db.queryAsync(
        "SELECT * FROM steps WHERE state IN ('submitted', 'running', 'needs_review')",
      );
      const uncertain: StepRecord[] = [];
      for (const row of rows) {
        if (row.phase === "validating") {
          const task = await this.readTask(row.taskID);
          await this.db.queryAsync(
            "UPDATE steps SET state = ?, phase = 'not_submitted', owner = NULL, attemptID = NULL, leaseUntil = NULL WHERE taskID = ? AND ordinal = ?",
            [
              task.desiredState === "cancelled" ? "cancelled" : "pending",
              row.taskID,
              row.ordinal,
            ],
          );
        } else {
          uncertain.push(this.stepFromRow(row));
          await this.db.queryAsync(
            "UPDATE steps SET state = 'needs_review', phase = 'recovering', leaseUntil = NULL WHERE taskID = ? AND ordinal = ?",
            [row.taskID, row.ordinal],
          );
        }
      }
      const tasks = await this.db.queryAsync(
        "SELECT id FROM tasks WHERE desiredState IN ('paused', 'cancelled') AND state NOT IN ('completed', 'completed_with_errors', 'cancelled', 'failed')",
      );
      for (const task of tasks) await this.refreshTask(task.id);
      return uncertain;
    });
  }

  async reconciliationCandidates(taskID: string): Promise<StepRecord[]> {
    return this.transaction(async () => {
      const steps = (await this.readSteps(taskID)).filter(
        (step) => step.state === "needs_review",
      );
      for (const step of steps) {
        await this.db.queryAsync(
          "UPDATE steps SET phase = 'recovering' WHERE taskID = ? AND ordinal = ? AND state = 'needs_review'",
          [taskID, step.ordinal],
        );
      }
      return steps;
    });
  }

  async recoverResult(step: StepRecord, outcome: StepOutcome): Promise<void> {
    await this.transaction(async () => {
      const rows = await this.db.queryAsync(
        "SELECT phase, attemptID FROM steps WHERE taskID = ? AND ordinal = ?",
        [step.taskID, step.ordinal],
      );
      if (
        rows[0]?.phase !== "recovering" ||
        rows[0].attemptID !== step.attemptID
      )
        return;
      await this.db.queryAsync(
        "UPDATE steps SET state = ?, phase = 'reconciled', outcomeJSON = ? WHERE taskID = ? AND ordinal = ?",
        [outcome.state, canonicalJSON(outcome), step.taskID, step.ordinal],
      );
      await this.event(step.taskID, "reconciled", {
        ordinal: step.ordinal,
        state: outcome.state,
      });
      await this.refreshTask(step.taskID);
    });
  }

  private async readControlSnapshot(taskID: string): Promise<JsonObject> {
    const task = await this.readTask(taskID);
    const steps = await this.readSteps(taskID);
    return {
      taskID,
      state: task.state,
      desiredState: task.desiredState,
      steps: steps.map((step) => ({
        ordinal: step.ordinal,
        state: step.state,
        fingerprint: step.fingerprint,
        retrySafe: step.outcome?.retrySafe === true,
      })),
    };
  }

  async resumeConfirmed(
    taskID: string,
    expected: string,
    retry: boolean,
  ): Promise<void> {
    await this.transaction(async () => {
      const snapshot = await this.readControlSnapshot(taskID);
      if (canonicalJSON(snapshot) !== expected)
        throw new PlusError(
          "STATE_CHANGED",
          "任务状态已改变，请重新预览控制操作",
        );
      const task = await this.readTask(taskID);
      if (task.desiredState === "cancelled")
        throw new PlusError(
          "TASK_CANCELLED",
          "取消后的任务不能通过恢复重新执行",
        );
      const steps = await this.readSteps(taskID);
      if (
        steps.some((step) =>
          ["submitted", "running", "needs_review"].includes(step.state),
        )
      ) {
        throw new PlusError("TASK_NEEDS_REVIEW", "任务仍有执行中或待核查条目");
      }
      if (retry) {
        for (const step of steps.filter(
          (item) => item.state === "failed" && item.outcome?.retrySafe,
        )) {
          for (const target of step.targets) {
            const reservation = await this.db.queryAsync(
              "SELECT taskID FROM reservations WHERE target = ?",
              [targetID(target)],
            );
            if (reservation.length && reservation[0].taskID !== taskID)
              throw new PlusError("TARGET_RESERVED", "重试目标已有其他任务");
            if (!reservation.length)
              await this.db.queryAsync(
                "INSERT INTO reservations VALUES (?, ?)",
                [targetID(target), taskID],
              );
          }
          await this.db.queryAsync(
            "UPDATE steps SET state = 'pending', phase = 'not_submitted', attemptID = NULL, owner = NULL, outcomeJSON = NULL WHERE taskID = ? AND ordinal = ?",
            [taskID, step.ordinal],
          );
        }
      }
      if (
        !(await this.readSteps(taskID)).some((step) => step.state === "pending")
      )
        throw new PlusError("NOTHING_TO_RESUME", "没有可恢复的未执行条目");
      await this.db.queryAsync(
        "UPDATE tasks SET desiredState = 'running' WHERE id = ?",
        [taskID],
      );
      await this.event(taskID, retry ? "retry" : "resume", {});
      await this.refreshTask(taskID);
    });
  }
}
