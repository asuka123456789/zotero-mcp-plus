import { PlusError, requireLibraryID, type JsonObject } from "./plusTypes.ts";

declare const Zotero: any;
declare const Buffer: any;
declare const IOUtils: any;

export type AttachmentFileStatus =
  | "available"
  | "not_local"
  | "missing"
  | "unavailable"
  | "linked_url";

export interface StandaloneAttachmentItem {
  key: string;
  title: string;
  contentType: string;
  collectionKeys: string[];
  fileStatus: AttachmentFileStatus;
  canRecognize: boolean;
}

export interface FindStandaloneAttachmentsResult {
  items: StandaloneAttachmentItem[];
  complete: boolean;
  total: number;
  scannedCount: number;
  nextCursor?: string;
}

export interface AttachmentAnnotationSnapshot {
  key: string;
  deleted: boolean;
  parentItemID: number | null;
}

const VALID_FILE_STATUSES = new Set<string>([
  "available",
  "not_local",
  "missing",
  "unavailable",
  "linked_url",
]);

/**
 * 提取条目的 collection keys（排序去重）
 * 绝不能回退 String(numericID) 伪造 key；无法解析必须明确抛错阻断预览。
 */
export function getItemCollectionKeys(item: any): string[] {
  if (!item || typeof item.getCollections !== "function") return [];
  const colls = item.getCollections();
  if (!Array.isArray(colls)) return [];
  const keys: string[] = [];

  for (const c of colls) {
    if (typeof c === "string") {
      if (/^[A-Z0-9]{8}$/.test(c)) {
        keys.push(c);
        continue;
      }
    } else if (typeof c === "number") {
      if (typeof Zotero !== "undefined" && Zotero.Collections) {
        if (typeof Zotero.Collections.getLibraryAndKeyFromID === "function") {
          const info = Zotero.Collections.getLibraryAndKeyFromID(c);
          if (info?.key && /^[A-Z0-9]{8}$/.test(info.key)) {
            keys.push(info.key);
            continue;
          }
        }
        if (typeof Zotero.Collections.get === "function") {
          const coll = Zotero.Collections.get(c);
          if (coll?.key && /^[A-Z0-9]{8}$/.test(coll.key)) {
            keys.push(coll.key);
            continue;
          }
        }
      }
    }
    // 无法解析为有效 8 位集合 key 时，绝不能回退 String(numericID) 伪造！
    throw new PlusError(
      "COLLECTION_KEY_UNRESOLVED",
      `条目 [${item.key || item.id}] 关联的集合标识 [${c}] 无法解析为有效 8 位集合 key`,
    );
  }

  return [...new Set(keys)].sort();
}

/**
 * 获取附件的批注快照（原生 getAnnotations(true) 默认返回 item 对象，true, true 返回 numericIDs）
 */
export async function getAttachmentAnnotationSnapshots(
  item: any,
): Promise<AttachmentAnnotationSnapshot[]> {
  if (!item || typeof item.getAnnotations !== "function") return [];
  try {
    const annots = item.getAnnotations(true);
    if (!Array.isArray(annots)) return [];
    const results: AttachmentAnnotationSnapshot[] = [];
    for (const a of annots) {
      if (!a) continue;
      if (typeof a.reload === "function") {
        try {
          await a.reload(undefined, true);
        } catch {
          // ignore
        }
      }
      results.push({
        key: a.key,
        deleted: Boolean(a.deleted),
        parentItemID:
          a.parentItemID !== undefined
            ? a.parentItemID
            : a.parentItem
              ? a.parentItem.id
              : null,
      });
    }
    return results.sort((x, y) => x.key.localeCompare(y.key));
  } catch {
    return [];
  }
}

/**
 * 获取附件本地文件实际尺寸与修改时间（用于指纹感知文件篡改与替换）
 */
export async function getAttachmentFileStats(
  item: any,
): Promise<{ size: number | null; mtime: number | null }> {
  if (!item) return { size: null, mtime: null };
  try {
    let path: string | null = null;
    if (typeof item.getFilePathAsync === "function") {
      path = await item.getFilePathAsync();
    } else if (typeof item.getFilePath === "function") {
      path = item.getFilePath();
    }
    if (path) {
      if (
        typeof IOUtils !== "undefined" &&
        typeof IOUtils.stat === "function"
      ) {
        const stat = await IOUtils.stat(path);
        return {
          size: typeof stat.size === "number" ? stat.size : null,
          mtime:
            typeof stat.lastModified === "number" ? stat.lastModified : null,
        };
      }
    }
  } catch {
    // ignore
  }

  const size =
    typeof item.fileSize === "number"
      ? item.fileSize
      : typeof item.attachmentSize === "number"
        ? item.attachmentSize
        : null;
  const mtime =
    typeof item.fileMtime === "number"
      ? item.fileMtime
      : typeof item.attachmentSyncedModificationTime === "number"
        ? item.attachmentSyncedModificationTime
        : null;

  return { size, mtime };
}

/**
 * 判断条目是否为 PDF 附件
 */
export function isPDFAttachment(item: any): boolean {
  if (!item) return false;
  if (typeof item.isPDFAttachment === "function") {
    return item.isPDFAttachment();
  }
  const ct = (
    item.attachmentContentType ||
    item.contentType ||
    ""
  ).toLowerCase();
  if (ct === "application/pdf") return true;
  const filename = (
    item.attachmentFilename ||
    item.filename ||
    ""
  ).toLowerCase();
  return filename.endsWith(".pdf");
}

/**
 * 确定附件文件状态（不触发下载，不写文件路径，区分 not_local, missing, unavailable, linked_url）
 */
export async function determineAttachmentFileStatus(
  item: any,
): Promise<AttachmentFileStatus> {
  const linkMode = item.attachmentLinkMode;

  const LINK_MODE_LINKED_URL =
    typeof Zotero !== "undefined" &&
    Zotero.Attachments?.LINK_MODE_LINKED_URL !== undefined
      ? Zotero.Attachments.LINK_MODE_LINKED_URL
      : 3;

  if (
    linkMode === LINK_MODE_LINKED_URL ||
    (typeof item.isLinkedURLAttachment === "function" &&
      item.isLinkedURLAttachment())
  ) {
    return "linked_url";
  }

  let fileExists = false;
  try {
    if (typeof item.fileExists === "function") {
      fileExists = await item.fileExists();
    } else if (typeof item.fileExistsCached === "function") {
      const cached = item.fileExistsCached();
      fileExists = cached === null ? false : Boolean(cached);
    }
  } catch (_err) {
    return "unavailable";
  }

  if (fileExists) {
    return "available";
  }

  // 本地文件未命中，判断是待同步未下载 (not_local) 还是本地缺失 (missing)
  let isStored = false;
  try {
    if (typeof item.isStoredFileAttachment === "function") {
      isStored = item.isStoredFileAttachment();
    } else {
      isStored = linkMode === 0 || linkMode === 1; // IMPORTED_FILE or IMPORTED_URL
    }
  } catch {
    isStored = false;
  }

  const syncState =
    item.attachmentSyncState !== undefined
      ? item.attachmentSyncState
      : item.syncState;
  const SYNC_STATE_TO_DOWNLOAD =
    typeof Zotero !== "undefined" &&
    Zotero.Sync?.Storage?.Local?.SYNC_STATE_TO_DOWNLOAD !== undefined
      ? Zotero.Sync.Storage.Local.SYNC_STATE_TO_DOWNLOAD
      : 1;
  const SYNC_STATE_FORCE_DOWNLOAD =
    typeof Zotero !== "undefined" &&
    Zotero.Sync?.Storage?.Local?.SYNC_STATE_FORCE_DOWNLOAD !== undefined
      ? Zotero.Sync.Storage.Local.SYNC_STATE_FORCE_DOWNLOAD
      : 4;

  const isPendingDownload =
    item.attachmentSynced === false ||
    item.downloadState === "pending" ||
    item.isDownloaded === false ||
    (isStored &&
      (syncState === SYNC_STATE_TO_DOWNLOAD ||
        syncState === SYNC_STATE_FORCE_DOWNLOAD ||
        syncState === "to_download"));

  if (isPendingDownload) {
    return "not_local";
  }

  return "missing";
}

/**
 * 检查附件是否符合 Zotero 原生元数据识别要求
 */
export function canRecognizeAttachment(
  item: any,
  fileStatus: AttachmentFileStatus,
): boolean {
  if (!isPDFAttachment(item)) return false;
  const isStandalone =
    typeof item.isTopLevelItem === "function"
      ? item.isTopLevelItem()
      : !item.parentItemID && !item.parentItem;
  if (!isStandalone) return false;
  if (fileStatus !== "available") return false;
  if (typeof Zotero !== "undefined" && Zotero.RecognizeDocument?.canRecognize) {
    try {
      return Zotero.RecognizeDocument.canRecognize(item);
    } catch {
      return false;
    }
  }
  return true;
}

function encodeCursor(offset: number): string {
  const json = JSON.stringify({ offset });
  if (typeof Buffer !== "undefined") {
    return Buffer.from(json, "utf8").toString("base64");
  }
  if (typeof btoa !== "undefined") {
    return btoa(unescape(encodeURIComponent(json)));
  }
  return String(offset);
}

function decodeCursor(cursor: string): number {
  try {
    let json = "";
    if (typeof Buffer !== "undefined") {
      json = Buffer.from(cursor, "base64").toString("utf8");
    } else if (typeof atob !== "undefined") {
      json = decodeURIComponent(escape(atob(cursor)));
    }
    if (json) {
      const parsed = JSON.parse(json);
      if (
        typeof parsed.offset === "number" &&
        Number.isInteger(parsed.offset) &&
        parsed.offset >= 0
      ) {
        return parsed.offset;
      }
    }
  } catch {
    const n = parseInt(cursor, 10);
    if (!isNaN(n) && n >= 0) return n;
  }
  throw new PlusError("INVALID_ARGUMENT", "无效的游标 (cursor)");
}

function getItemSortValue(item: any, sort: string): string | number {
  if (sort === "key") return item.key || "";
  if (sort === "title") {
    return (
      (typeof item.getField === "function"
        ? item.getField("title")
        : item.title) ||
      item.attachmentFilename ||
      item.key ||
      ""
    ).toLowerCase();
  }
  if (sort === "dateAdded") return item.dateAdded || "";
  if (sort === "dateModified") return item.dateModified || "";
  if (typeof item.getField === "function") {
    try {
      const val = item.getField(sort);
      if (val !== undefined && val !== null) return String(val).toLowerCase();
    } catch {
      // ignore
    }
  }
  return item[sort] !== undefined ? String(item[sort]).toLowerCase() : "";
}

/**
 * 查找尚无父条目的独立附件（默认仅 PDF standalone，稳定分页，不暴露绝对路径）
 * options.pdfOnly = false 供旧 search_library 的通用独立 attachment 分支兼容保留非 PDF。
 */
export async function findStandaloneAttachments(
  args: JsonObject,
  options?: { pdfOnly?: boolean },
): Promise<JsonObject> {
  const libraryID = requireLibraryID(args.libraryID);
  const pdfOnly = options?.pdfOnly !== false;

  // 1. 集合校验（严格保持传 object key 校验）
  if (args.collectionKey !== undefined) {
    if (
      typeof args.collectionKey !== "string" ||
      !/^[A-Z0-9]{8}$/.test(args.collectionKey)
    ) {
      throw new PlusError("INVALID_ARGUMENT", "collectionKey 格式无效");
    }
    if (typeof Zotero !== "undefined" && Zotero.Collections) {
      let coll: any = null;
      if (typeof Zotero.Collections.getByLibraryAndKeyAsync === "function") {
        coll = await Zotero.Collections.getByLibraryAndKeyAsync(
          libraryID,
          args.collectionKey,
        );
      } else if (typeof Zotero.Collections.getByLibraryAndKey === "function") {
        coll = Zotero.Collections.getByLibraryAndKey(
          libraryID,
          args.collectionKey,
        );
      }
      if (!coll) {
        throw new PlusError(
          "COLLECTION_NOT_FOUND",
          `指定的集合 [${args.collectionKey}] 不存在`,
        );
      }
    }
  }

  // 2. 文件状态参数校验
  const targetFileStatus =
    typeof args.fileStatus === "string" && args.fileStatus.trim()
      ? args.fileStatus.trim()
      : undefined;
  if (targetFileStatus && !VALID_FILE_STATUSES.has(targetFileStatus)) {
    throw new PlusError(
      "INVALID_ARGUMENT",
      `不支持的 fileStatus: ${targetFileStatus}`,
    );
  }

  // 3. 排序与方向校验
  const sortField =
    typeof args.sort === "string" && args.sort.trim()
      ? args.sort.trim()
      : "dateAdded";
  const direction =
    typeof args.direction === "string" ? args.direction.toLowerCase() : "asc";
  if (direction !== "asc" && direction !== "desc") {
    throw new PlusError("INVALID_ARGUMENT", "direction 必须为 asc 或 desc");
  }

  // 4. 分页参数校验
  let limit = 50;
  if (args.limit !== undefined) {
    const parsed = Number(args.limit);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
      throw new PlusError(
        "INVALID_ARGUMENT",
        "limit 必须为 1 到 100 之间的整数",
      );
    }
    limit = parsed;
  }

  let offset = 0;
  if (args.cursor !== undefined) {
    if (typeof args.cursor !== "string" || !args.cursor.trim()) {
      throw new PlusError("INVALID_ARGUMENT", "cursor 必须是非空字符串");
    }
    offset = decodeCursor(args.cursor.trim());
  } else if (args.offset !== undefined) {
    const parsed = Number(args.offset);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new PlusError("INVALID_ARGUMENT", "offset 必须是非负整数");
    }
    offset = parsed;
  }

  // 5. 组合查询（可使用 Zotero.Search，不绕过 collection/fulltext/tag）
  const queryText = (
    typeof args.query === "string"
      ? args.query
      : typeof args.q === "string"
        ? args.q
        : ""
  ).trim();
  const fulltextQuery =
    typeof args.fulltext === "string" ? args.fulltext.trim() : "";
  const tagQuery = typeof args.tag === "string" ? args.tag.trim() : "";

  let rawItems: any[] = [];
  let scannedCount = 0;
  let usedZoteroSearch = false;

  if (typeof Zotero !== "undefined" && typeof Zotero.Search === "function") {
    usedZoteroSearch = true;
    const s = new Zotero.Search();
    s.libraryID = libraryID;
    s.addCondition("itemType", "is", "attachment");

    if (args.collectionKey) {
      s.addCondition("collection", "is", args.collectionKey);
    }

    if (fulltextQuery) {
      s.addCondition("fulltextContent", "contains", fulltextQuery);
    }

    if (queryText) {
      s.addCondition("quicksearch-everything", "contains", queryText);
    }

    if (tagQuery) {
      s.addCondition("tag", "contains", tagQuery);
    }

    let ids: number[] = [];
    try {
      ids = await s.search();
    } catch (err: any) {
      throw new PlusError(
        "SEARCH_FAILED",
        `Zotero 搜索失败: ${err.message || String(err)}`,
      );
    }

    scannedCount = ids.length;
    if (ids.length > 0) {
      if (typeof Zotero.Items?.getAsync === "function") {
        rawItems = await Zotero.Items.getAsync(ids);
      } else if (typeof Zotero.Items?.get === "function") {
        rawItems = ids.map((id) => Zotero.Items.get(id)).filter(Boolean);
      }
    }
  } else if (typeof Zotero !== "undefined" && Zotero.Items) {
    // 兼容单元测试 mock 环境（若未注册完整 Zotero.Search 类）
    let all: any[] = [];
    if (typeof Zotero.Items.getAll === "function") {
      all = await Zotero.Items.getAll(libraryID);
    } else if (typeof Zotero.Items.getAsync === "function") {
      all = await Zotero.Items.getAsync();
    }
    scannedCount = all.length;
    rawItems = all;
  }

  // 6. 内存过滤出独立条目并应用条件
  const filteredItems: any[] = [];

  for (const item of rawItems) {
    if (!item) continue;
    if (item.libraryID !== libraryID) continue;
    if (item.deleted) continue;

    // 必须确保是附件（尤其在 pdfOnly: false 兼容模式下，绝不能把 regular item 当独立附件）
    const isAttachment =
      typeof item.isAttachment === "function"
        ? item.isAttachment()
        : item.itemType === "attachment";
    if (!isAttachment) continue;

    // 独立附件过滤：不能有父条目
    const isStandalone =
      typeof item.isTopLevelItem === "function"
        ? item.isTopLevelItem()
        : !item.parentItemID && !item.parentItem;
    if (!isStandalone) continue;

    // 根据 options.pdfOnly 判定是否限定 PDF（默认 true）
    if (pdfOnly && !isPDFAttachment(item)) continue;

    // 集合过滤对账（双重保障）
    if (args.collectionKey) {
      try {
        const collKeys = getItemCollectionKeys(item);
        if (!collKeys.includes(args.collectionKey)) continue;
      } catch {
        continue;
      }
    }

    // 文本与标签对账：仅在未使用 Zotero.Search 的 fallback 模式下需要内存过滤，
    // 避免在原生 quicksearch-everything / tag 搜索后再行标题收窄而抹掉全文/作者命中
    if (!usedZoteroSearch) {
      if (queryText && !fulltextQuery) {
        const title =
          (typeof item.getField === "function"
            ? item.getField("title")
            : item.title) ||
          item.attachmentFilename ||
          item.key ||
          "";
        const qLower = queryText.toLowerCase();
        if (
          !title.toLowerCase().includes(qLower) &&
          !(item.key || "").toLowerCase().includes(qLower)
        ) {
          continue;
        }
      }

      if (tagQuery) {
        const tags = typeof item.getTags === "function" ? item.getTags() : [];
        const hasTag = tags.some((t: any) =>
          (typeof t === "string" ? t : t.tag || "")
            .toLowerCase()
            .includes(tagQuery.toLowerCase()),
        );
        if (!hasTag) continue;
      }
    }

    // 文件状态检查与过滤
    const status = await determineAttachmentFileStatus(item);
    if (targetFileStatus && status !== targetFileStatus) {
      continue;
    }

    // 暂存计算属性
    item._computedFileStatus = status;
    item._computedCanRecognize = canRecognizeAttachment(item, status);
    filteredItems.push(item);
  }

  const total = filteredItems.length;

  // 7. 稳定排序（以 key 作为 tiebreaker）
  const mult = direction === "desc" ? -1 : 1;
  filteredItems.sort((a, b) => {
    const valA = getItemSortValue(a, sortField);
    const valB = getItemSortValue(b, sortField);
    if (valA < valB) return -1 * mult;
    if (valA > valB) return 1 * mult;
    // 稳定排序 tiebreaker: key 升序
    if (a.key < b.key) return -1;
    if (a.key > b.key) return 1;
    return 0;
  });

  // 8. 切片分页
  const pagedItems = filteredItems.slice(offset, offset + limit);
  const complete = offset + pagedItems.length >= total;
  const nextCursor = !complete
    ? encodeCursor(offset + pagedItems.length)
    : undefined;

  // 9. 构建安全返回结构（不暴露绝对路径）
  const items: StandaloneAttachmentItem[] = pagedItems.map((item) => {
    let collKeys: string[] = [];
    try {
      collKeys = getItemCollectionKeys(item);
    } catch {
      collKeys = [];
    }

    return {
      key: item.key,
      title:
        (typeof item.getField === "function"
          ? item.getField("title")
          : item.title) ||
        item.attachmentFilename ||
        item.key,
      contentType:
        item.attachmentContentType ||
        item.contentType ||
        "application/octet-stream",
      collectionKeys: collKeys,
      fileStatus: item._computedFileStatus,
      canRecognize: item._computedCanRecognize,
    };
  });

  return {
    items,
    complete,
    total,
    scannedCount: Math.max(scannedCount, total),
    ...(nextCursor ? { nextCursor } : {}),
  };
}
