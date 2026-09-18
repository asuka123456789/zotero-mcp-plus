import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type {
  LedgerConnection,
  TaskStore,
} from "../../src/modules/taskStore.ts";
import {
  fingerprint,
  type OperationPlan,
  type PlanStep,
  type TargetRef,
  type JsonObject,
} from "../../src/modules/plusTypes.ts";

/**
 * Simulates Zotero DB mozIStorageRow Proxy:
 * - Non-enumerable: cannot be spread `{ ...row }` or directly JSON serialized.
 * - get "then" returns undefined (ignored so it's not mistaken for a Thenable).
 * - Accessing any non-existent column throws an Error.
 */
export function createMozStorageRowProxy<T extends Record<string, any>>(
  data: T,
): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      if (prop === "then" || prop === "toJSON" || typeof prop === "symbol") {
        return undefined;
      }
      if (Object.hasOwn(data, prop) || prop in data) {
        return data[prop as string];
      }
      throw new Error(
        `Column "${String(prop)}" does not exist in mozIStorageRow`,
      );
    },
    has(_target, prop) {
      return prop in data;
    },
    ownKeys() {
      // Non-enumerable: returns empty array so object spread { ...row } yields {}
      return [];
    },
    getOwnPropertyDescriptor() {
      return undefined;
    },
  });
}

/**
 * SQLite-based implementation of LedgerConnection for testing.
 * Uses Node v24's node:sqlite DatabaseSync.
 * Wraps all returned queryAsync rows in mozIStorageRow Proxy.
 */
export class SqliteLedgerConnection implements LedgerConnection {
  public db: DatabaseSync;
  private transactionDepth = 0;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  async queryAsync(sql: string, params: any[] = []): Promise<any> {
    const trimmed = sql.trim().toUpperCase();
    const stmt = this.db.prepare(sql);
    if (
      trimmed.startsWith("SELECT") ||
      trimmed.startsWith("PRAGMA") ||
      trimmed.startsWith("WITH")
    ) {
      const rows = stmt.all(...params) as Record<string, any>[];
      return rows.map((row) => createMozStorageRowProxy(row));
    }
    return stmt.run(...params);
  }

  async valueQueryAsync(sql: string, params: any[] = []): Promise<any> {
    const stmt = this.db.prepare(sql);
    const row = stmt.get(...params) as Record<string, any> | undefined;
    if (!row) return undefined;
    const values = Object.values(row);
    return values.length > 0 ? values[0] : undefined;
  }

  async executeTransaction<T>(operation: () => Promise<T>): Promise<T> {
    if (this.transactionDepth === 0) {
      this.db.exec("BEGIN");
    }
    this.transactionDepth++;
    try {
      const result = await operation();
      this.transactionDepth--;
      if (this.transactionDepth === 0) {
        this.db.exec("COMMIT");
      }
      return result;
    } catch (error) {
      this.transactionDepth = 0;
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Ignore rollback failure if db was closed or already rolled back
      }
      throw error;
    }
  }

  async closeDatabase(): Promise<void> {
    if (this.db.isOpen) {
      this.db.close();
    }
  }
}

/**
 * Creates an in-memory SQLite ledger connection.
 */
export function createMemoryLedger(): SqliteLedgerConnection {
  const db = new DatabaseSync(":memory:");
  return new SqliteLedgerConnection(db);
}

/**
 * Creates a file-backed SQLite ledger connection.
 */
export function createFileLedger(filePath: string): SqliteLedgerConnection {
  const db = new DatabaseSync(filePath);
  return new SqliteLedgerConnection(db);
}

/**
 * Creates a temporary SQLite database in an isolated OS temp directory.
 */
export function createTempLedger(): {
  ledger: SqliteLedgerConnection;
  dir: string;
  dbPath: string;
  cleanup: () => void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zotero-ledger-test-"));
  const dbPath = path.join(dir, "task-ledger.db");
  const ledger = createFileLedger(dbPath);

  const cleanup = () => {
    try {
      if (ledger.db.isOpen) {
        ledger.db.close();
      }
    } catch {
      // Ignore errors on close
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Ignore errors on rm in Windows temp
    }
  };

  return { ledger, dir, dbPath, cleanup };
}

/**
 * Helper to construct a valid PlanStep for testing.
 */
export function createTestStep(
  id: string,
  targets: TargetRef[] = [],
  options: Partial<PlanStep> = {},
): PlanStep {
  return {
    id,
    input: options.input ?? { key: id },
    targets,
    fingerprint: options.fingerprint ?? `fp-${id}`,
    preview: options.preview ?? { title: `Step ${id}` },
    skipReason: options.skipReason,
    blockers: options.blockers,
  };
}

/**
 * Helper to construct a valid OperationPlan for testing.
 */
export function createTestPlan(
  tool = "recognize_pdfs",
  libraryID = 1,
  steps: PlanStep[] = [],
  params: JsonObject = {},
): OperationPlan {
  return {
    schemaVersion: 1,
    tool,
    libraryID,
    params,
    steps:
      steps.length > 0
        ? steps
        : [
            createTestStep("step-1", [
              { libraryID, key: "ITEM0001", kind: "item" },
            ]),
          ],
    warnings: [],
  };
}

/**
 * Helper to save preview and enqueue a task into TaskStore.
 * Returns { taskID: string, replayed: boolean }.
 */
export async function enqueueTestTask(
  store: TaskStore,
  plan: OperationPlan,
  key: string,
  token = "token-test",
): Promise<{ taskID: string; replayed: boolean }> {
  const tokenHash = await fingerprint(token);
  const reqHash = await fingerprint({ tool: plan.tool, params: plan.params });
  await store.savePreview(tokenHash, reqHash, plan, Date.now() + 60000);
  return store.enqueue(tokenHash, reqHash, key);
}
