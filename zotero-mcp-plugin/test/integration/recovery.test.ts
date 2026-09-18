import {
  TaskStore,
  type LedgerConnection,
} from "../../src/modules/taskStore.ts";
import { TaskManager } from "../../src/modules/taskManager.ts";
import {
  fingerprint,
  type JsonObject,
  type OperationAdapter,
  type OperationPlan,
  type PlanStep,
  type StepOutcome,
} from "../../src/modules/plusTypes.ts";

declare const expect: Chai.ExpectStatic;

const ISOLATED_PREF = "extensions.zotero.zotero-mcp-plus.test.isolated";

describe("Plus 崩溃与重开恢复集成测试 (Zotero sidecar recovery)", function () {
  before(function () {
    const dataDir = Zotero.DataDirectory.dir.replace(/\\/g, "/");
    if (
      !dataDir.endsWith("/.scaffold/test/data") ||
      Zotero.Prefs.get(ISOLATED_PREF, true) !== true
    ) {
      throw new Error(
        "恢复集成测试只允许在 .scaffold/test/data 隔离文库中运行",
      );
    }
  });

  after(async function () {
    const dataDir = Zotero.DataDirectory.dir.replace(/\\/g, "/");
    if (
      !dataDir.endsWith("/.scaffold/test/data") ||
      Zotero.Prefs.get(ISOLATED_PREF, true) !== true
    ) {
      return;
    }
    const tests = this.test?.parent?.tests || [];
    await IOUtils.writeUTF8(
      PathUtils.join(Zotero.DataDirectory.dir, "recovery-result.json"),
      JSON.stringify({
        total: tests.length,
        passed: tests.filter((test) => test.state === "passed").length,
        failed: tests.filter((test) => test.state === "failed").length,
      }),
    );
  });

  function openLedgerStore(dbPath: string): {
    connection: LedgerConnection;
    store: TaskStore;
  } {
    const connection = new Zotero.DBConnection(
      dbPath,
    ) as unknown as LedgerConnection;
    const store = new TaskStore(connection);
    return { connection, store };
  }

  function createPlan(
    tool: string,
    libraryID: number,
    itemKey: string,
    params: JsonObject = {},
  ): OperationPlan {
    return {
      schemaVersion: 1,
      tool,
      libraryID,
      params,
      steps: [
        {
          id: `step-${itemKey}`,
          input: { key: itemKey, ...params },
          targets: [{ libraryID, key: itemKey, kind: "item" }],
          fingerprint: `fp-${itemKey}`,
          preview: { itemKey, ...params },
        },
      ],
      warnings: [],
    };
  }

  it("native_intent后关闭重开manager.recover，只读未满足应needs_review且reservation阻止新幂等，execute调用0", async function () {
    const dbFile = PathUtils.join(
      Zotero.DataDirectory.dir,
      `recovery-case1-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
    );

    let store1: TaskStore | null = null;
    let store2: TaskStore | null = null;
    let manager2: TaskManager | null = null;

    try {
      // 1. 初始化会话 1 并推进至 native_intent 阶段
      const l1 = openLedgerStore(dbFile);
      store1 = l1.store;
      await store1.initialize();

      const itemKey = "RECOV001";
      const plan = createPlan(
        "test_tool_native",
        Zotero.Libraries.userLibraryID,
        itemKey,
      );
      const tokenHash = await fingerprint(`tok-c1-${Date.now()}`);
      const reqHash = await fingerprint({
        tool: plan.tool,
        params: plan.params,
      });
      await store1.savePreview(tokenHash, reqHash, plan, Date.now() + 60000);

      const { taskID } = await store1.enqueue(
        tokenHash,
        reqHash,
        "idem-case1-task",
      );
      const step = await store1.claim(taskID, "worker-phase1");
      expect(step).to.not.be.null;

      const nativeStarted = await store1.beginNative(step!);
      expect(nativeStarted).to.be.true;

      // 2. 模拟进程在进入 native_intent 后中断退出并关闭 ledger
      await store1.close();
      store1 = null;

      // 3. 重开会话 2 并执行 manager.recover()
      const l2 = openLedgerStore(dbFile);
      store2 = l2.store;
      await store2.initialize();

      manager2 = new TaskManager(store2, () => true);

      let executeCalls = 0;
      let reconcileCalls = 0;

      const recoveryAdapter: OperationAdapter = {
        tool: "test_tool_native",
        lane: "mutation",
        async prepare(params) {
          return createPlan(
            "test_tool_native",
            Zotero.Libraries.userLibraryID,
            itemKey,
            params,
          );
        },
        async check(_s: PlanStep) {},
        async execute(_s: PlanStep, _ctx: any): Promise<StepOutcome> {
          executeCalls++;
          return { state: "succeeded" };
        },
        async reconcile(_s: PlanStep): Promise<StepOutcome> {
          reconcileCalls++;
          // 只读未满足，无法核实外部完成状态
          return {
            state: "needs_review",
            error: { code: "UNSATISFIED", message: "只读对账未满足" },
          };
        },
      };

      manager2.register(recoveryAdapter);
      await manager2.recover();

      // 断言：恢复阶段绝不自动重新发起原生写入
      expect(executeCalls).to.equal(0);
      expect(reconcileCalls).to.equal(1);

      const steps = await store2.getSteps(taskID);
      expect(steps[0].state).to.equal("needs_review");

      const task = await store2.getTask(taskID);
      expect(task.state).to.equal("needs_review");
      expect(task.desiredState).to.equal("paused");

      // 断言：reservation 依然被 needs_review 步骤保留，阻止对同一 target 发起新任务
      const planConflict = createPlan(
        "test_tool_native",
        Zotero.Libraries.userLibraryID,
        itemKey,
        { diff: true },
      );
      const tokenHashConflict = await fingerprint(
        `tok-c1-conflict-${Date.now()}`,
      );
      const reqHashConflict = await fingerprint({
        tool: planConflict.tool,
        params: planConflict.params,
      });
      await store2.savePreview(
        tokenHashConflict,
        reqHashConflict,
        planConflict,
        Date.now() + 60000,
      );

      let reservationBlocked = false;
      try {
        await store2.enqueue(
          tokenHashConflict,
          reqHashConflict,
          "idem-case1-conflict",
        );
      } catch (err: any) {
        if (err.code === "TARGET_RESERVED") {
          reservationBlocked = true;
        }
      }
      expect(reservationBlocked).to.be.true;
    } finally {
      if (manager2) {
        await manager2.shutdown().catch(() => undefined);
      } else if (store2) {
        await store2.close().catch(() => undefined);
      }
      if (store1) {
        await store1.close().catch(() => undefined);
      }
      await IOUtils.remove(dbFile).catch(() => undefined);
    }
  });

  it("在隔离真实Zotero条目已落库但ledger未checkpoint时关闭重开，通过只读reload对账标externally_satisfied，不冒认本任务成功", async function () {
    const dbFile = PathUtils.join(
      Zotero.DataDirectory.dir,
      `recovery-case2-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
    );

    let realItem: any = null;
    let store1: TaskStore | null = null;
    let store2: TaskStore | null = null;
    let manager2: TaskManager | null = null;

    try {
      // 1. 创建真实隔离 Zotero 条目
      realItem = new Zotero.Item("journalArticle");
      const baseTitle = `Real Item Before ${Date.now()}`;
      const updatedTitle = `Externally Updated ${Date.now()}`;
      realItem.setField("title", baseTitle);
      await realItem.saveTx();

      const itemKey = realItem.key;

      // 2. 在 ledger 1 中入队并进入 native_intent
      const l1 = openLedgerStore(dbFile);
      store1 = l1.store;
      await store1.initialize();

      const plan = createPlan(
        "test_tool_real",
        Zotero.Libraries.userLibraryID,
        itemKey,
        { title: updatedTitle },
      );
      const tokenHash = await fingerprint(`tok-c2-${Date.now()}`);
      const reqHash = await fingerprint({
        tool: plan.tool,
        params: plan.params,
      });
      await store1.savePreview(tokenHash, reqHash, plan, Date.now() + 60000);

      const { taskID } = await store1.enqueue(
        tokenHash,
        reqHash,
        "idem-case2-task",
      );
      const step = await store1.claim(taskID, "worker-case2");
      expect(step).to.not.be.null;

      await store1.beginNative(step!);

      // 3. 模拟条目已真实落库，但 ledger 未执行 finish 即崩溃关闭
      realItem.setField("title", updatedTitle);
      await realItem.saveTx();

      await store1.close();
      store1 = null;

      // 4. 重开 ledger 2 并通过 manager.recover() 进行对账
      const l2 = openLedgerStore(dbFile);
      store2 = l2.store;
      await store2.initialize();

      manager2 = new TaskManager(store2, () => true);

      let executeCalls = 0;
      let reconcileCalls = 0;

      const realAdapter: OperationAdapter = {
        tool: "test_tool_real",
        lane: "mutation",
        async prepare(params) {
          return createPlan(
            "test_tool_real",
            Zotero.Libraries.userLibraryID,
            itemKey,
            params,
          );
        },
        async check(_s: PlanStep) {},
        async execute(_s: PlanStep, _ctx: any): Promise<StepOutcome> {
          executeCalls++;
          return { state: "succeeded" };
        },
        async reconcile(s: PlanStep): Promise<StepOutcome> {
          reconcileCalls++;
          // 只读从 Zotero 库中 reload 条目
          const reloaded = await Zotero.Items.getByLibraryAndKeyAsync(
            Zotero.Libraries.userLibraryID,
            s.targets[0].key,
          );
          if (reloaded && reloaded.getField("title") === updatedTitle) {
            return {
              state: "externally_satisfied",
              result: { title: updatedTitle, reloaded: true },
            };
          }
          return { state: "needs_review" };
        },
      };

      manager2.register(realAdapter);
      await manager2.recover();

      expect(executeCalls).to.equal(0);
      expect(reconcileCalls).to.equal(1);

      // 断言：标记为 externally_satisfied，而非自身本次调用的 succeeded
      const steps = await store2.getSteps(taskID);
      expect(steps[0].state).to.equal("externally_satisfied");
      expect(steps[0].phase).to.equal("reconciled");

      const task = await store2.getTask(taskID);
      expect(task.state).to.equal("completed");
    } finally {
      if (realItem) {
        await realItem.eraseTx({ skipNotifier: true }).catch(() => undefined);
      }
      if (manager2) {
        await manager2.shutdown().catch(() => undefined);
      } else if (store2) {
        await store2.close().catch(() => undefined);
      }
      if (store1) {
        await store1.close().catch(() => undefined);
      }
      await IOUtils.remove(dbFile).catch(() => undefined);
    }
  });

  it("pending/cancel意图重开后不自动投递", async function () {
    const dbFile = PathUtils.join(
      Zotero.DataDirectory.dir,
      `recovery-case3-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
    );

    let store1: TaskStore | null = null;
    let store2: TaskStore | null = null;
    let manager2: TaskManager | null = null;

    try {
      // 1. 初始化并在会话 1 中创建任务 A（待执行 pending）与任务 B（已取消 cancel）
      const l1 = openLedgerStore(dbFile);
      store1 = l1.store;
      await store1.initialize();

      // 任务 A: 保持 pending 未 claim
      const planA = createPlan(
        "test_tool_dispatch",
        Zotero.Libraries.userLibraryID,
        "DISP_ITEM_A",
      );
      const tokenHashA = await fingerprint(`tok-c3-a-${Date.now()}`);
      const reqHashA = await fingerprint({
        tool: planA.tool,
        params: planA.params,
      });
      await store1.savePreview(tokenHashA, reqHashA, planA, Date.now() + 60000);
      const { taskID: taskIDA } = await store1.enqueue(
        tokenHashA,
        reqHashA,
        "idem-case3-taskA",
      );

      // 任务 B: 入队后取消
      const planB = createPlan(
        "test_tool_dispatch",
        Zotero.Libraries.userLibraryID,
        "DISP_ITEM_B",
      );
      const tokenHashB = await fingerprint(`tok-c3-b-${Date.now()}`);
      const reqHashB = await fingerprint({
        tool: planB.tool,
        params: planB.params,
      });
      await store1.savePreview(tokenHashB, reqHashB, planB, Date.now() + 60000);
      const { taskID: taskIDB } = await store1.enqueue(
        tokenHashB,
        reqHashB,
        "idem-case3-taskB",
      );
      await store1.stop(taskIDB, "cancel");

      // 关闭会话 1
      await store1.close();
      store1 = null;

      // 2. 会话 2 重启并执行 recover
      const l2 = openLedgerStore(dbFile);
      store2 = l2.store;
      await store2.initialize();

      manager2 = new TaskManager(store2, () => true);

      let executeCalls = 0;
      const dispatchAdapter: OperationAdapter = {
        tool: "test_tool_dispatch",
        lane: "mutation",
        async prepare(params) {
          return createPlan(
            "test_tool_dispatch",
            Zotero.Libraries.userLibraryID,
            "DISP_DEFAULT",
            params,
          );
        },
        async check(_s: PlanStep) {},
        async execute(_s: PlanStep, _ctx: any): Promise<StepOutcome> {
          executeCalls++;
          return { state: "succeeded" };
        },
        async reconcile(_s: PlanStep): Promise<StepOutcome> {
          return { state: "succeeded" };
        },
      };

      manager2.register(dispatchAdapter);
      await manager2.recover();

      // 断言：重启后所有未决运行任务全部转为 paused，不自动重新投递
      const taskA = await store2.getTask(taskIDA);
      expect(taskA.desiredState).to.equal("paused");
      expect(taskA.state).to.equal("paused");

      const stepsA = await store2.getSteps(taskIDA);
      expect(stepsA[0].state).to.equal("pending");

      // 断言：被取消的任务保持 cancel 意图
      const taskB = await store2.getTask(taskIDB);
      expect(taskB.desiredState).to.equal("cancelled");
      expect(taskB.state).to.equal("cancelled");

      const stepsB = await store2.getSteps(taskIDB);
      expect(stepsB[0].state).to.equal("cancelled");

      // 即使主动触发调度 kick，因任务处于 paused / cancelled，execute 计数依然为 0
      manager2.kick();
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(executeCalls).to.equal(0);
    } finally {
      if (manager2) {
        await manager2.shutdown().catch(() => undefined);
      } else if (store2) {
        await store2.close().catch(() => undefined);
      }
      if (store1) {
        await store1.close().catch(() => undefined);
      }
      await IOUtils.remove(dbFile).catch(() => undefined);
    }
  });
});
