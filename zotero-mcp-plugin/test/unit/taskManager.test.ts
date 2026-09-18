import { expect } from "chai";
import { TaskManager } from "../../src/modules/taskManager.ts";
import { TaskStore } from "../../src/modules/taskStore.ts";
import {
  PlusError,
  fingerprint,
  type ExecutionContext,
  type JsonObject,
  type OperationAdapter,
  type OperationPlan,
  type PlanStep,
  type StepOutcome,
} from "../../src/modules/plusTypes.ts";
import {
  createMemoryLedger,
  createTestPlan,
  createTestStep,
  SqliteLedgerConnection,
} from "./ledgerFixture.ts";

describe("TaskManager unit tests", function () {
  let ledger: SqliteLedgerConnection;
  let store: TaskStore;
  let manager: TaskManager;
  let writeEnabled: boolean;

  before(function () {
    (globalThis as any).ztoolkit = { log: () => undefined };
  });

  after(function () {
    delete (globalThis as any).ztoolkit;
  });

  beforeEach(async function () {
    ledger = createMemoryLedger();
    store = new TaskStore(ledger);
    await store.initialize();
    writeEnabled = true;
    manager = new TaskManager(store, () => writeEnabled);
  });

  afterEach(async function () {
    try {
      await manager.shutdown();
    } catch {
      // Ignore shutdown errors if already closed
    }
  });

  function createTestAdapter(opts: {
    tool: string;
    lane: "recognition" | "mutation" | "identifier";
    executeFn?: (
      step: PlanStep,
      context: ExecutionContext,
    ) => Promise<StepOutcome>;
    reconcileFn?: (step: PlanStep) => Promise<StepOutcome>;
    checkFn?: (step: PlanStep) => Promise<void>;
  }): OperationAdapter {
    return {
      tool: opts.tool,
      lane: opts.lane,
      async prepare(params: JsonObject): Promise<OperationPlan> {
        return createTestPlan(
          opts.tool,
          1,
          [
            createTestStep(`step-${opts.tool}`, [
              {
                libraryID: 1,
                key: `KEY_${opts.tool.toUpperCase()}`,
                kind: "item",
              },
            ]),
          ],
          params,
        );
      },
      async check(step: PlanStep): Promise<void> {
        if (opts.checkFn) await opts.checkFn(step);
      },
      async execute(
        step: PlanStep,
        context: ExecutionContext,
      ): Promise<StepOutcome> {
        if (opts.executeFn) return opts.executeFn(step, context);
        return { state: "succeeded", result: { tool: opts.tool } };
      },
      async reconcile(step: PlanStep): Promise<StepOutcome> {
        if (opts.reconcileFn) return opts.reconcileFn(step);
        return { state: "succeeded", result: { reconciled: true } };
      },
    };
  }

  async function enqueueTask(
    tool: string,
    params: JsonObject = {},
    targets = [
      { libraryID: 1, key: `KEY_${Date.now()}`, kind: "item" as const },
    ],
  ): Promise<string> {
    const plan = createTestPlan(
      tool,
      1,
      [createTestStep(`step-${Date.now()}`, targets)],
      params,
    );
    const token = `tok-${Date.now()}-${Math.random()}`;
    const tokenHash = await fingerprint(token);
    const reqHash = await fingerprint({ tool, params });
    await store.savePreview(tokenHash, reqHash, plan, Date.now() + 60000);
    const res = await store.enqueue(tokenHash, reqHash, `idem-${token}`);
    return res.taskID;
  }

  describe("Multi-lane concurrency", function () {
    it("different lane recognition suspension does NOT block mutation", async function () {
      let resolveRecognitionGate!: () => void;
      const recognitionGate = new Promise<void>((resolve) => {
        resolveRecognitionGate = resolve;
      });

      let recognitionStarted = false;
      let recognitionCompleted = false;
      let mutationCompleted = false;

      const recognitionAdapter = createTestAdapter({
        tool: "recognize_pdfs",
        lane: "recognition",
        executeFn: async () => {
          recognitionStarted = true;
          // Suspend / wait on gate
          await recognitionGate;
          recognitionCompleted = true;
          return { state: "succeeded", result: { rec: true } };
        },
      });

      const mutationAdapter = createTestAdapter({
        tool: "write_metadata",
        lane: "mutation",
        executeFn: async () => {
          mutationCompleted = true;
          return { state: "succeeded", result: { mut: true } };
        },
      });

      manager.register(recognitionAdapter);
      manager.register(mutationAdapter);

      // Enqueue recognition task
      const recTaskID = await enqueueTask("recognize_pdfs", { action: "rec" }, [
        { libraryID: 1, key: "RECOG001", kind: "item" },
      ]);
      // Enqueue mutation task
      const mutTaskID = await enqueueTask("write_metadata", { action: "mut" }, [
        { libraryID: 1, key: "MUTAT001", kind: "item" },
      ]);

      // Kick manager: both tasks ready in different lanes
      manager.kick();

      // Wait a short tick for execution to start
      for (let i = 0; i < 20; i++) {
        if (recognitionStarted && mutationCompleted) break;
        await new Promise((r) => setTimeout(r, 10));
      }

      // Recognition must have started and be suspended
      expect(recognitionStarted).to.be.true;
      expect(recognitionCompleted).to.be.false;

      // Mutation MUST have completed without being blocked by suspended recognition!
      expect(mutationCompleted).to.be.true;

      const mutTask = await store.getTask(mutTaskID);
      expect(mutTask.state).to.equal("completed");

      // Now release the recognition gate
      resolveRecognitionGate();

      for (let i = 0; i < 20; i++) {
        if (recognitionCompleted) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(recognitionCompleted).to.be.true;
      const recTask = await store.getTask(recTaskID);
      expect(recTask.state).to.equal("completed");
    });
  });

  describe("Crash recovery safety (native_intent does not auto rerun)", function () {
    it("recovery invokes reconcile and NEVER re-runs execute on native_intent steps", async function () {
      let executeCalls = 0;
      let reconcileCalls = 0;

      const adapter = createTestAdapter({
        tool: "test_recovery_tool",
        lane: "mutation",
        executeFn: async () => {
          executeCalls++;
          return { state: "succeeded" };
        },
        reconcileFn: async () => {
          reconcileCalls++;
          return {
            state: "externally_satisfied",
            result: { reconciled: true },
          };
        },
      });

      manager.register(adapter);

      // Enqueue task and manually advance it to native_intent
      const taskID = await enqueueTask("test_recovery_tool");
      const step = await store.claim(taskID, "old-worker");
      expect(step).to.not.be.null;
      await store.beginNative(step!);

      // Run manager recovery
      await manager.recover();

      // Reconcile must have been called, but execute MUST NEVER be called during recovery!
      expect(reconcileCalls).to.equal(1);
      expect(executeCalls).to.equal(0);

      const task = await store.getTask(taskID);
      expect(task.state).to.equal("completed");
      const steps = await store.getSteps(taskID);
      expect(steps[0].state).to.equal("externally_satisfied");
      expect(steps[0].phase).to.equal("reconciled");
    });

    it("marks step as needs_review if reconciliation fails or throws error", async function () {
      const adapter = createTestAdapter({
        tool: "test_reconcile_fail",
        lane: "mutation",
        reconcileFn: async () => {
          throw new Error("Cannot verify remote status");
        },
      });

      manager.register(adapter);

      const taskID = await enqueueTask("test_reconcile_fail");
      const step = await store.claim(taskID, "old-worker");
      await store.beginNative(step!);

      await manager.recover();

      const task = await store.getTask(taskID);
      expect(task.state).to.equal("needs_review");
      const steps = await store.getSteps(taskID);
      expect(steps[0].state).to.equal("needs_review");
      expect(steps[0].outcome?.error?.code).to.equal("RECOVERY_UNCERTAIN");
    });
  });

  describe("Stale attempt / closed manager callback guard", function () {
    it("update() rejects with STALE_ATTEMPT after manager is closed", async function () {
      let capturedContext!: ExecutionContext;
      let resolveExecute!: () => void;
      const executeGate = new Promise<void>((resolve) => {
        resolveExecute = resolve;
      });

      const adapter = createTestAdapter({
        tool: "test_closed_tool",
        lane: "mutation",
        executeFn: async (_step, context) => {
          capturedContext = context;
          await executeGate;
          return { state: "succeeded" };
        },
      });

      manager.register(adapter);
      await enqueueTask("test_closed_tool");
      manager.kick();

      // Wait until context is captured
      for (let i = 0; i < 20; i++) {
        if (capturedContext) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(capturedContext).to.exist;

      // Shutdown manager while task is running
      resolveExecute();
      await manager.shutdown();

      // Attempting to call update() on closed manager must throw STALE_ATTEMPT
      let caught: any = null;
      try {
        await capturedContext.update("running");
      } catch (err) {
        caught = err;
      }
      expect(caught).to.be.instanceOf(PlusError);
      expect(caught.code).to.equal("STALE_ATTEMPT");
    });
  });

  describe("Suspend and security generation", function () {
    it("suspend pauses active tasks and invalidates confirmations if requested", async function () {
      const adapter = createTestAdapter({
        tool: "test_suspend_tool",
        lane: "mutation",
      });
      manager.register(adapter);

      const taskID = await enqueueTask("test_suspend_tool");
      expect((await store.getTask(taskID)).state).to.equal("queued");

      await manager.suspend("security_check", true);

      const taskAfter = await store.getTask(taskID);
      expect(taskAfter.desiredState).to.equal("paused");
      expect(taskAfter.state).to.equal("paused");
    });
  });

  describe("task_control adapter", function () {
    let controlAdapter: OperationAdapter;

    beforeEach(function () {
      controlAdapter = manager.controlAdapter();
      manager.register(controlAdapter);
    });

    it("prepares resume plan for paused task and resumes execution", async function () {
      const workAdapter = createTestAdapter({
        tool: "test_work_tool",
        lane: "mutation",
      });
      manager.register(workAdapter);

      const taskID = await enqueueTask("test_work_tool");
      await manager.stop(taskID, "pause");

      const plan = await controlAdapter.prepare({
        action: "resume",
        taskID,
      });

      expect(plan.tool).to.equal("task_control");
      expect(plan.steps).to.have.lengthOf(1);

      await controlAdapter.check(plan.steps[0]);
      const outcome = await controlAdapter.execute(plan.steps[0], {} as any);
      expect(outcome.state).to.equal("succeeded");

      const taskAfter = await store.getTask(taskID);
      expect(taskAfter.desiredState).to.equal("running");
    });

    it("rejects resume on cancelled task (TASK_CANCELLED)", async function () {
      const workAdapter = createTestAdapter({
        tool: "test_cancel_ctrl",
        lane: "mutation",
      });
      manager.register(workAdapter);

      const taskID = await enqueueTask("test_cancel_ctrl");
      await manager.stop(taskID, "cancel");

      let caught: any = null;
      try {
        await controlAdapter.prepare({ action: "resume", taskID });
      } catch (err) {
        caught = err;
      }
      expect(caught).to.be.instanceOf(PlusError);
      expect(caught.code).to.equal("TASK_CANCELLED");
    });

    it("rejects resume if task has steps in needs_review (TASK_NEEDS_REVIEW)", async function () {
      const workAdapter = createTestAdapter({
        tool: "test_review_ctrl",
        lane: "mutation",
      });
      manager.register(workAdapter);

      const taskID = await enqueueTask("test_review_ctrl");
      const step = await store.claim(taskID, "worker-1");
      await store.beginNative(step!);
      await store.finish(step!, { state: "needs_review" });

      let caught: any = null;
      try {
        await controlAdapter.prepare({ action: "resume", taskID });
      } catch (err) {
        caught = err;
      }
      expect(caught).to.be.instanceOf(PlusError);
      expect(caught.code).to.equal("TASK_NEEDS_REVIEW");
    });

    it("rejects when state snapshot changed between prepare and check (STATE_CHANGED)", async function () {
      const workAdapter = createTestAdapter({
        tool: "test_race_ctrl",
        lane: "mutation",
      });
      manager.register(workAdapter);

      const taskID = await enqueueTask("test_race_ctrl");
      await manager.stop(taskID, "pause");

      const plan = await controlAdapter.prepare({
        action: "resume",
        taskID,
      });

      // Modify state after prepare: cancel the task
      await manager.stop(taskID, "cancel");

      let caught: any = null;
      try {
        await controlAdapter.check(plan.steps[0]);
      } catch (err) {
        caught = err;
      }
      expect(caught).to.be.instanceOf(PlusError);
      expect(caught.code).to.equal("STATE_CHANGED");
    });
  });

  describe("Status reporting and stop operations", function () {
    it("returns formatted status with counts and inFlightNotInterruptible", async function () {
      const workAdapter = createTestAdapter({
        tool: "test_status_tool",
        lane: "mutation",
      });
      manager.register(workAdapter);

      const taskID = await enqueueTask("test_status_tool");
      const st = await manager.status(taskID);

      expect(st.taskID).to.equal(taskID);
      expect(st.counts).to.have.property("pending", 1);
      expect(st.inFlightNotInterruptible).to.equal(0);
      expect(st.items).to.have.lengthOf(1);
      expect(st.complete).to.be.true;
    });

    it("stop allows pausing and cancelling tasks via manager", async function () {
      const workAdapter = createTestAdapter({
        tool: "test_mgr_stop",
        lane: "mutation",
      });
      manager.register(workAdapter);

      const taskID = await enqueueTask("test_mgr_stop");
      const pausedStatus = await manager.stop(taskID, "pause");
      expect(pausedStatus.state).to.equal("paused");

      const cancelledStatus = await manager.stop(taskID, "cancel");
      expect(cancelledStatus.state).to.equal("cancelled");
    });
  });
});
