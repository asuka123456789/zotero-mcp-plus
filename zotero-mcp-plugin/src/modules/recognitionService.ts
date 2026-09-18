import {
  PlusError,
  requireLibraryID,
  requireKeys,
  requireWritable,
  fingerprint,
  type OperationAdapter,
  type OperationPlan,
  type PlanStep,
  type StepOutcome,
  type ExecutionContext,
  type JsonObject,
  type TargetRef,
} from "./plusTypes.ts";
import {
  determineAttachmentFileStatus,
  isPDFAttachment,
  getItemCollectionKeys,
  getAttachmentFileStats,
  getAttachmentAnnotationSnapshots,
  type AttachmentAnnotationSnapshot,
} from "./standaloneService.ts";

declare const Zotero: any;

async function getItem(libraryID: number, key: string): Promise<any> {
  if (typeof Zotero === "undefined") {
    throw new PlusError("INTERNAL_ERROR", "Zotero runtime unavailable");
  }
  if (typeof Zotero.Items?.getByLibraryAndKeyAsync === "function") {
    return await Zotero.Items.getByLibraryAndKeyAsync(libraryID, key);
  }
  if (typeof Zotero.Items?.getByLibraryAndKey === "function") {
    return Zotero.Items.getByLibraryAndKey(libraryID, key);
  }
  if (typeof Zotero.Items?.getAsync === "function") {
    const item = await Zotero.Items.getAsync(key);
    if (item && (item.libraryID === libraryID || libraryID === undefined))
      return item;
  }
  if (typeof Zotero.Items?.get === "function") {
    const item = Zotero.Items.get(key);
    if (item && (item.libraryID === libraryID || libraryID === undefined))
      return item;
  }
  return null;
}

async function getItemByID(id: number): Promise<any> {
  if (typeof Zotero === "undefined") return null;
  if (typeof Zotero.Items?.getAsync === "function") {
    return await Zotero.Items.getAsync(id);
  }
  if (typeof Zotero.Items?.get === "function") {
    return Zotero.Items.get(id);
  }
  return null;
}

/**
 * 真正读取持久状态，使用 item.reload(undefined, true)（不 purge，不吞错当成功）
 */
async function reloadItemData(item: any): Promise<any> {
  if (!item) return null;
  if (typeof item.reload === "function") {
    try {
      await item.reload(undefined, true);
    } catch (err: any) {
      throw new PlusError(
        "RELOAD_FAILED",
        `重载条目 [${item.key || item.id}] 持久数据失败: ${err.message || String(err)}`,
      );
    }
  }
  return item;
}

function getRenamePref(): boolean {
  if (typeof Zotero !== "undefined" && Zotero.Prefs?.get) {
    try {
      const pref = Zotero.Prefs.get("autoRenameFiles");
      if (pref !== undefined) return Boolean(pref);
    } catch {
      // ignore
    }
  }
  return true;
}

function isItemActiveInNativeQueue(itemId: number): boolean {
  if (typeof Zotero === "undefined" || !Zotero.ProgressQueues?.get)
    return false;
  const queue = Zotero.ProgressQueues.get("recognize");
  if (!queue || typeof queue.getRows !== "function") return false;
  const rows = queue.getRows();
  const activeRow = rows.find((r: any) => r.id === itemId);
  return Boolean(
    activeRow && (activeRow.status === 1 || activeRow.status === 2),
  );
}

/**
 * 统一后置状态核验与对账：
 * 1. 验证附件条目活跃未删且身份未变；
 * 2. 验证同库活跃普通文献 parent；
 * 3. 验证原独立附件所属集合全部迁移至 parent；
 * 4. 验证原附件批注保全：原批注 key、deleted 状态、parent 关联未发生反常改变。
 */
async function verifyRecognitionPostConditions(
  libraryID: number,
  attachmentKey: string,
  expectedOriginalCollections: string[],
  expectedOriginalAnnotations: AttachmentAnnotationSnapshot[] = [],
): Promise<{
  satisfied: boolean;
  parentKey?: string;
  parentTitle?: string;
  parentCollectionKeys?: string[];
  failureReason?: string;
}> {
  const attachment = await getItem(libraryID, attachmentKey);
  if (!attachment) {
    return { satisfied: false, failureReason: "附件条目不存在" };
  }
  if (attachment.deleted) {
    return { satisfied: false, failureReason: "附件条目在回收站中" };
  }

  // 重新加载持久数据（不吞错当成功）
  try {
    await reloadItemData(attachment);
  } catch (err: any) {
    return {
      satisfied: false,
      failureReason: `重载附件持久数据失败: ${err.message || String(err)}`,
    };
  }

  if (attachment.key !== attachmentKey || !isPDFAttachment(attachment)) {
    return {
      satisfied: false,
      failureReason: "附件身份或类型在识别后发生反常变更",
    };
  }

  let parent = attachment.parentItem;
  if (!parent && attachment.parentItemID) {
    parent = await getItemByID(attachment.parentItemID);
  }

  if (!parent) {
    return { satisfied: false, failureReason: "未挂接任何父条目" };
  }

  try {
    await reloadItemData(parent);
  } catch (err: any) {
    return {
      satisfied: false,
      failureReason: `重载父条目持久数据失败: ${err.message || String(err)}`,
    };
  }

  if (parent.deleted) {
    return { satisfied: false, failureReason: "父条目已在回收站中" };
  }

  if (parent.libraryID !== libraryID) {
    return { satisfied: false, failureReason: "父条目不在同一文库" };
  }

  const isRegular =
    typeof parent.isRegularItem === "function"
      ? parent.isRegularItem()
      : typeof parent.isAttachment === "function"
        ? !parent.isAttachment() && !parent.isNote()
        : true;
  if (!isRegular) {
    return { satisfied: false, failureReason: "挂接的父条目不是普通文献条目" };
  }

  // 验证原集合全部保留到 parent
  let parentCollectionKeys: string[] = [];
  try {
    parentCollectionKeys = getItemCollectionKeys(parent);
  } catch (err: any) {
    return {
      satisfied: false,
      failureReason: `解析父条目集合失败: ${err.message || String(err)}`,
    };
  }

  const missingColls = expectedOriginalCollections.filter(
    (k) => !parentCollectionKeys.includes(k),
  );
  if (missingColls.length > 0) {
    return {
      satisfied: false,
      failureReason: `原独立附件所属集合 [${missingColls.join(", ")}] 未迁移至父条目`,
    };
  }

  // 验证原附件批注保全：所有原批注仍存，且 deleted 状态与 parent 关联未反常改变
  let currentAnnotations: AttachmentAnnotationSnapshot[] = [];
  try {
    currentAnnotations = await getAttachmentAnnotationSnapshots(attachment);
  } catch (err: any) {
    return {
      satisfied: false,
      failureReason: `重载附件批注失败: ${err.message || String(err)}`,
    };
  }

  const currentAnnotMap = new Map(currentAnnotations.map((a) => [a.key, a]));
  for (const exp of expectedOriginalAnnotations) {
    const cur = currentAnnotMap.get(exp.key);
    if (!cur) {
      return {
        satisfied: false,
        failureReason: `原附件批注 [${exp.key}] 丢失`,
      };
    }
    if (cur.deleted !== exp.deleted) {
      return {
        satisfied: false,
        failureReason: `原附件批注 [${exp.key}] 的删除状态反常改变 (原: ${exp.deleted}, 现: ${cur.deleted})`,
      };
    }
    if (cur.parentItemID !== exp.parentItemID) {
      return {
        satisfied: false,
        failureReason: `原附件批注 [${exp.key}] 的父条目关联反常改变 (原 parentItemID: ${exp.parentItemID}, 现 parentItemID: ${cur.parentItemID})`,
      };
    }
  }

  const parentTitle =
    typeof parent.getField === "function"
      ? parent.getField("title")
      : parent.title;

  return {
    satisfied: true,
    parentKey: parent.key,
    parentTitle,
    parentCollectionKeys,
  };
}

export class RecognitionService implements OperationAdapter {
  readonly tool = "recognize_pdfs";
  readonly lane = "recognition" as const;

  /**
   * 准备识别计划：规范化参数，严格只读预检，输出每项 PlanStep
   */
  async prepare(args: JsonObject): Promise<OperationPlan> {
    const libraryID = requireLibraryID(args.libraryID);
    const attachmentKeys = requireKeys(
      args.attachmentKeys,
      "attachmentKeys",
      500,
    );

    // 检查文库可写权限
    requireWritable(libraryID);

    const renamePref = getRenamePref();
    const steps: PlanStep[] = [];

    // 获取原生队列以便检测已有任务
    const nativeQueue =
      typeof Zotero !== "undefined" && Zotero.ProgressQueues?.get
        ? Zotero.ProgressQueues.get("recognize")
        : null;
    const activeNativeRows =
      nativeQueue && typeof nativeQueue.getRows === "function"
        ? nativeQueue.getRows()
        : [];

    for (const key of attachmentKeys) {
      const blockers: Array<{ code: string; message: string }> = [];
      const item = await getItem(libraryID, key);
      let collectionKeys: string[] = [];
      let annotationSnapshots: AttachmentAnnotationSnapshot[] = [];
      let fileStats: { size: number | null; mtime: number | null } = {
        size: null,
        mtime: null,
      };

      if (!item) {
        blockers.push({
          code: "ITEM_NOT_FOUND",
          message: `附件 [${key}] 不存在`,
        });
      } else {
        if (item.deleted) {
          blockers.push({
            code: "ITEM_DELETED",
            message: `附件 [${key}] 已在回收站`,
          });
        }

        if (typeof item.isEditable === "function" && !item.isEditable()) {
          blockers.push({
            code: "NOT_EDITABLE",
            message: `附件 [${key}] 不可编辑`,
          });
        }

        const isStandalone =
          typeof item.isTopLevelItem === "function"
            ? item.isTopLevelItem()
            : !item.parentItemID && !item.parentItem;
        if (!isStandalone) {
          blockers.push({
            code: "NOT_STANDALONE",
            message: `附件 [${key}] 不是独立附件，已关联父条目`,
          });
        }

        if (!isPDFAttachment(item)) {
          blockers.push({
            code: "NOT_PDF",
            message: `附件 [${key}] 不是 PDF 附件`,
          });
        }

        // 文件可用性与本地尺寸/修改时间检查（纳入指纹，感知文件替换）
        const fileStatus = await determineAttachmentFileStatus(item);
        if (fileStatus !== "available") {
          blockers.push({
            code: "FILE_UNAVAILABLE",
            message: `附件 [${key}] 本地文件不可用 (${fileStatus})`,
          });
        } else {
          fileStats = await getAttachmentFileStats(item);
        }

        // 集合 key 解析检查：无法解析必须明确不可用并阻断预览
        try {
          collectionKeys = getItemCollectionKeys(item);
        } catch (err: any) {
          blockers.push({
            code: err.code || "COLLECTION_KEY_UNRESOLVED",
            message: err.message || `附件 [${key}] 集合键无法解析`,
          });
        }

        // 批注快照记录
        annotationSnapshots = await getAttachmentAnnotationSnapshots(item);

        // 原生 canRecognize 检查
        if (
          typeof Zotero !== "undefined" &&
          Zotero.RecognizeDocument?.canRecognize &&
          !Zotero.RecognizeDocument.canRecognize(item)
        ) {
          blockers.push({
            code: "CANNOT_RECOGNIZE",
            message: `Zotero 原生接口判定附件 [${key}] 不可识别`,
          });
        }

        // 原生队列冲突阻断：已有同项正在排队或处理
        const queuedRow = activeNativeRows.find((r: any) => r.id === item.id);
        if (queuedRow && (queuedRow.status === 1 || queuedRow.status === 2)) {
          blockers.push({
            code: "ALREADY_QUEUED",
            message: `原生识别队列已包含附件 [${key}] (status: ${queuedRow.status})，不能重复提交或冒认`,
          });
        }
      }

      const sourceSnapshot = {
        key,
        version: item?.version ?? null,
        dateModified: item?.dateModified ?? null,
        deleted: item?.deleted ?? false,
        parentItemID: item?.parentItemID ?? null,
        contentType:
          item?.attachmentContentType || item?.contentType || "application/pdf",
        filename: item?.attachmentFilename || item?.filename || "",
        collections: collectionKeys,
        annotations: annotationSnapshots,
        autoRenameFiles: renamePref,
        fileSize: fileStats.size,
        fileMtime: fileStats.mtime,
      };

      const fp = await fingerprint(sourceSnapshot);
      const targets: TargetRef[] = [{ libraryID, key, kind: "item" }];

      const preview = {
        attachmentKey: key,
        filename: item?.attachmentFilename || item?.filename || "",
        contentType:
          item?.attachmentContentType || item?.contentType || "application/pdf",
        collectionKeys,
        annotationKeys: annotationSnapshots.map((a) => a.key),
        autoRenameFiles: renamePref,
        fileSize: fileStats.size,
        fileMtime: fileStats.mtime,
        networkNotice: "原生识别将联网查询元数据，并可能根据偏好自动重命名附件",
      };

      const step: PlanStep = {
        id: key, // 稳定 key 标识，不用 title
        input: {
          libraryID,
          attachmentKey: key,
          sourceSnapshot,
        },
        targets,
        fingerprint: fp,
        preview,
      };

      if (blockers.length > 0) {
        step.blockers = blockers;
      }

      steps.push(step);
    }

    return {
      schemaVersion: 1,
      tool: this.tool,
      libraryID,
      params: args,
      steps,
      warnings: [
        "原生识别将联网查询元数据并写入父条目，原独立附件的集合将被迁移，且附件文件可能被重命名",
      ],
    };
  }

  /**
   * 执行前核查：重新核实权限、原生队列、文件状态、本地文件 size/mtime、rename 偏好、批注状态及数据快照一致性
   */
  async check(step: PlanStep): Promise<void> {
    if (step.blockers && step.blockers.length > 0) {
      throw new PlusError(
        step.blockers[0].code,
        `操作存在阻断项: ${step.blockers[0].message}`,
        { blockers: step.blockers },
      );
    }

    const { libraryID, attachmentKey } = step.input;
    requireWritable(libraryID);

    const item = await getItem(libraryID, attachmentKey);
    if (!item) {
      throw new PlusError("ITEM_NOT_FOUND", `附件 [${attachmentKey}] 不存在`);
    }
    if (item.deleted) {
      throw new PlusError("ITEM_DELETED", `附件 [${attachmentKey}] 已在回收站`);
    }
    if (typeof item.isEditable === "function" && !item.isEditable()) {
      throw new PlusError("NOT_EDITABLE", `附件 [${attachmentKey}] 不可编辑`);
    }

    // 原生队列检查阻断
    if (isItemActiveInNativeQueue(item.id)) {
      throw new PlusError(
        "ALREADY_QUEUED",
        `原生识别队列已包含附件 [${attachmentKey}]，不能重复提交或冒认`,
      );
    }

    // 文件状态检查
    const fileStatus = await determineAttachmentFileStatus(item);
    if (fileStatus !== "available") {
      throw new PlusError(
        "FILE_UNAVAILABLE",
        `附件 [${attachmentKey}] 本地文件不可用 (${fileStatus})`,
      );
    }

    // 集合解析检查
    const collectionKeys = getItemCollectionKeys(item);

    // 获取当前本地文件 stats
    const fileStats = await getAttachmentFileStats(item);

    // 批注快照检查
    const annotationSnapshots = await getAttachmentAnnotationSnapshots(item);

    // 对比当前快照哈希（包含 fileSize, fileMtime 与 annotations）
    const renamePref = getRenamePref();
    const currentSnapshot = {
      key: item.key,
      version: item.version ?? null,
      dateModified: item.dateModified ?? null,
      deleted: item.deleted ?? false,
      parentItemID: item.parentItemID ?? null,
      contentType:
        item.attachmentContentType || item.contentType || "application/pdf",
      filename: item.attachmentFilename || item.filename || "",
      collections: collectionKeys,
      annotations: annotationSnapshots,
      autoRenameFiles: renamePref,
      fileSize: fileStats.size,
      fileMtime: fileStats.mtime,
    };

    const currentFp = await fingerprint(currentSnapshot);
    if (currentFp !== step.fingerprint) {
      throw new PlusError(
        "STATE_CHANGED",
        `附件 [${attachmentKey}] 状态、文件、批注或偏好已发生变化，与预览快照不一致`,
      );
    }
  }

  /**
   * 执行原生识别：
   * 1. 提交前若 signal 已 abort 则立即返回，nativeCalls 必须为 0；
   * 2. 单项提交，先监听 rowupdated 再触发 recognizeItems；
   * 3. ROW_SUCCEEDED 执行统一后置核验（parent活跃常规条目、原集合全保留至parent、批注未丢失未改挂）；
   * 4. ROW_FAILED 一律 needs_review 且 retrySafe: false；
   * 5. nativePromise.then 检查若仍 active 绝不提前释放，无事件收尾时复用统一对账。
   */
  async execute(
    step: PlanStep,
    context: ExecutionContext,
  ): Promise<StepOutcome> {
    await this.check(step);

    // 提交原生前检查 signal：若已中止，立即返回，绝不向原生队列投递
    if (context.signal.aborted) {
      return {
        state: "needs_review",
        error: {
          code: "INTERRUPTED",
          message: "操作在提交前已被中止，未向原生队列投递",
        },
        retrySafe: false,
      };
    }

    const { libraryID, attachmentKey } = step.input;
    const item = await getItem(libraryID, attachmentKey);

    await context.update("submitted", {
      attachmentKey,
      itemID: item.id,
    });

    const queue =
      typeof Zotero !== "undefined" && Zotero.ProgressQueues?.get
        ? Zotero.ProgressQueues.get("recognize")
        : null;

    if (!queue || typeof queue.addListener !== "function") {
      throw new PlusError(
        "RECOGNIZE_QUEUE_UNAVAILABLE",
        "无法获取 Zotero 原生 recognize 进度队列",
      );
    }

    let resolveOutcome: (outcome: StepOutcome) => void;
    const outcomePromise = new Promise<StepOutcome>((resolve) => {
      resolveOutcome = resolve;
    });

    let settled = false;
    const safeSettle = (outcome: StepOutcome) => {
      if (settled) return;
      settled = true;
      resolveOutcome(outcome);
    };

    const onRowUpdated = async (event: any) => {
      // 严格过滤本条目的数值 ID
      if (!event || event.id !== item.id) return;

      try {
        const status = event.status;
        if (status === 2) {
          // ROW_PROCESSING
          await context.update("running", {
            attachmentKey,
            itemID: item.id,
          });
        } else if (status === 4) {
          // ROW_SUCCEEDED: 必须执行统一后置验证（含集合与批注保全）
          const originalColls = step.input?.sourceSnapshot?.collections || [];
          const originalAnnots = step.input?.sourceSnapshot?.annotations || [];
          const checkRes = await verifyRecognitionPostConditions(
            libraryID,
            attachmentKey,
            originalColls,
            originalAnnots,
          );

          if (checkRes.satisfied) {
            safeSettle({
              state: "succeeded",
              result: {
                attachmentKey,
                parentKey: checkRes.parentKey,
                parentTitle: checkRes.parentTitle,
                parentCollectionKeys: checkRes.parentCollectionKeys,
                collectionKeys: checkRes.parentCollectionKeys,
                statusMessage: event.message,
              },
              retrySafe: false,
            });
          } else {
            safeSettle({
              state: "needs_review",
              error: {
                code: "POST_VALIDATION_FAILED",
                message: `原生识别报告成功，但后置条件校验未通过: ${checkRes.failureReason}`,
              },
              retrySafe: false,
            });
          }
        } else if (status === 3) {
          // ROW_FAILED:
          // 原生创建 parent 后 reparent / 集合 / 文件操作失败也会产生 row failed。
          // 凡已调用 recognizeItems 而未满足成功后置条件均 needs_review / retrySafe: false
          safeSettle({
            state: "needs_review",
            error: {
              code: "RECOGNITION_FAILED",
              message: `原生识别报告失败 (${event.message || "error"})；因可能已在文库中创建未完全挂接的父条目，不能保证无副作用，禁止自动重试，需人工核查`,
            },
            retrySafe: false,
          });
        }
      } catch (err: any) {
        safeSettle({
          state: "needs_review",
          error: {
            code: "EVENT_HANDLER_ERROR",
            message: `处理识别事件异常: ${err.message || String(err)}`,
          },
          retrySafe: false,
        });
      }
    };

    const onAbort = () => {
      // 插件关闭或信号中止：去监听器并以 needs_review 收口，不能宣称原生已停止
      safeSettle({
        state: "needs_review",
        error: {
          code: "INTERRUPTED",
          message:
            "操作因插件关闭或中止被中断，已注销监听器；原生后台任务可能仍在运行，不能宣称已停止",
        },
        retrySafe: false,
      });
    };

    if (context.signal.aborted) {
      onAbort();
      return await outcomePromise;
    }

    context.signal.addEventListener("abort", onAbort, { once: true });
    queue.addListener("rowupdated", onRowUpdated);

    try {
      // 再次检查 signal，确保在调用 recognizeItems 之前未发生 abort
      if (context.signal.aborted) {
        onAbort();
        return await outcomePromise;
      }

      // 提交单个项目至原生识别（不调用私有 _recognize）
      const nativePromise = Zotero.RecognizeDocument.recognizeItems([item]);

      // 监听原生 Promise resolve / reject
      if (nativePromise && typeof nativePromise.then === "function") {
        nativePromise
          .then(async () => {
            await new Promise((r) => setTimeout(r, 0));
            if (settled) return;
            // 若原生全局队列仍处于 active 状态（status 1 或 2），
            // 说明本项正常等待中，绝不能提前结束或释放目标！
            if (isItemActiveInNativeQueue(item.id)) {
              return;
            }
            // 若原生队列已结束且本项不再 active，复用统一对账
            const outcome = await this.reconcile(step);
            safeSettle(outcome);
          })
          .catch(async (err: any) => {
            if (settled) return;
            if (isItemActiveInNativeQueue(item.id)) {
              return;
            }
            safeSettle({
              state: "needs_review",
              error: {
                code: "NATIVE_PROMISE_REJECTED",
                message: `原生识别队列 Promise 异常: ${err.message || String(err)}`,
              },
              retrySafe: false,
            });
          });
      }

      const outcome = await outcomePromise;
      return outcome;
    } finally {
      if (typeof queue.removeListener === "function") {
        queue.removeListener("rowupdated", onRowUpdated);
      }
      if (typeof context.signal.removeEventListener === "function") {
        context.signal.removeEventListener("abort", onAbort);
      }
    }
  }

  /**
   * 崩溃恢复与只读对账：绝不调用识别或写库。
   * 1. 附件缺失/在回收站：不能证明无副作用，返回 needs_review 且 retrySafe: false；
   * 2. 若原生仍持有本目标（queued/processing）：返回 needs_review (NATIVE_STILL_RUNNING) 绝不提前释放 reservation；
   * 3. 若已挂 parent：核验 parent 状态、集合迁移与批注保全，满足返回 externally_satisfied，未通过返回 needs_review；
   * 4. 若仍为 standalone：可能遗留孤立 parent，返回 needs_review (POSSIBLE_ORPHAN_PARENT)。
   */
  async reconcile(step: PlanStep): Promise<StepOutcome> {
    const { libraryID, attachmentKey } = step.input;
    const item = await getItem(libraryID, attachmentKey);

    // 1. 条目不存在：此前已进入执行，缺失不能证明无副作用，必须 needs_review
    if (!item) {
      return {
        state: "needs_review",
        error: {
          code: "ITEM_NOT_FOUND",
          message: `附件 [${attachmentKey}] 已不存在，无法排除此前识别已在文库创建孤立条目等副作用，需人工核查`,
        },
        retrySafe: false,
      };
    }

    // 2. 条目在回收站：此前已进入执行，进入回收站更不能证明无副作用，必须 needs_review
    if (item.deleted) {
      return {
        state: "needs_review",
        error: {
          code: "ITEM_DELETED",
          message: `附件 [${attachmentKey}] 已在回收站中，无法排除此前识别已在文库创建孤立条目等副作用，需人工核查`,
        },
        retrySafe: false,
      };
    }

    // 3. 检查原生识别队列是否仍在处理该目标（queued / processing）
    // 若原生仍持有本项，后续可能仍在重命名或写入集合，绝不能提前释放 reservation
    if (isItemActiveInNativeQueue(item.id)) {
      return {
        state: "needs_review",
        error: {
          code: "NATIVE_STILL_RUNNING",
          message: `原生识别队列中该条目仍在运行中，不能释放预留或提前判定完成`,
        },
        retrySafe: false,
      };
    }

    // 4. 检查是否已被挂接父条目并执行统一后置验证
    const hasParent = Boolean(item.parentItem || item.parentItemID);
    if (hasParent) {
      const originalColls = step.input?.sourceSnapshot?.collections || [];
      const originalAnnots = step.input?.sourceSnapshot?.annotations || [];
      const checkRes = await verifyRecognitionPostConditions(
        libraryID,
        attachmentKey,
        originalColls,
        originalAnnots,
      );

      if (checkRes.satisfied) {
        return {
          state: "externally_satisfied",
          result: {
            attachmentKey,
            parentKey: checkRes.parentKey,
            parentTitle: checkRes.parentTitle,
            parentCollectionKeys: checkRes.parentCollectionKeys,
            collectionKeys: checkRes.parentCollectionKeys,
          },
          retrySafe: false,
        };
      }

      return {
        state: "needs_review",
        error: {
          code: "POST_VALIDATION_FAILED",
          message: `条目已挂接父条目，但后置条件校验未通过: ${checkRes.failureReason}`,
        },
        retrySafe: false,
      };
    }

    // 5. 条目仍为独立附件
    // 曾提交识别但当前仍独立，可能在 Zotero 文库中遗留未完成挂接的孤立父条目，必须由人工复核，禁止自动重试
    return {
      state: "needs_review",
      error: {
        code: "POSSIBLE_ORPHAN_PARENT",
        message: `附件 [${attachmentKey}] 仍为独立条目，但此前已提交识别，可能已在文库中创建未挂接的孤立父条目，禁止自动重试，需人工核查`,
      },
      retrySafe: false,
    };
  }
}
