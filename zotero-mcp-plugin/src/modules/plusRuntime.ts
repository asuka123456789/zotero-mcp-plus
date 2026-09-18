import { DuplicateService, findDuplicates } from "./duplicateService.ts";
import { libraryHealth } from "./healthService.ts";
import {
  LegacyOperationAdapter,
  type LegacyExecutor,
} from "./legacyOperations.ts";
import { OperationPreview } from "./operationPreview.ts";
import { PlusError, requireLibraryID, type JsonObject } from "./plusTypes.ts";
import { RecognitionService } from "./recognitionService.ts";
import { findStandaloneAttachments } from "./standaloneService.ts";
import { TaskManager } from "./taskManager.ts";
import { TaskStore, type LedgerConnection } from "./taskStore.ts";
import { LEGACY_WRITE_TOOLS } from "./toolRegistry.ts";

interface PlusRuntime {
  store: TaskStore;
  manager: TaskManager;
  preview: OperationPreview;
}

let runtime: PlusRuntime | null = null;
let initializing: Promise<void> | null = null;
let legacyExecutor: LegacyExecutor | null = null;

// 原 handler 只在通过确认与持久执行意图后调用，不作为公开 MCP 工具。
export function setLegacyExecutor(executor: LegacyExecutor): void {
  legacyExecutor = executor;
}

export async function initializePlusRuntime(
  canWrite: () => boolean,
): Promise<void> {
  if (runtime) return;
  if (initializing) return initializing;
  initializing = (async () => {
    const database = new Zotero.DBConnection(
      PathUtils.join(Zotero.DataDirectory.dir, "zotero-mcp-plus-tasks.sqlite"),
    );
    // 原生支持 debug；上游类型尚未声明。noCache=false 保持其默认缓存行为。
    const queryOptions = { debug: false, noCache: false };
    const connection: LedgerConnection = {
      // 账本参数可能包含私有快照；不让原生 SQL 调试日志输出参数。
      queryAsync: (sql, params) =>
        database.queryAsync(sql, params, queryOptions),
      valueQueryAsync: (sql, params) =>
        database.valueQueryAsync(sql, params, queryOptions),
      executeTransaction: (operation) => database.executeTransaction(operation),
      closeDatabase: () => database.closeDatabase(true),
    };
    const store = new TaskStore(connection);
    try {
      await store.initialize();
      const manager = new TaskManager(store, canWrite, (message) =>
        ztoolkit.log(`[MCP Plus] ${message}`),
      );
      manager.register(new RecognitionService());
      manager.register(new DuplicateService());
      for (const tool of LEGACY_WRITE_TOOLS) {
        manager.register(
          new LegacyOperationAdapter(tool, (name, args) => {
            if (!legacyExecutor)
              throw new PlusError(
                "EXECUTOR_UNAVAILABLE",
                "文库写入执行器尚未就绪",
              );
            return legacyExecutor(name, args);
          }),
        );
      }
      manager.register(manager.controlAdapter());
      await manager.recover();
      runtime = {
        store,
        manager,
        preview: new OperationPreview(store, canWrite),
      };
      // 重启只对账，不因启动或恢复网络而自动恢复投递。
    } catch (error) {
      await store.close().catch(() => undefined);
      throw error;
    }
  })();
  try {
    await initializing;
  } finally {
    initializing = null;
  }
}

function requireRuntime(): PlusRuntime {
  if (!runtime?.store.isHealthy()) {
    throw new PlusError(
      "LEDGER_UNAVAILABLE",
      "任务账本不可用；只读文库查询仍可使用，文库写入已停止",
    );
  }
  return runtime;
}

export async function suspendPlusRuntime(
  reason: string,
  invalidateConfirmations = true,
): Promise<void> {
  await runtime?.manager.suspend(reason, invalidateConfirmations);
}

export async function shutdownPlusRuntime(): Promise<void> {
  if (initializing) await initializing.catch(() => undefined);
  const current = runtime;
  runtime = null;
  legacyExecutor = null;
  await current?.manager.shutdown();
}

export async function dispatchPlusTool(
  name: string,
  args: JsonObject,
): Promise<JsonObject> {
  if (name === "find_standalone_attachments")
    return findStandaloneAttachments(args);
  if (name === "find_duplicates") return findDuplicates(args);
  if (name === "library_health") {
    const summary = runtime?.store.isHealthy()
      ? await runtime.store.healthSummary(requireLibraryID(args.libraryID))
      : {
          interruptedCount: 0,
          needsReviewCount: 0,
          details: { ledgerAvailable: false, countsKnown: false },
        };
    return libraryHealth(args, summary);
  }
  const { store, manager, preview } = requireRuntime();
  if (name === "task_status") return manager.status(args.taskID, args);
  if (name === "task_list") return store.list(args);
  if (name === "add_by_identifier" && args.jobID !== undefined) {
    const task = await store.getTask(args.jobID);
    if (task.tool !== name)
      throw new PlusError("INVALID_JOB", "jobID 不属于 identifier 导入任务");
    return { ...(await manager.status(task.id, args)), jobID: task.id };
  }
  if (name === "task_control" && ["pause", "cancel"].includes(args.action)) {
    return manager.stop(args.taskID, args.action);
  }
  const result = await preview.dispatch(manager.adapter(name), args);
  if (result.taskID) {
    // 重放只返回原任务；不会恢复已暂停、取消或待核查任务。
    manager.kick();
    if (name === "add_by_identifier") result.jobID = result.taskID;
  }
  return result;
}
