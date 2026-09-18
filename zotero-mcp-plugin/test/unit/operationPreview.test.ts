import { expect } from "chai";
import { OperationPreview } from "../../src/modules/operationPreview.ts";
import { TaskStore } from "../../src/modules/taskStore.ts";
import {
  PlusError,
  fingerprint,
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

describe("OperationPreview unit tests", function () {
  let ledger: SqliteLedgerConnection;
  let store: TaskStore;
  let writeEnabled: boolean;
  let preview: OperationPreview;

  function createMockAdapter(
    opts: {
      tool?: string;
      lane?: "recognition" | "mutation" | "identifier";
      plan?: OperationPlan;
      executeSpy?: (step: PlanStep) => void;
    } = {},
  ): OperationAdapter {
    const tool = opts.tool ?? "test_tool";
    const lane = opts.lane ?? "mutation";
    return {
      tool,
      lane,
      async prepare(params: JsonObject): Promise<OperationPlan> {
        if (opts.plan) return opts.plan;
        return createTestPlan(
          tool,
          1,
          [
            createTestStep("step-1", [
              { libraryID: 1, key: "ITEM0001", kind: "item" },
            ]),
          ],
          params,
        );
      },
      async check(_step: PlanStep): Promise<void> {},
      async execute(step: PlanStep): Promise<StepOutcome> {
        opts.executeSpy?.(step);
        return { state: "succeeded", result: { executed: true } };
      },
      async reconcile(_step: PlanStep): Promise<StepOutcome> {
        return { state: "succeeded" };
      },
    };
  }

  beforeEach(async function () {
    ledger = createMemoryLedger();
    store = new TaskStore(ledger);
    await store.initialize();
    writeEnabled = true;
    preview = new OperationPreview(store, () => writeEnabled);
  });

  afterEach(async function () {
    if (store.isHealthy()) {
      await store.close();
    }
  });

  describe("Dry-run preview execution", function () {
    it("dry-run generates confirmation token and does NOT execute or enqueue task", async function () {
      let executeCalled = false;
      const adapter = createMockAdapter({
        executeSpy: () => {
          executeCalled = true;
        },
      });

      const res = await preview.dispatch(adapter, {
        dryRun: true,
        targetKey: "ITEM0001",
      });

      expect(res.success).to.be.true;
      expect(res.dryRun).to.be.true;
      expect(res.confirmationToken)
        .to.be.a("string")
        .that.matches(/^confirm-/);
      expect(res.requiresUserConfirmation).to.be.true;
      expect(res.writeEnabled).to.be.true;
      expect(res.total).to.equal(1);
      expect(res.eligible).to.equal(1);
      expect(executeCalled).to.be.false;

      // Ensure no task was enqueued into tasks table
      const tasksCount = await ledger.valueQueryAsync(
        "SELECT COUNT(*) FROM tasks",
      );
      expect(Number(tasksCount)).to.equal(0);
    });

    it("allows dry-run preview even when write is disabled (canWrite = false)", async function () {
      writeEnabled = false;
      const adapter = createMockAdapter();

      const res = await preview.dispatch(adapter, { dryRun: true });
      expect(res.success).to.be.true;
      expect(res.dryRun).to.be.true;
      expect(res.writeEnabled).to.be.false;
      expect(res.confirmationToken).to.be.a("string");
    });

    it("defaults to dry-run when dryRun argument is omitted", async function () {
      const adapter = createMockAdapter();
      const res = await preview.dispatch(adapter, { someArg: "val" });
      expect(res.dryRun).to.be.true;
      expect(res.confirmationToken).to.be.a("string");
    });
  });

  describe("Lost response replay and idempotency", function () {
    it("replays existing task if response was lost after commit (replayed: true)", async function () {
      const adapter = createMockAdapter();
      const dryRes = await preview.dispatch(adapter, {
        dryRun: true,
        arg: "lost-ack",
      });
      const token = dryRes.confirmationToken;

      const firstRes = await preview.dispatch(adapter, {
        dryRun: false,
        confirmationToken: token,
        idempotencyKey: "idem-lost-ack",
        arg: "lost-ack",
      });
      expect(firstRes.success).to.be.true;
      expect(firstRes.replayed).to.be.false;
      expect(firstRes.taskID).to.be.a("string");

      // Client retries exact same request (simulating lost response)
      const secondRes = await preview.dispatch(adapter, {
        dryRun: false,
        confirmationToken: token,
        idempotencyKey: "idem-lost-ack",
        arg: "lost-ack",
      });
      expect(secondRes.success).to.be.true;
      expect(secondRes.replayed).to.be.true;
      expect(secondRes.taskID).to.equal(firstRes.taskID);
    });

    it("allows replaying committed task even when confirmation token expired", async function () {
      const adapter = createMockAdapter();
      const dryRes = await preview.dispatch(adapter, {
        dryRun: true,
        test: "expire-replay",
      });
      const token = dryRes.confirmationToken;

      const firstRes = await preview.dispatch(adapter, {
        dryRun: false,
        confirmationToken: token,
        idempotencyKey: "idem-expired-replay",
        test: "expire-replay",
      });
      expect(firstRes.replayed).to.be.false;

      // Expire all confirmation tokens in database
      await ledger.queryAsync("UPDATE confirmations SET expiresAt = 0");

      // Replay must still succeed because task is already committed
      const secondRes = await preview.dispatch(adapter, {
        dryRun: false,
        confirmationToken: token,
        idempotencyKey: "idem-expired-replay",
        test: "expire-replay",
      });
      expect(secondRes.success).to.be.true;
      expect(secondRes.replayed).to.be.true;
      expect(secondRes.taskID).to.equal(firstRes.taskID);
    });

    it("allows replaying committed task even when write is disabled (canWrite = false)", async function () {
      const adapter = createMockAdapter();
      const dryRes = await preview.dispatch(adapter, {
        dryRun: true,
        test: "ro-replay",
      });
      const token = dryRes.confirmationToken;

      const firstRes = await preview.dispatch(adapter, {
        dryRun: false,
        confirmationToken: token,
        idempotencyKey: "idem-ro-replay",
        test: "ro-replay",
      });
      expect(firstRes.replayed).to.be.false;

      // Disable write
      writeEnabled = false;

      // Replay of existing committed task must succeed in read-only mode
      const secondRes = await preview.dispatch(adapter, {
        dryRun: false,
        confirmationToken: token,
        idempotencyKey: "idem-ro-replay",
        test: "ro-replay",
      });
      expect(secondRes.success).to.be.true;
      expect(secondRes.replayed).to.be.true;
      expect(secondRes.taskID).to.equal(firstRes.taskID);
    });

    it("rejects non-committed request when write is disabled (WRITE_DISABLED)", async function () {
      writeEnabled = false;
      const adapter = createMockAdapter();

      let caught: any = null;
      try {
        await preview.dispatch(adapter, {
          dryRun: false,
          confirmationToken: "any-token",
          idempotencyKey: "idem-uncommitted",
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).to.be.instanceOf(PlusError);
      expect(caught.code).to.equal("WRITE_DISABLED");
    });

    it("rejects non-committed request when token has expired (CONFIRMATION_EXPIRED)", async function () {
      const adapter = createMockAdapter();
      const dryRes = await preview.dispatch(adapter, {
        dryRun: true,
        param: "exp-check",
      });
      const token = dryRes.confirmationToken;

      // Manually expire token before enqueue
      await ledger.queryAsync(
        "UPDATE confirmations SET expiresAt = 0 WHERE consumedBy IS NULL",
      );

      let caught: any = null;
      try {
        await preview.dispatch(adapter, {
          dryRun: false,
          confirmationToken: token,
          idempotencyKey: "idem-exp-check",
          param: "exp-check",
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).to.be.instanceOf(PlusError);
      expect(caught.code).to.equal("CONFIRMATION_EXPIRED");
    });

    it("rejects same idempotencyKey with different parameters (IDEMPOTENCY_CONFLICT)", async function () {
      const adapter = createMockAdapter();
      const dryRes = await preview.dispatch(adapter, {
        dryRun: true,
        param: "param-1",
      });
      const token = dryRes.confirmationToken;

      await preview.dispatch(adapter, {
        dryRun: false,
        confirmationToken: token,
        idempotencyKey: "idem-conflict-key",
        param: "param-1",
      });

      // Different param with the same idempotency key
      let caught: any = null;
      try {
        await preview.dispatch(adapter, {
          dryRun: false,
          confirmationToken: token,
          idempotencyKey: "idem-conflict-key",
          param: "param-2",
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).to.be.instanceOf(PlusError);
      expect(caught.code).to.equal("IDEMPOTENCY_CONFLICT");
    });

    it("handles concurrent preview dispatch calls for same idempotency key gracefully", async function () {
      const adapter = createMockAdapter();
      const dryRes = await preview.dispatch(adapter, {
        dryRun: true,
        param: "concurrent-disp",
      });
      const token = dryRes.confirmationToken;

      const [res1, res2] = await Promise.all([
        preview.dispatch(adapter, {
          dryRun: false,
          confirmationToken: token,
          idempotencyKey: "idem-conc-disp",
          param: "concurrent-disp",
        }),
        preview.dispatch(adapter, {
          dryRun: false,
          confirmationToken: token,
          idempotencyKey: "idem-conc-disp",
          param: "concurrent-disp",
        }),
      ]);

      expect(res1.taskID).to.equal(res2.taskID);
      // Exactly one must be replayed: false, and the other must be replayed: true
      expect([res1.replayed, res2.replayed].sort()).to.deep.equal([
        false,
        true,
      ]);

      // Subsequent call must see existing request and report replayed: true
      const res3 = await preview.dispatch(adapter, {
        dryRun: false,
        confirmationToken: token,
        idempotencyKey: "idem-conc-disp",
        param: "concurrent-disp",
      });
      expect(res3.taskID).to.equal(res1.taskID);
      expect(res3.replayed).to.be.true;
    });
  });

  describe("Validation of input arguments and confirmation tokens", function () {
    it("rejects non-boolean dryRun (INVALID_ARGUMENT)", async function () {
      const adapter = createMockAdapter();

      let caught: any = null;
      try {
        await preview.dispatch(adapter, { dryRun: "false" as any });
      } catch (err) {
        caught = err;
      }
      expect(caught).to.be.instanceOf(PlusError);
      expect(caught.code).to.equal("INVALID_ARGUMENT");
      expect(caught.message).to.include("dryRun 必须是布尔值");
    });

    it("rejects missing confirmationToken on non-dry-run (CONFIRMATION_REQUIRED)", async function () {
      const adapter = createMockAdapter();

      let caught: any = null;
      try {
        await preview.dispatch(adapter, {
          dryRun: false,
          idempotencyKey: "valid-key-123",
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).to.be.instanceOf(PlusError);
      expect(caught.code).to.equal("CONFIRMATION_REQUIRED");
    });

    it("rejects invalid idempotencyKey format (INVALID_ARGUMENT)", async function () {
      const adapter = createMockAdapter();

      // Empty string
      let caughtEmpty: any = null;
      try {
        await preview.dispatch(adapter, {
          dryRun: false,
          idempotencyKey: "",
          confirmationToken: "token-abc",
        });
      } catch (err) {
        caughtEmpty = err;
      }
      expect(caughtEmpty).to.be.instanceOf(PlusError);
      expect(caughtEmpty.code).to.equal("INVALID_ARGUMENT");

      // Too long (>128 chars)
      let caughtLong: any = null;
      try {
        await preview.dispatch(adapter, {
          dryRun: false,
          idempotencyKey: "a".repeat(129),
          confirmationToken: "token-abc",
        });
      } catch (err) {
        caughtLong = err;
      }
      expect(caughtLong).to.be.instanceOf(PlusError);
      expect(caughtLong.code).to.equal("INVALID_ARGUMENT");

      // Disallowed characters (e.g. space, semicolons)
      let caughtBadChar: any = null;
      try {
        await preview.dispatch(adapter, {
          dryRun: false,
          idempotencyKey: "bad key with spaces",
          confirmationToken: "token-abc",
        });
      } catch (err) {
        caughtBadChar = err;
      }
      expect(caughtBadChar).to.be.instanceOf(PlusError);
      expect(caughtBadChar.code).to.equal("INVALID_ARGUMENT");
    });

    it("rejects plan with schemaVersion !== 1 or tool mismatch (INVALID_PLAN)", async function () {
      const badPlanAdapter: OperationAdapter = {
        tool: "tool_a",
        lane: "mutation",
        async prepare(): Promise<OperationPlan> {
          return {
            schemaVersion: 2 as any, // Unsupported version
            tool: "tool_a",
            libraryID: 1,
            params: {},
            steps: [],
            warnings: [],
          };
        },
        async check(): Promise<void> {},
        async execute(): Promise<StepOutcome> {
          return { state: "succeeded" };
        },
        async reconcile(): Promise<StepOutcome> {
          return { state: "succeeded" };
        },
      };

      let caught: any = null;
      try {
        await preview.dispatch(badPlanAdapter, { dryRun: true });
      } catch (err) {
        caught = err;
      }
      expect(caught).to.be.instanceOf(PlusError);
      expect(caught.code).to.equal("INVALID_PLAN");
    });
  });
});
