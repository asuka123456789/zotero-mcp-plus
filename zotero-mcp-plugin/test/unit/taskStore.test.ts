import { expect } from "chai";
import { TaskStore, type StepRecord } from "../../src/modules/taskStore.ts";
import {
  PlusError,
  fingerprint,
  type OperationPlan,
  type StepOutcome,
} from "../../src/modules/plusTypes.ts";
import {
  createMemoryLedger,
  createTestPlan,
  createTestStep,
  createMozStorageRowProxy,
  SqliteLedgerConnection,
} from "./ledgerFixture.ts";
import { DatabaseSync } from "node:sqlite";

describe("TaskStore unit tests", function () {
  let ledger: SqliteLedgerConnection;
  let store: TaskStore;

  beforeEach(async function () {
    ledger = createMemoryLedger();
    store = new TaskStore(ledger);
    await store.initialize();
  });

  afterEach(async function () {
    if (store.isHealthy()) {
      await store.close();
    }
  });

  describe("Ledger version check and corruption handling", function () {
    it("rejects higher ledger version (LEDGER_VERSION_UNSUPPORTED)", async function () {
      const db = new DatabaseSync(":memory:");
      db.exec("PRAGMA user_version = 2");
      const badLedger = new SqliteLedgerConnection(db);
      const badStore = new TaskStore(badLedger);

      let caught: any = null;
      try {
        await badStore.initialize();
      } catch (err) {
        caught = err;
      }
      expect(caught).to.be.instanceOf(PlusError);
      expect(caught.code).to.equal("LEDGER_VERSION_UNSUPPORTED");
      expect(badStore.isHealthy()).to.be.false;
      await badLedger.closeDatabase();
    });

    it("rejects corrupt database when quick_check fails (LEDGER_CORRUPT)", async function () {
      const db = new DatabaseSync(":memory:");
      // Override valueQueryAsync to simulate failed quick_check
      const badLedger = new SqliteLedgerConnection(db);
      const originalValueQuery = badLedger.valueQueryAsync.bind(badLedger);
      badLedger.valueQueryAsync = async (sql: string, params: any[] = []) => {
        if (sql.includes("PRAGMA quick_check")) {
          return "corrupt data found";
        }
        return originalValueQuery(sql, params);
      };

      const badStore = new TaskStore(badLedger);
      let caught: any = null;
      try {
        await badStore.initialize();
      } catch (err) {
        caught = err;
      }
      expect(caught).to.be.instanceOf(PlusError);
      expect(caught.code).to.equal("LEDGER_CORRUPT");
      expect(badStore.isHealthy()).to.be.false;
      await badLedger.closeDatabase();
    });

    it("marks store unhealthy after fatal database error and rejects subsequent writes", async function () {
      // Simulate fatal I/O failure during executeTransaction
      const originalExec = ledger.executeTransaction.bind(ledger);
      ledger.executeTransaction = async () => {
        throw new Error("Disk I/O error");
      };

      let caught: any = null;
      try {
        await store.getTask("non-existent");
      } catch (err) {
        caught = err;
      }
      expect(caught).to.be.instanceOf(Error);
      expect(store.isHealthy()).to.be.false;

      // Next call must fail with LEDGER_UNAVAILABLE
      let nextError: any = null;
      try {
        await store.getTask("another-task");
      } catch (err) {
        nextError = err;
      }
      expect(nextError).to.be.instanceOf(PlusError);
      expect(nextError.code).to.equal("LEDGER_UNAVAILABLE");
    });
  });

  describe("Token lifecycle and reservation", function () {
    it("enqueues task with valid confirmation and consumes token", async function () {
      const plan = createTestPlan("recognize_pdfs", 1, [
        createTestStep("step-1", [
          { libraryID: 1, key: "ITEM0001", kind: "item" },
        ]),
      ]);
      const token = "confirm-token-1";
      const tokenHash = await fingerprint(token);
      const requestHash = await fingerprint({
        tool: plan.tool,
        params: plan.params,
      });
      const expiresAt = Date.now() + 60000;

      await store.savePreview(tokenHash, requestHash, plan, expiresAt);

      const { taskID, replayed } = await store.enqueue(
        tokenHash,
        requestHash,
        "idempotency-key-1",
      );
      expect(replayed).to.be.false;
      expect(taskID)
        .to.be.a("string")
        .that.matches(/^task-/);

      const task = await store.getTask(taskID);
      expect(task.state).to.equal("queued");
      expect(task.desiredState).to.equal("running");

      const steps = await store.getSteps(taskID);
      expect(steps).to.have.lengthOf(1);
      expect(steps[0].state).to.equal("pending");
      expect(steps[0].phase).to.equal("not_submitted");
    });

    it("rejects enqueue when confirmation token is expired (CONFIRMATION_EXPIRED)", async function () {
      const plan = createTestPlan();
      const tokenHash = await fingerprint("expired-token");
      const requestHash = await fingerprint({
        tool: plan.tool,
        params: plan.params,
      });
      const expiresAt = Date.now() - 1000; // expired

      await store.savePreview(tokenHash, requestHash, plan, expiresAt);

      let caught: any = null;
      try {
        await store.enqueue(tokenHash, requestHash, "key-expired");
      } catch (err) {
        caught = err;
      }
      expect(caught).to.be.instanceOf(PlusError);
      expect(caught.code).to.equal("CONFIRMATION_EXPIRED");
    });

    it("rejects reusing consumed confirmation token with different idempotency key (CONFIRMATION_USED)", async function () {
      const plan = createTestPlan();
      const tokenHash = await fingerprint("token-reuse");
      const requestHash = await fingerprint({
        tool: plan.tool,
        params: plan.params,
      });
      const expiresAt = Date.now() + 60000;

      await store.savePreview(tokenHash, requestHash, plan, expiresAt);
      await store.enqueue(tokenHash, requestHash, "key-first");

      let caught: any = null;
      try {
        await store.enqueue(tokenHash, requestHash, "key-second");
      } catch (err) {
        caught = err;
      }
      expect(caught).to.be.instanceOf(PlusError);
      expect(caught.code).to.equal("CONFIRMATION_USED");
    });

    it("enforces target reservation and releases it only after steps settle", async function () {
      const targetRef = {
        libraryID: 1,
        key: "ITEM0001",
        kind: "item" as const,
      };
      const plan1 = createTestPlan("recognize_pdfs", 1, [
        createTestStep("step-1", [targetRef]),
      ]);
      const tokenHash1 = await fingerprint("token-res-1");
      const reqHash1 = await fingerprint({
        tool: plan1.tool,
        params: plan1.params,
      });
      await store.savePreview(tokenHash1, reqHash1, plan1, Date.now() + 60000);
      const { taskID: taskID1 } = await store.enqueue(
        tokenHash1,
        reqHash1,
        "idem-res-1",
      );

      // Attempting to enqueue task 2 on the same target must fail with TARGET_RESERVED
      const plan2 = createTestPlan("recognize_pdfs", 1, [
        createTestStep("step-2", [targetRef]),
      ]);
      const tokenHash2 = await fingerprint("token-res-2");
      const reqHash2 = await fingerprint({
        tool: plan2.tool,
        params: plan2.params,
      });
      await store.savePreview(tokenHash2, reqHash2, plan2, Date.now() + 60000);

      let caught: any = null;
      try {
        await store.enqueue(tokenHash2, reqHash2, "idem-res-2");
      } catch (err) {
        caught = err;
      }
      expect(caught).to.be.instanceOf(PlusError);
      expect(caught.code).to.equal("TARGET_RESERVED");
      expect(caught.details?.taskID).to.equal(taskID1);

      // Claim and settle task 1's step
      const step = await store.claim(taskID1, "worker-1");
      expect(step).to.not.be.null;
      await store.beginNative(step!);
      await store.finish(step!, { state: "succeeded", result: { ok: true } });

      // After task 1 settles, reservation is released; task 2 can now be enqueued
      const { taskID: taskID2 } = await store.enqueue(
        tokenHash2,
        reqHash2,
        "idem-res-2",
      );
      expect(taskID2)
        .to.be.a("string")
        .that.matches(/^task-/);
      expect(taskID2).to.not.equal(taskID1);
    });

    it("retains target reservation when step finishes with needs_review", async function () {
      const targetRef = {
        libraryID: 1,
        key: "ITEM0002",
        kind: "item" as const,
      };
      const plan1 = createTestPlan("recognize_pdfs", 1, [
        createTestStep("step-review", [targetRef]),
      ]);
      const tokenHash1 = await fingerprint("token-rev-1");
      const reqHash1 = await fingerprint({
        tool: plan1.tool,
        params: plan1.params,
      });
      await store.savePreview(tokenHash1, reqHash1, plan1, Date.now() + 60000);
      const { taskID: taskID1 } = await store.enqueue(
        tokenHash1,
        reqHash1,
        "idem-rev-1",
      );

      const step = await store.claim(taskID1, "worker-1");
      await store.beginNative(step!);
      // Finish with needs_review
      await store.finish(step!, {
        state: "needs_review",
        error: { code: "UNCERTAIN", message: "Needs manual review" },
      });

      // Target reservation must still be retained
      const plan2 = createTestPlan("recognize_pdfs", 1, [
        createTestStep("step-other", [targetRef]),
      ]);
      const tokenHash2 = await fingerprint("token-rev-2");
      const reqHash2 = await fingerprint({
        tool: plan2.tool,
        params: plan2.params,
      });
      await store.savePreview(tokenHash2, reqHash2, plan2, Date.now() + 60000);

      let caught: any = null;
      try {
        await store.enqueue(tokenHash2, reqHash2, "idem-rev-2");
      } catch (err) {
        caught = err;
      }
      expect(caught).to.be.instanceOf(PlusError);
      expect(caught.code).to.equal("TARGET_RESERVED");
      expect(caught.details?.taskID).to.equal(taskID1);
    });
  });

  describe("Idempotency concurrency and conflict", function () {
    it("handles concurrent enqueue calls with same idempotency key and returns identical taskID", async function () {
      const plan = createTestPlan("recognize_pdfs", 1, [
        createTestStep("step-idem", [
          { libraryID: 1, key: "ITEM0003", kind: "item" },
        ]),
      ]);
      const tokenHash = await fingerprint("token-concurrent");
      const requestHash = await fingerprint({
        tool: plan.tool,
        params: plan.params,
      });
      await store.savePreview(tokenHash, requestHash, plan, Date.now() + 60000);

      const idemKey = "concurrent-idempotency-key";
      // Execute two enqueues concurrently
      const [res1, res2] = await Promise.all([
        store.enqueue(tokenHash, requestHash, idemKey),
        store.enqueue(tokenHash, requestHash, idemKey),
      ]);

      expect(res1.taskID).to.equal(res2.taskID);
      // Exactly one must be replayed: false, and the other must be replayed: true
      expect([res1.replayed, res2.replayed].sort()).to.deep.equal([
        false,
        true,
      ]);
      // Ensure only one task was recorded in database
      const rows = await ledger.queryAsync(
        "SELECT COUNT(*) AS c FROM tasks WHERE id = ?",
        [res1.taskID],
      );
      expect(Number(rows[0].c)).to.equal(1);
    });

    it("rejects same idempotency key used with different request hash (IDEMPOTENCY_CONFLICT)", async function () {
      const plan1 = createTestPlan("recognize_pdfs", 1, [
        createTestStep("step-a", [
          { libraryID: 1, key: "ITEM0004", kind: "item" },
        ]),
      ]);
      const tokenHash1 = await fingerprint("token-diff-1");
      const reqHash1 = await fingerprint({
        tool: plan1.tool,
        params: { a: 1 },
      });
      await store.savePreview(tokenHash1, reqHash1, plan1, Date.now() + 60000);
      await store.enqueue(tokenHash1, reqHash1, "same-idem-key");

      // Second request with different params using the same idempotency key
      const reqHash2 = await fingerprint({
        tool: plan1.tool,
        params: { a: 2 },
      });
      let caught: any = null;
      try {
        await store.existingRequest("same-idem-key", reqHash2);
      } catch (err) {
        caught = err;
      }
      expect(caught).to.be.instanceOf(PlusError);
      expect(caught.code).to.equal("IDEMPOTENCY_CONFLICT");
    });
  });

  describe("pause/cancel race conditions with claim and beginNative", function () {
    it("race: beginNative returns false and resets step to pending when task is paused during validating", async function () {
      const plan = createTestPlan();
      const tokenHash = await fingerprint("token-pause-race");
      const reqHash = await fingerprint({
        tool: plan.tool,
        params: plan.params,
      });
      await store.savePreview(tokenHash, reqHash, plan, Date.now() + 60000);
      const { taskID } = await store.enqueue(
        tokenHash,
        reqHash,
        "idem-pause-race",
      );

      // Claim step (state: submitted, phase: validating)
      const step = await store.claim(taskID, "worker-1");
      expect(step).to.not.be.null;
      expect(step!.phase).to.equal("validating");

      // Intercurrent pause: task is paused while step is validating
      await store.stop(taskID, "pause");

      // beginNative called after pause
      const allowed = await store.beginNative(step!);
      expect(allowed).to.be.false;

      // Step must be rolled back to pending / not_submitted
      const steps = await store.getSteps(taskID);
      expect(steps[0].state).to.equal("pending");
      expect(steps[0].phase).to.equal("not_submitted");
      expect(steps[0].attemptID).to.be.null;
      expect(steps[0].owner).to.be.null;

      const task = await store.getTask(taskID);
      expect(task.state).to.equal("paused");
      expect(task.desiredState).to.equal("paused");
    });

    it("race: beginNative returns false and sets step to cancelled when task is cancelled during validating", async function () {
      const plan = createTestPlan();
      const tokenHash = await fingerprint("token-cancel-race");
      const reqHash = await fingerprint({
        tool: plan.tool,
        params: plan.params,
      });
      await store.savePreview(tokenHash, reqHash, plan, Date.now() + 60000);
      const { taskID } = await store.enqueue(
        tokenHash,
        reqHash,
        "idem-cancel-race",
      );

      const step = await store.claim(taskID, "worker-1");
      expect(step).to.not.be.null;

      // Intercurrent cancel: task cancelled while step is validating
      await store.stop(taskID, "cancel");

      // beginNative called after cancel
      const allowed = await store.beginNative(step!);
      expect(allowed).to.be.false;

      // Step must become cancelled
      const steps = await store.getSteps(taskID);
      expect(steps[0].state).to.equal("cancelled");
      expect(steps[0].phase).to.equal("not_submitted");

      const task = await store.getTask(taskID);
      expect(task.state).to.equal("cancelled");
      expect(task.desiredState).to.equal("cancelled");
    });

    it("claim returns null for paused or cancelled tasks", async function () {
      const plan = createTestPlan();
      const tokenHash = await fingerprint("token-claim-stop");
      const reqHash = await fingerprint({
        tool: plan.tool,
        params: plan.params,
      });
      await store.savePreview(tokenHash, reqHash, plan, Date.now() + 60000);
      const { taskID } = await store.enqueue(
        tokenHash,
        reqHash,
        "idem-claim-stop",
      );

      await store.stop(taskID, "pause");
      const stepPaused = await store.claim(taskID, "worker-1");
      expect(stepPaused).to.be.null;

      await store.stop(taskID, "cancel");
      const stepCancelled = await store.claim(taskID, "worker-1");
      expect(stepCancelled).to.be.null;
    });
  });

  describe("Completed task stop protection", function () {
    it("stop on completed task does not alter state, desiredState, or outcome", async function () {
      const plan = createTestPlan();
      const tokenHash = await fingerprint("token-complete-stop");
      const reqHash = await fingerprint({
        tool: plan.tool,
        params: plan.params,
      });
      await store.savePreview(tokenHash, reqHash, plan, Date.now() + 60000);
      const { taskID } = await store.enqueue(
        tokenHash,
        reqHash,
        "idem-complete-stop",
      );

      const step = await store.claim(taskID, "worker-1");
      await store.beginNative(step!);
      await store.finish(step!, { state: "succeeded", result: { done: true } });

      const taskBefore = await store.getTask(taskID);
      expect(taskBefore.state).to.equal("completed");

      // Calling stop with pause or cancel must be a no-op
      await store.stop(taskID, "pause");
      const taskAfterPause = await store.getTask(taskID);
      expect(taskAfterPause.state).to.equal("completed");
      expect(taskAfterPause.desiredState).to.equal("running");

      await store.stop(taskID, "cancel");
      const taskAfterCancel = await store.getTask(taskID);
      expect(taskAfterCancel.state).to.equal("completed");
      expect(taskAfterCancel.desiredState).to.equal("running");
    });
  });

  describe("Stale attempt detection and callback protection", function () {
    it("rejects progress, heartbeat, and finish from stale attemptID or owner (STALE_ATTEMPT)", async function () {
      const plan = createTestPlan();
      const tokenHash = await fingerprint("token-stale");
      const reqHash = await fingerprint({
        tool: plan.tool,
        params: plan.params,
      });
      await store.savePreview(tokenHash, reqHash, plan, Date.now() + 60000);
      const { taskID } = await store.enqueue(tokenHash, reqHash, "idem-stale");

      const step = await store.claim(taskID, "worker-1");
      expect(step).to.not.be.null;

      // Create a stale step copy with wrong attemptID
      const staleStep: StepRecord = {
        ...step!,
        attemptID: "attempt-stale-fake",
      };

      let caughtProgress: any = null;
      try {
        await store.progress(staleStep, "running");
      } catch (err) {
        caughtProgress = err;
      }
      expect(caughtProgress).to.be.instanceOf(PlusError);
      expect(caughtProgress.code).to.equal("STALE_ATTEMPT");

      let caughtHeartbeat: any = null;
      try {
        await store.heartbeat(staleStep);
      } catch (err) {
        caughtHeartbeat = err;
      }
      expect(caughtHeartbeat).to.be.instanceOf(PlusError);
      expect(caughtHeartbeat.code).to.equal("STALE_ATTEMPT");

      let caughtFinish: any = null;
      try {
        await store.finish(staleStep, { state: "succeeded" });
      } catch (err) {
        caughtFinish = err;
      }
      expect(caughtFinish).to.be.instanceOf(PlusError);
      expect(caughtFinish.code).to.equal("STALE_ATTEMPT");
    });

    it("rejects finish after step has already settled (STALE_ATTEMPT)", async function () {
      const plan = createTestPlan();
      const tokenHash = await fingerprint("token-settled");
      const reqHash = await fingerprint({
        tool: plan.tool,
        params: plan.params,
      });
      await store.savePreview(tokenHash, reqHash, plan, Date.now() + 60000);
      const { taskID } = await store.enqueue(
        tokenHash,
        reqHash,
        "idem-settled",
      );

      const step = await store.claim(taskID, "worker-1");
      await store.beginNative(step!);
      await store.finish(step!, { state: "succeeded" });

      // Late second finish call must fail with STALE_ATTEMPT
      let caught: any = null;
      try {
        await store.finish(step!, { state: "succeeded" });
      } catch (err) {
        caught = err;
      }
      expect(caught).to.be.instanceOf(PlusError);
      expect(caught.code).to.equal("STALE_ATTEMPT");
    });
  });

  describe("Crash recovery safety semantics", function () {
    it("validating phase recovery safely reverts to pending without uncertain review", async function () {
      const plan = createTestPlan();
      const tokenHash = await fingerprint("token-rec-val");
      const reqHash = await fingerprint({
        tool: plan.tool,
        params: plan.params,
      });
      await store.savePreview(tokenHash, reqHash, plan, Date.now() + 60000);
      const { taskID } = await store.enqueue(
        tokenHash,
        reqHash,
        "idem-rec-val",
      );

      // Claim step -> phase becomes "validating"
      const step = await store.claim(taskID, "worker-1");
      expect(step!.phase).to.equal("validating");

      // Simulate crash and restart recovery
      const uncertain = await store.prepareRecovery();

      // Validating step had no side effects, so uncertain list is empty
      expect(uncertain).to.be.empty;

      const steps = await store.getSteps(taskID);
      expect(steps[0].state).to.equal("pending");
      expect(steps[0].phase).to.equal("not_submitted");
      expect(steps[0].attemptID).to.be.null;
      expect(steps[0].owner).to.be.null;

      const task = await store.getTask(taskID);
      expect(task.desiredState).to.equal("paused");
      expect(task.state).to.equal("paused");
    });

    it("native_intent phase recovery marks step needs_review and does NOT auto rerun", async function () {
      const plan = createTestPlan();
      const tokenHash = await fingerprint("token-rec-nat");
      const reqHash = await fingerprint({
        tool: plan.tool,
        params: plan.params,
      });
      await store.savePreview(tokenHash, reqHash, plan, Date.now() + 60000);
      const { taskID } = await store.enqueue(
        tokenHash,
        reqHash,
        "idem-rec-nat",
      );

      const step = await store.claim(taskID, "worker-1");
      await store.beginNative(step!); // phase is now "native_intent"

      const uncertain = await store.prepareRecovery();

      // Native intent is uncertain and must be returned for reconciliation
      expect(uncertain).to.have.lengthOf(1);
      expect(uncertain[0].taskID).to.equal(taskID);

      const steps = await store.getSteps(taskID);
      expect(steps[0].state).to.equal("needs_review");
      expect(steps[0].phase).to.equal("recovering");

      const task = await store.getTask(taskID);
      expect(task.state).to.equal("needs_review");
      expect(task.desiredState).to.equal("paused");
    });

    it("cancel_requested preserves cancellation intent across restart", async function () {
      const plan = createTestPlan();
      const tokenHash = await fingerprint("token-rec-cancel");
      const reqHash = await fingerprint({
        tool: plan.tool,
        params: plan.params,
      });
      await store.savePreview(tokenHash, reqHash, plan, Date.now() + 60000);
      const { taskID } = await store.enqueue(
        tokenHash,
        reqHash,
        "idem-rec-cancel",
      );

      const step = await store.claim(taskID, "worker-1");
      await store.beginNative(step!);
      await store.progress(step!, "running");

      // User requested cancellation while running
      await store.stop(taskID, "cancel");
      const taskBefore = await store.getTask(taskID);
      expect(taskBefore.state).to.equal("cancel_requested");
      expect(taskBefore.desiredState).to.equal("cancelled");

      // Restart recovery
      await store.prepareRecovery();

      const taskAfter = await store.getTask(taskID);
      // Cancellation intent must be preserved, not overwritten to paused
      expect(taskAfter.desiredState).to.equal("cancelled");
    });

    it("needs_review persists and survives multiple restarts for continued reconciliation", async function () {
      const plan = createTestPlan();
      const tokenHash = await fingerprint("token-multi-restart");
      const reqHash = await fingerprint({
        tool: plan.tool,
        params: plan.params,
      });
      await store.savePreview(tokenHash, reqHash, plan, Date.now() + 60000);
      const { taskID } = await store.enqueue(
        tokenHash,
        reqHash,
        "idem-multi-restart",
      );

      const step = await store.claim(taskID, "worker-1");
      await store.beginNative(step!);

      // First restart
      const uncertain1 = await store.prepareRecovery();
      expect(uncertain1).to.have.lengthOf(1);
      const stepAfterRestart1 = (await store.getSteps(taskID))[0];
      expect(stepAfterRestart1.state).to.equal("needs_review");

      // Target reservation is still held
      const target = "1:item:ITEM0001";
      const conflicts1 = await ledger.queryAsync(
        "SELECT taskID FROM reservations WHERE target = ?",
        [target],
      );
      expect(conflicts1).to.have.lengthOf(1);

      // Second restart without resolving the step
      const uncertain2 = await store.prepareRecovery();
      expect(uncertain2).to.have.lengthOf(1);
      expect(uncertain2[0].id).to.equal(step!.id);

      const conflicts2 = await ledger.queryAsync(
        "SELECT taskID FROM reservations WHERE target = ?",
        [target],
      );
      expect(conflicts2).to.have.lengthOf(1);

      // Now reconcile the result
      await store.recoverResult(uncertain2[0], {
        state: "succeeded",
        result: { reconciled: true },
      });

      const stepsFinal = await store.getSteps(taskID);
      expect(stepsFinal[0].state).to.equal("succeeded");
      expect(stepsFinal[0].phase).to.equal("reconciled");

      // Reservation is now released
      const conflictsAfter = await ledger.queryAsync(
        "SELECT taskID FROM reservations WHERE target = ?",
        [target],
      );
      expect(conflictsAfter).to.be.empty;
    });
  });

  describe("healthSummary and taskSnapshot", function () {
    it("returns accurate task health counts by state", async function () {
      const plan1 = createTestPlan("recognize_pdfs", 1, [createTestStep("s1")]);
      const token1 = await fingerprint("tok-h1");
      const req1 = await fingerprint({ tool: plan1.tool, params: {} });
      await store.savePreview(token1, req1, plan1, Date.now() + 60000);
      const { taskID: id1 } = await store.enqueue(token1, req1, "idem-h1");
      await store.stop(id1, "pause");

      const plan2 = createTestPlan("recognize_pdfs", 1, [createTestStep("s2")]);
      const token2 = await fingerprint("tok-h2");
      const req2 = await fingerprint({ tool: plan2.tool, params: {} });
      await store.savePreview(token2, req2, plan2, Date.now() + 60000);
      const { taskID: id2 } = await store.enqueue(token2, req2, "idem-h2");
      const s2 = await store.claim(id2, "worker-1");
      await store.beginNative(s2!);
      await store.finish(s2!, { state: "needs_review" });

      const summary = (await store.healthSummary(1)) as any;
      expect(summary.interruptedCount).to.be.at.least(1);
      expect(summary.needsReviewCount).to.be.at.least(1);
      expect(summary.details.ledgerAvailable).to.be.true;
    });

    it("taskSnapshot returns consistent task and steps view", async function () {
      const plan = createTestPlan("recognize_pdfs", 1, [
        createTestStep("snap-1"),
        createTestStep("snap-2"),
      ]);
      const token = await fingerprint("tok-snap");
      const req = await fingerprint({ tool: plan.tool, params: {} });
      await store.savePreview(token, req, plan, Date.now() + 60000);
      const { taskID: id } = await store.enqueue(token, req, "idem-snap");

      const snapshot = await store.taskSnapshot(id);
      expect(snapshot.task.id).to.equal(id);
      expect(snapshot.steps).to.have.lengthOf(2);
      expect(snapshot.steps[0].id).to.equal("snap-1");
      expect(snapshot.steps[1].id).to.equal("snap-2");
    });
  });

  describe("mozIStorageRow Proxy behavior and regression tests", function () {
    it("row proxy adheres to non-enumerable, get then ignored, and non-existent column error", function () {
      const proxy = createMozStorageRowProxy({
        id: "test-id",
        tool: "test-tool",
      });
      // Non-enumerable: cannot be spread or directly JSON serialized
      expect(Object.keys(proxy)).to.be.empty;
      expect({ ...proxy }).to.deep.equal({});
      expect(JSON.stringify(proxy)).to.equal("{}");

      // Valid columns return value
      expect(proxy.id).to.equal("test-id");
      expect(proxy.tool).to.equal("test-tool");

      // get "then" returns undefined (ignored so not mistaken for Promise)
      expect((proxy as any).then).to.be.undefined;

      // Accessing non-existent column throws
      expect(() => (proxy as any).non_existent_column).to.throw(
        /Column "non_existent_column" does not exist in mozIStorageRow/,
      );
    });

    it("demonstrates that old spread implementation ({ ...row }) fails on Proxy while TaskStore succeeds", function () {
      const rawData = {
        id: "task-001",
        tool: "recognize_pdfs",
        libraryID: 1,
        state: "queued",
        desiredState: "running",
        createdAt: 1000,
        updatedAt: 1000,
        paramsJSON: JSON.stringify({ key: "val" }),
      };
      const proxy = createMozStorageRowProxy(rawData);

      // Old implementation: const { paramsJSON, ...rest } = row; return { ...rest, params: JSON.parse(paramsJSON) };
      const oldUnpack = (row: any) => {
        const { paramsJSON, ...rest } = row;
        return { ...rest, params: JSON.parse(paramsJSON) };
      };
      const failedResult = oldUnpack(proxy);
      // In the old implementation, rest is empty! id, tool, state, etc. are lost!
      expect(failedResult.id).to.be.undefined;
      expect(failedResult.tool).to.be.undefined;
      expect(failedResult.state).to.be.undefined;
    });

    it("verifies enqueue, claim, taskSnapshot, and recovery under mozIStorageRow Proxy", async function () {
      const plan = createTestPlan(
        "recognize_pdfs",
        1,
        [
          createTestStep("step-proxy-1", [
            { libraryID: 1, key: "ITEM_PRX", kind: "item" },
          ]),
        ],
        { testArg: "proxy-test" },
      );

      const tokenHash = await fingerprint("tok-proxy");
      const reqHash = await fingerprint({
        tool: plan.tool,
        params: plan.params,
      });
      await store.savePreview(tokenHash, reqHash, plan, Date.now() + 60000);

      // 1. Enqueue under proxy
      const { taskID, replayed } = await store.enqueue(
        tokenHash,
        reqHash,
        "idem-proxy",
      );
      expect(taskID)
        .to.be.a("string")
        .that.matches(/^task-/);
      expect(replayed).to.be.false;

      // 2. Claim step: in old implementation this.stepFromRow({ ...row, ... }) failed with SyntaxError on undefined specJSON
      const step = await store.claim(taskID, "worker-proxy");
      expect(step).to.not.be.null;
      expect(step!.id).to.equal("step-proxy-1");
      expect(step!.taskID).to.equal(taskID);
      expect(step!.state).to.equal("submitted");
      expect(step!.phase).to.equal("validating");
      expect(step!.owner).to.equal("worker-proxy");
      expect(step!.attemptID).to.be.a("string");

      // 3. taskSnapshot: verifies explicit field reading produces complete task and steps
      const snapshot = await store.taskSnapshot(taskID);
      expect(snapshot.task.id).to.equal(taskID);
      expect(snapshot.task.tool).to.equal("recognize_pdfs");
      expect(snapshot.task.libraryID).to.equal(1);
      expect(snapshot.task.state).to.equal("running");
      expect(snapshot.task.desiredState).to.equal("running");
      expect(snapshot.task.params).to.deep.equal({ testArg: "proxy-test" });
      expect(snapshot.steps).to.have.lengthOf(1);
      expect(snapshot.steps[0].id).to.equal("step-proxy-1");

      // Snapshot JSON serialization works properly
      const snapshotJSON = JSON.stringify(snapshot);
      expect(snapshotJSON).to.include(`"id":"${taskID}"`);
      expect(snapshotJSON).to.include('"tool":"recognize_pdfs"');

      // 4. Advance step to native_intent and test recovery
      await store.beginNative(step!);
      const uncertain = await store.prepareRecovery();
      expect(uncertain).to.have.lengthOf(1);
      expect(uncertain[0].taskID).to.equal(taskID);

      const stepsAfterRecovery = await store.getSteps(taskID);
      expect(stepsAfterRecovery[0].state).to.equal("needs_review");
      expect(stepsAfterRecovery[0].phase).to.equal("recovering");

      // Settle recovery result
      await store.recoverResult(uncertain[0], {
        state: "succeeded",
        result: { recovered: true },
      });
      const finalTask = await store.getTask(taskID);
      expect(finalTask.state).to.equal("completed");
      expect(finalTask.id).to.equal(taskID);
      expect(finalTask.tool).to.equal("recognize_pdfs");
    });

    it("verifies store.list() serialization produces real task objects, not empty proxies", async function () {
      const plan = createTestPlan("recognize_pdfs", 1, [
        createTestStep("s-list-1"),
      ]);
      const tokenHash = await fingerprint("tok-list");
      const reqHash = await fingerprint({
        tool: plan.tool,
        params: plan.params,
      });
      await store.savePreview(tokenHash, reqHash, plan, Date.now() + 60000);
      const { taskID } = await store.enqueue(tokenHash, reqHash, "idem-list");

      const listRes = await store.list();
      expect(listRes.tasks).to.have.lengthOf(1);

      // Verify explicit field mappings on returned tasks
      const taskItem = listRes.tasks[0];
      expect(taskItem.id).to.equal(taskID);
      expect(taskItem.tool).to.equal("recognize_pdfs");
      expect(taskItem.libraryID).to.equal(1);
      expect(taskItem.state).to.equal("queued");
      expect(taskItem.desiredState).to.equal("running");
      expect(taskItem.createdAt).to.be.a("number");
      expect(taskItem.updatedAt).to.be.a("number");

      // JSON serialization: in old implementation this produced `{"tasks":[{}]}`
      const jsonStr = JSON.stringify(listRes);
      expect(jsonStr).to.include(`"id":"${taskID}"`);
      expect(jsonStr).to.include('"tool":"recognize_pdfs"');
      expect(jsonStr).to.not.equal('{"tasks":[{}]}');
    });
  });
});
