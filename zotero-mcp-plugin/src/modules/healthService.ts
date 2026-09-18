import { type JsonObject, PlusError, requireLibraryID } from "./plusTypes.ts";
import { findDuplicates, isPDFAttachment } from "./duplicateService.ts";

declare const Zotero: any;

export const DEFAULT_HEALTH_BUDGET = 1000;

export interface MetadataDeficiencyRule {
  itemType: string;
  requiredFields: string[];
  recommendedFields: string[];
}

export const TYPE_DEFICIENCY_RULES: Record<
  string,
  { required: string[]; recommended: string[] }
> = {
  journalArticle: {
    required: ["title"],
    recommended: ["publicationTitle", "date", "DOI"],
  },
  book: {
    required: ["title"],
    recommended: ["publisher", "date", "ISBN"],
  },
  thesis: {
    required: ["title"],
    recommended: ["university", "date"],
  },
  conferencePaper: {
    required: ["title"],
    recommended: ["proceedingsTitle", "date"],
  },
  report: {
    required: ["title"],
    recommended: ["institution", "date", "reportNumber"],
  },
  webpage: {
    required: ["title"],
    recommended: ["url", "accessDate"],
  },
};

/**
 * 区分附件文件本地状态（绝对不暴露 filePath 绝对路径，不进行自动下载或修复）
 */
export function determineAttachmentFileStatus(attachment: any): {
  status: "available" | "linked_url" | "not_local" | "missing";
  details?: string;
} {
  const linkMode = attachment.attachmentLinkMode;

  // 1. 纯 URL 链接附件
  const LINK_MODE_LINKED_URL =
    typeof Zotero !== "undefined" &&
    Zotero.Attachments?.LINK_MODE_LINKED_URL !== undefined
      ? Zotero.Attachments.LINK_MODE_LINKED_URL
      : 3;

  if (linkMode === LINK_MODE_LINKED_URL) {
    return { status: "linked_url", details: "纯网络链接附件，无需本地文件" };
  }

  // 2. 检查本地文件是否存在
  let fileExists = false;
  try {
    if (typeof attachment.fileExists === "function") {
      fileExists = attachment.fileExists();
    }
  } catch {
    fileExists = false;
  }

  if (fileExists) {
    return { status: "available" };
  }

  // 3. 文件不存在于本地磁盘，判断是按需同步未下载还是真正丢失
  // Zotero 7/9 中，存储型附件如果启用了按需下载或未同步到本地：
  // attachment.isStoredFileAttachment()，且同步服务器有该文件版本但本地文件未缓存
  let isStored = false;
  try {
    if (typeof attachment.isStoredFileAttachment === "function") {
      isStored = attachment.isStoredFileAttachment();
    }
  } catch {
    isStored = false;
  }

  const syncState = attachment.syncState;
  const isPendingDownload =
    attachment.attachmentSynced === false ||
    attachment.downloadState === "pending" ||
    attachment.isDownloaded === false ||
    (isStored && syncState !== undefined && syncState !== 0);

  if (isPendingDownload) {
    return {
      status: "not_local",
      details: "附件已在云端记录，但尚未按需下载到本地客户端",
    };
  }

  return {
    status: "missing",
    details: "本地对应存储目录中未找到文件",
  };
}

/**
 * 检查条目的元数据缺失项
 */
export function checkItemMetadataDeficiencies(item: any): {
  missingRequired: string[];
  missingRecommended: string[];
  missingCreators: boolean;
} {
  const itemType = item.itemType || "";
  const rule = TYPE_DEFICIENCY_RULES[itemType] || {
    required: ["title"],
    recommended: [],
  };

  const getF = (f: string) => (item.getField ? item.getField(f) : item[f]);

  const missingRequired: string[] = [];
  for (const field of rule.required) {
    const val = getF(field);
    if (!val || (typeof val === "string" && val.trim() === "")) {
      missingRequired.push(field);
    }
  }

  const missingRecommended: string[] = [];
  for (const field of rule.recommended) {
    const val = getF(field);
    if (!val || (typeof val === "string" && val.trim() === "")) {
      missingRecommended.push(field);
    }
  }

  let missingCreators = false;
  if (typeof item.getCreators === "function") {
    const creators = item.getCreators();
    missingCreators = !Array.isArray(creators) || creators.length === 0;
  }

  return {
    missingRequired,
    missingRecommended,
    missingCreators,
  };
}

/**
 * libraryHealth:
 * - 统一扫描参数：maxItems（本次扫描预算）、offset（扫描起点）、collectionKey
 * - 只读统计 standalone PDF / info
 * - 按类型元数据明显缺项
 * - 文件本地 missing / notlocal / unavailable / linkedURL 区别（未下载不误报永久丢失）
 * - duplicate 候选 (复用 findDuplicates，注明未全量扫描时不夸大跨分页重复检测)
 * - tasks interrupted / needs_review
 * - 扫描覆盖说明 complete / scannedCount / totalEstimated
 * - 建议后续预览 tool
 * - 绝不暴露 filePath，不自动联网下载、relink、repair
 */
export async function libraryHealth(
  args: JsonObject = {},
  taskSummary?: JsonObject,
): Promise<JsonObject> {
  const libraryID = requireLibraryID(args.libraryID);
  const collectionKey = args.collectionKey;
  const maxItems = Math.min(
    Math.max(Number(args.maxItems ?? args.budget) || DEFAULT_HEALTH_BUDGET, 1),
    10000,
  );
  const offset = Math.max(Number(args.offset) || 0, 0);
  const includeDuplicates = args.includeDuplicates !== false;

  if (typeof Zotero === "undefined") {
    throw new PlusError("INTERNAL_ERROR", "Zotero runtime unavailable");
  }

  // 获取目标条目（若指定 collectionKey 则仅获取集合内条目，否则获取整个文库条目）
  let allItems: any[] = [];
  if (collectionKey) {
    const col = Zotero.Collections?.getByLibraryAndKey
      ? Zotero.Collections.getByLibraryAndKey(libraryID, collectionKey)
      : await Zotero.Collections?.getByLibraryAndKeyAsync?.(
          libraryID,
          collectionKey,
        );
    if (!col) {
      throw new PlusError(
        "COLLECTION_NOT_FOUND",
        `Collection [${collectionKey}] 不存在`,
      );
    }
    const itemIDs = col.getChildItems ? col.getChildItems() : [];
    if (Zotero.Items?.getAsync) {
      allItems = await Zotero.Items.getAsync(itemIDs);
    } else if (Zotero.Items?.get) {
      allItems = itemIDs.map((id: number) => Zotero.Items.get(id));
    }
  } else {
    if (Zotero.Items?.getAll) {
      allItems = await Zotero.Items.getAll(libraryID, false, false, true);
    }
  }

  const validItems = (allItems || []).filter((it: any) => it && !it.deleted);
  const totalCount = validItems.length;

  const slice = validItems.slice(offset, offset + maxItems);
  const scannedCount = slice.length;
  const isFullScan = offset === 0 && scannedCount >= totalCount;
  const reachedEnd = offset + scannedCount >= totalCount;
  const nextOffset = reachedEnd ? undefined : offset + scannedCount;

  const coverageNote = isFullScan
    ? `已完成${collectionKey ? `指定集合 [${collectionKey}]` : "文库"}内全部有效条目的健康检查。`
    : `本次健康检查仅覆盖条目区间 [${offset}, ${offset + scannedCount})。${
        reachedEnd
          ? "已扫描至条目列表末尾，但因本次扫描存在非零偏移量，分页遍历仍无法检测跨越不同分页的条目关联或重复项，不能宣称全库已完全检查。"
          : `达到 maxItems (${maxItems}) 预算上限，尚未完成全量覆盖。`
      }`;

  // 1. Standalone 附件统计（尝试复用 standaloneService 若存在，否则自身只读快速汇总）
  let standalonePDFsCount = 0;
  const standalonePDFSamples: string[] = [];
  let standaloneOtherCount = 0;
  const standaloneOtherSamples: string[] = [];

  // 2. 附件文件可用性统计
  const fileStatusSummary = {
    available: 0,
    linked_url: 0,
    not_local: 0,
    missing: 0,
  };
  const missingFileSamples: Array<{
    key: string;
    filename?: string;
    reason?: string;
  }> = [];
  const notLocalFileSamples: Array<{
    key: string;
    filename?: string;
    reason?: string;
  }> = [];

  // 3. 元数据缺项统计
  const metadataDeficiencies = {
    totalRegularItems: 0,
    itemsWithMissingRequired: 0,
    itemsWithMissingRecommended: 0,
    itemsWithMissingCreators: 0,
    byType: {} as Record<
      string,
      { total: number; missingRequired: number; missingRecommended: number }
    >,
    samples: [] as Array<{
      key: string;
      itemType: string;
      missingRequired: string[];
      missingRecommended: string[];
      missingCreators: boolean;
    }>,
  };

  for (const item of slice) {
    const isAttachment =
      typeof item.isAttachment === "function"
        ? item.isAttachment()
        : item.itemType === "attachment";
    const isRegular =
      typeof item.isRegularItem === "function"
        ? item.isRegularItem()
        : item.itemType &&
          !["attachment", "note", "annotation"].includes(item.itemType);

    if (isAttachment) {
      // 检查是否为独立附件
      const isStandalone = !item.parentItemID && !item.parentItemKey;
      if (isStandalone) {
        if (isPDFAttachment(item)) {
          standalonePDFsCount++;
          if (standalonePDFSamples.length < 10)
            standalonePDFSamples.push(item.key);
        } else {
          standaloneOtherCount++;
          if (standaloneOtherSamples.length < 10)
            standaloneOtherSamples.push(item.key);
        }
      }

      // 文件状态判定
      const fileStat = determineAttachmentFileStatus(item);
      fileStatusSummary[fileStat.status]++;

      const attFilename = item.attachmentFilename || item.filename;

      if (fileStat.status === "missing" && missingFileSamples.length < 10) {
        missingFileSamples.push({
          key: item.key,
          filename: attFilename,
          reason: fileStat.details,
        });
      } else if (
        fileStat.status === "not_local" &&
        notLocalFileSamples.length < 10
      ) {
        notLocalFileSamples.push({
          key: item.key,
          filename: attFilename,
          reason: fileStat.details,
        });
      }
    } else if (isRegular) {
      metadataDeficiencies.totalRegularItems++;
      const itemType = item.itemType || "unknown";

      if (!metadataDeficiencies.byType[itemType]) {
        metadataDeficiencies.byType[itemType] = {
          total: 0,
          missingRequired: 0,
          missingRecommended: 0,
        };
      }
      metadataDeficiencies.byType[itemType].total++;

      const check = checkItemMetadataDeficiencies(item);
      let isProblematic = false;

      if (check.missingRequired.length > 0) {
        metadataDeficiencies.itemsWithMissingRequired++;
        metadataDeficiencies.byType[itemType].missingRequired++;
        isProblematic = true;
      }
      if (check.missingRecommended.length > 0) {
        metadataDeficiencies.itemsWithMissingRecommended++;
        metadataDeficiencies.byType[itemType].missingRecommended++;
        isProblematic = true;
      }
      if (check.missingCreators) {
        metadataDeficiencies.itemsWithMissingCreators++;
        isProblematic = true;
      }

      if (isProblematic && metadataDeficiencies.samples.length < 15) {
        metadataDeficiencies.samples.push({
          key: item.key,
          itemType,
          missingRequired: check.missingRequired,
          missingRecommended: check.missingRecommended,
          missingCreators: check.missingCreators,
        });
      }
    }
  }

  // 4. 重复项候选统计（调用 findDuplicates，传递真正的 scope / maxItems / offset）
  let duplicateGroupsCount = 0;
  let duplicateItemsCount = 0;
  let duplicateCandidatesSummary: any[] = [];
  let duplicateCoverage: any = null;

  if (includeDuplicates) {
    try {
      const dupRes = await findDuplicates({
        libraryID,
        collectionKey,
        maxItems,
        offset,
      });
      duplicateCoverage = dupRes.coverage || {
        complete: dupRes.complete,
        scannedCount: dupRes.scannedCount,
        offset,
        reachedEnd: dupRes.complete,
      };
      if (Array.isArray(dupRes.groups)) {
        duplicateGroupsCount = dupRes.groups.length;
        duplicateItemsCount = dupRes.groups.reduce(
          (acc: number, g: any) => acc + (g.itemKeys ? g.itemKeys.length : 0),
          0,
        );
        duplicateCandidatesSummary = dupRes.groups
          .slice(0, 5)
          .map((g: any) => ({
            masterKeyCandidate: g.masterKeyCandidate,
            count: g.itemKeys.length,
            matchReason: g.matchReason,
            confidence: g.confidence,
          }));
      }
    } catch {
      // 忽略重复项扫描错误，保持整体健康检查稳健
    }
  }

  const duplicateCoverageNote = includeDuplicates
    ? duplicateCoverage?.note ||
      (isFullScan
        ? "已完成指定范围内的重复项检测。"
        : `重复项检测仅覆盖当前窗口区间 [${offset}, ${offset + scannedCount})。跨分页或未扫描条目的潜在重复项未被检测，以 duplicateCandidates.coverage 为准。`)
    : "本次健康检查未开启重复项检测。";

  // 5. 任务中断与待核查统计 (Tasks Interrupted / Needs Review)
  const taskStatus = {
    interruptedCount: 0,
    needsReviewCount: 0,
    details: undefined as any,
  };

  if (taskSummary && typeof taskSummary === "object") {
    taskStatus.interruptedCount = Number(taskSummary.interruptedCount) || 0;
    taskStatus.needsReviewCount = Number(taskSummary.needsReviewCount) || 0;
    taskStatus.details = taskSummary.details;
  }

  // 6. 建议后续工具映射
  const suggestedTools: Array<{ tool: string; reason: string }> = [];

  if (standalonePDFsCount > 0) {
    suggestedTools.push({
      tool: "recognize_pdfs",
      reason: `文库中存在 ${standalonePDFsCount} 个未挂接父条目的独立 PDF 文件，建议运行 recognize_pdfs 进行识别与父条目创建`,
    });
  }
  if (duplicateGroupsCount > 0) {
    suggestedTools.push({
      tool: "merge_items",
      reason: `文库中检测到 ${duplicateGroupsCount} 组重复候选条目（共计 ${duplicateItemsCount} 项），建议使用 merge_items 进行安全合并`,
    });
  }
  if (taskStatus.interruptedCount > 0 || taskStatus.needsReviewCount > 0) {
    suggestedTools.push({
      tool: "task_control",
      reason: `当前存在 ${taskStatus.interruptedCount} 个中断任务及 ${taskStatus.needsReviewCount} 个待人工核查任务，建议使用 task_control 进行状态审查`,
    });
  }

  return {
    libraryID,
    collectionKey: collectionKey || null,
    coverage: {
      complete: isFullScan,
      reachedEnd,
      scannedCount,
      totalEstimated: totalCount,
      offset,
      nextOffset,
      maxItems,
      note: coverageNote,
      paging: {
        budget: maxItems,
        maxItems,
        offset,
        nextOffset,
      },
    },
    standaloneAttachments: {
      pdfCount: standalonePDFsCount,
      pdfSamples: standalonePDFSamples,
      otherCount: standaloneOtherCount,
      otherSamples: standaloneOtherSamples,
    },
    attachmentFiles: {
      summary: fileStatusSummary,
      missingSamples: missingFileSamples,
      notLocalSamples: notLocalFileSamples,
      note: "未同步到本地的附件归为 not_local，不属于数据损坏；检查过程绝不联网自动下载",
    },
    metadataDeficiencies,
    duplicateCandidates: {
      groupsCount: duplicateGroupsCount,
      itemsCount: duplicateItemsCount,
      samples: duplicateCandidatesSummary,
      coverage: duplicateCoverage,
      coverageNote: duplicateCoverageNote,
    },
    tasks: taskStatus,
    suggestedTools,
  };
}
