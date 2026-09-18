import {
  type JsonObject,
  type OperationAdapter,
  type OperationPlan,
  type PlanStep,
  type StepOutcome,
  type ExecutionContext,
  type TargetRef,
  PlusError,
  requireLibraryID,
  requireWritable,
  fingerprint,
  secureID,
  targetID,
} from "./plusTypes.ts";

declare const Zotero: any;
declare const ChromeUtils: any;

export const MAX_MERGE_GROUPS = 20;
export const MAX_TOTAL_MERGE_ITEMS = 100;

export const SYSTEM_FORBIDDEN_FIELDS = new Set([
  "id",
  "itemID",
  "key",
  "itemKey",
  "libraryID",
  "itemType",
  "itemTypeID",
  "dateAdded",
  "dateModified",
  "clientDateModified",
  "deleted",
  "version",
  "synced",
  "accessDate",
]);

// 常见的顶级标准字段集合，用于在离线或测试环境中辅助校验书目字段合法性
export const KNOWN_BIBLIOGRAPHIC_FIELDS = new Set([
  "title",
  "abstractNote",
  "date",
  "publicationTitle",
  "journalAbbreviation",
  "volume",
  "issue",
  "pages",
  "series",
  "seriesTitle",
  "seriesText",
  "seriesNumber",
  "publisher",
  "place",
  "language",
  "ISBN",
  "ISSN",
  "shortTitle",
  "url",
  "accessDate",
  "archive",
  "archiveLocation",
  "libraryCatalog",
  "callNumber",
  "rights",
  "extra",
  "DOI",
  "university",
  "thesisType",
  "reportNumber",
  "reportType",
  "conferenceName",
  "proceedingsTitle",
  "edition",
  "numPages",
  "section",
  "bookTitle",
]);

/**
 * 规范化 DOI：只去已知前缀、trim、大小写归一。
 * 注意：保留合法尾部字符（包括 ')', ';', 等），绝不无条件剥离合法尾部标点，避免合错候选。
 */
export function normalizeDOI(doi: unknown): string | null {
  if (typeof doi !== "string") return null;
  let s = doi.trim();
  if (!s) return null;

  // 去除 http/https url 前缀
  s = s.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
  // 去除 doi: 前缀
  s = s.replace(/^doi:\s*/i, "");
  s = s.trim();

  // 标准 DOI 结构以 10. 开头且至少包含一个斜杠
  const match = s.match(/^10\.\d{4,9}\/\S+$/);
  if (!match) return null;

  return s.toLowerCase();
}

/**
 * 规范化 ISBN：清除连字符与空格，支持 ISBN-10 校验并转为 ISBN-13，支持 ISBN-13 校验
 */
export function normalizeISBN(isbn: unknown): string | null {
  if (typeof isbn !== "string") return null;
  const s = isbn.replace(/[-\s]/g, "").toUpperCase();
  if (!s) return null;

  if (s.length === 10) {
    // 校验 ISBN-10
    if (!/^\d{9}[\dX]$/.test(s)) return null;
    let sum = 0;
    for (let i = 0; i < 9; i++) {
      sum += parseInt(s[i], 10) * (10 - i);
    }
    const lastChar = s[9];
    sum += lastChar === "X" ? 10 : parseInt(lastChar, 10);
    if (sum % 11 !== 0) return null;

    // 转换为 ISBN-13（前缀 978 并重算校验位）
    const body = "978" + s.substring(0, 9);
    let sum13 = 0;
    for (let i = 0; i < 12; i++) {
      sum13 += parseInt(body[i], 10) * (i % 2 === 0 ? 1 : 3);
    }
    const checkDigit = (10 - (sum13 % 10)) % 10;
    return body + checkDigit.toString();
  }

  if (s.length === 13) {
    if (!/^\d{13}$/.test(s)) return null;
    let sum = 0;
    for (let i = 0; i < 12; i++) {
      sum += parseInt(s[i], 10) * (i % 2 === 0 ? 1 : 3);
    }
    const checkDigit = (10 - (sum % 10)) % 10;
    if (parseInt(s[12], 10) !== checkDigit) return null;
    return s;
  }

  return null;
}

/**
 * 规范化标题：去除两端空格、转小写、去除标点符号与多余空格
 */
export function normalizeTitle(title: unknown): string {
  if (typeof title !== "string") return "";
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 提取年份
 */
export function extractYear(date: unknown): string | null {
  if (typeof date !== "string") return null;
  const match = date.match(/\b(19\d\d|20\d\d)\b/);
  return match ? match[1] : null;
}

/**
 * 提取第一作者姓氏
 */
export function extractFirstAuthorLastName(item: any): string {
  if (typeof item.getCreators !== "function") return "";
  const creators = item.getCreators();
  if (!Array.isArray(creators) || creators.length === 0) return "";
  const first = creators[0];
  if (first.lastName && typeof first.lastName === "string") {
    return first.lastName.trim().toLowerCase();
  }
  if (first.name && typeof first.name === "string") {
    return first.name.trim().toLowerCase();
  }
  return "";
}

/**
 * 判断是否为 PDF 附件
 */
export function isPDFAttachment(attachment: any): boolean {
  if (typeof attachment.isPDFAttachment === "function") {
    return attachment.isPDFAttachment();
  }
  const ct = attachment.attachmentContentType || attachment.contentType || "";
  if (ct === "application/pdf") return true;
  const filename = (
    attachment.attachmentFilename ||
    attachment.filename ||
    ""
  ).toLowerCase();
  return filename.endsWith(".pdf");
}

/**
 * 判断是否为 Web 附件
 */
export function isWebAttachment(attachment: any): boolean {
  if (typeof attachment.isWebAttachment === "function") {
    return attachment.isWebAttachment();
  }
  const ct = attachment.attachmentContentType || attachment.contentType || "";
  if (ct === "text/html" || ct === "application/xhtml+xml") return true;
  if (typeof Zotero !== "undefined" && Zotero.Attachments) {
    const linkMode = attachment.attachmentLinkMode;
    if (
      linkMode === Zotero.Attachments.LINK_MODE_LINKED_URL ||
      linkMode === Zotero.Attachments.LINK_MODE_IMPORTED_URL
    ) {
      return true;
    }
  }
  return false;
}

/**
 * 获取 item（兼容真实 Zotero 环境与 Mock 环境）
 */
async function getItem(libraryID: number, key: string): Promise<any> {
  if (typeof Zotero === "undefined") {
    throw new PlusError("INTERNAL_ERROR", "Zotero runtime unavailable");
  }
  if (Zotero.Items?.getByLibraryAndKeyAsync) {
    return await Zotero.Items.getByLibraryAndKeyAsync(libraryID, key);
  }
  if (Zotero.Items?.getByLibraryAndKey) {
    return Zotero.Items.getByLibraryAndKey(libraryID, key);
  }
  if (Zotero.Items?.getAsync) {
    const item = await Zotero.Items.getAsync(key);
    if (item && item.libraryID === libraryID) return item;
  }
  return null;
}

/**
 * 严格按照 Zotero 原生返回 number[] ID 的契约加载子条目（附件或笔记）
 */
async function getChildItems(
  item: any,
  type: "attachments" | "notes",
  includeDeleted = true,
): Promise<any[]> {
  if (typeof Zotero === "undefined") return [];

  let idsOrItems: any[] = [];
  if (type === "attachments" && typeof item.getAttachments === "function") {
    idsOrItems = item.getAttachments(includeDeleted);
  } else if (type === "notes" && typeof item.getNotes === "function") {
    idsOrItems = item.getNotes(includeDeleted);
  }

  if (!Array.isArray(idsOrItems) || idsOrItems.length === 0) {
    return [];
  }

  // 严格支持 Zotero 原生返回 number[] ID 的契约，通过 getAsync 解析为实体
  if (typeof idsOrItems[0] === "number") {
    if (Zotero.Items?.getAsync) {
      const loaded = await Zotero.Items.getAsync(idsOrItems);
      return Array.isArray(loaded) ? loaded.filter(Boolean) : [];
    }
    if (Zotero.Items?.get) {
      return idsOrItems
        .map((id: number) => Zotero.Items.get(id))
        .filter(Boolean);
    }
  }

  return idsOrItems.filter(Boolean);
}

/**
 * 重新加载 item，调用真正原生 API `await item.reload(undefined, true)`
 * 不 purge/unload 缓存，异常不吞，严格暴露
 */
async function reloadItem(libraryID: number, key: string): Promise<any> {
  if (typeof Zotero === "undefined") return null;
  const item = await getItem(libraryID, key);
  if (!item) return null;
  if (typeof item.reload === "function") {
    await item.reload(undefined, true);
  }
  return item;
}

/**
 * 检查字段名对目标 itemType 是否合法
 */
function isValidBibliographicField(
  fieldName: string,
  itemType: string,
): boolean {
  if (SYSTEM_FORBIDDEN_FIELDS.has(fieldName)) return false;
  if (typeof Zotero !== "undefined" && Zotero.ItemFields && Zotero.ItemTypes) {
    try {
      const fieldID = Zotero.ItemFields.getID(fieldName);
      const itemTypeID = Zotero.ItemTypes.getID(itemType);
      if (fieldID && itemTypeID) {
        return Zotero.ItemFields.isValidForType(fieldID, itemTypeID);
      }
    } catch {
      // fallback
    }
  }
  return KNOWN_BIBLIOGRAPHIC_FIELDS.has(fieldName);
}

/**
 * 获取原生 mergeItems 实现（不外包自身事务）
 * 严格通过 verified chrome module（ChromeUtils.importESModule 或 dynamic import）获取，
 * 绝不回退到未验证的 monkey patched API 或全局后门变量
 */
export async function getNativeMergeFunction(): Promise<
  ((m: any, o: any[]) => Promise<any>) | null
> {
  if (
    typeof ChromeUtils !== "undefined" &&
    typeof (ChromeUtils as any).importESModule === "function"
  ) {
    try {
      const mod = (ChromeUtils as any).importESModule(
        "chrome://zotero/content/mergeItems.mjs",
      );
      if (typeof mod?.mergeItems === "function") {
        return mod.mergeItems;
      }
    } catch {
      // ignore
    }
  }

  try {
    // @ts-expect-error dynamic import of chrome URI
    const mod = await import("chrome://zotero/content/mergeItems.mjs");
    if (typeof mod?.mergeItems === "function") {
      return mod.mergeItems;
    }
  } catch {
    // ignore
  }

  return null;
}

/**
 * 严格后置条件校验：
 * 绝不能仅凭 master 存活且 donors 进回收站就认定合并成功（外部单独 trash donor 绝不表示合并完成）。
 * 必须全项核对：
 * 1. Master 存活且未删除，所有 Donors 均在回收站中；
 * 2. 选定 fieldSources 字段与预期值严格一致；
 * 3. 选定 creatorsSourceKey 的创作者与预期一致；
 * 4. 集合与标签并集完整包含在 Master 中；
 * 5. 所有迁移子项（attachments 和 notes，含 trashed）的 parentItemID 均已指向 Master；
 * 6. 同库入站关系的引用目标已重写为 Master，不再保留指向 Donor 的旧引用。
 */
export async function verifyMergePostconditions(
  step: PlanStep,
): Promise<{ satisfied: boolean; reason?: string }> {
  const { libraryID, masterKey, otherKeys, fieldSources, creatorsSourceKey } =
    step.input;
  const master = await reloadItem(libraryID, masterKey);
  if (!master || master.deleted) {
    return {
      satisfied: false,
      reason: `Master [${masterKey}] 丢失或已在回收站`,
    };
  }

  // 1. Donors 必须全部进入回收站
  for (const ok of otherKeys) {
    const d = await reloadItem(libraryID, ok);
    if (!d || !d.deleted) {
      return { satisfied: false, reason: `Donor [${ok}] 未处于回收站中` };
    }
  }

  // 2. 字段检验
  if (fieldSources && typeof fieldSources === "object") {
    for (const [fieldName, srcKey] of Object.entries(fieldSources)) {
      const expectedVal = step.preview.after?.fields?.[fieldName];
      const currentVal = master.getField
        ? master.getField(fieldName)
        : master[fieldName];
      if (expectedVal !== undefined && currentVal !== expectedVal) {
        return {
          satisfied: false,
          reason: `Master 字段 [${fieldName}] (当前值: ${currentVal}) 与选定期望值 (${expectedVal}) 不符`,
        };
      }
    }
  }

  // 3. 创作者检验
  if (creatorsSourceKey) {
    const expectedCreators = step.preview.after?.creators;
    const currentCreators = master.getCreators ? master.getCreators() : [];
    if (
      expectedCreators &&
      JSON.stringify(currentCreators) !== JSON.stringify(expectedCreators)
    ) {
      return {
        satisfied: false,
        reason: "Master 创作者信息与预期的 creatorsSourceKey 选择不一致",
      };
    }
  }

  // 4. 集合与标签并集检验
  if (Array.isArray(step.preview.after?.collections)) {
    const masterCols = new Set(
      master.getCollections ? master.getCollections() : [],
    );
    for (const c of step.preview.after.collections) {
      if (!masterCols.has(c)) {
        return {
          satisfied: false,
          reason: `Master 集合并集缺失预期的集合 ID [${c}]`,
        };
      }
    }
  }

  if (Array.isArray(step.preview.after?.tags)) {
    const masterTags = new Set(
      (master.getTags ? master.getTags() : []).map((t: any) =>
        typeof t === "string" ? t : t.tag,
      ),
    );
    for (const t of step.preview.after.tags) {
      if (!masterTags.has(t)) {
        return {
          satisfied: false,
          reason: `Master 标签并集缺失预期的标签 [${t}]`,
        };
      }
    }
  }

  // 5. 迁移附件与笔记的 parent 挂接检验
  const expectedAttachments = step.preview.reparentAttachments || [];
  for (const attInfo of expectedAttachments) {
    const att = await reloadItem(libraryID, attInfo.key);
    if (!att) {
      return {
        satisfied: false,
        reason: `未能重新加载迁移附件 [${attInfo.key}]`,
      };
    }
    if (att.parentItemID !== master.id) {
      return {
        satisfied: false,
        reason: `迁移附件 [${attInfo.key}] 的 parentItemID (${att.parentItemID}) 未正确重新挂接至 Master (${master.id})`,
      };
    }
  }

  const expectedNotes = step.preview.reparentNotes || [];
  for (const noteInfo of expectedNotes) {
    const note = await reloadItem(libraryID, noteInfo.key);
    if (!note) {
      return {
        satisfied: false,
        reason: `未能重新加载迁移笔记 [${noteInfo.key}]`,
      };
    }
    if (note.parentItemID !== master.id) {
      return {
        satisfied: false,
        reason: `迁移笔记 [${noteInfo.key}] 的 parentItemID (${note.parentItemID}) 未正确重新挂接至 Master (${master.id})`,
      };
    }
  }

  // 6. 同库入站关系重写检验
  if (
    Array.isArray(step.preview.inboundRelationOwners) &&
    step.preview.inboundRelationOwners.length > 0 &&
    typeof Zotero !== "undefined" &&
    Zotero.URI
  ) {
    for (const ownerKey of step.preview.inboundRelationOwners) {
      const owner = await reloadItem(libraryID, ownerKey);
      if (owner && typeof owner.getRelations === "function") {
        const rels = owner.getRelations();
        for (const ok of otherKeys) {
          const donorURI = `http://zotero.org/users/${libraryID}/items/${ok}`;
          for (const pred in rels) {
            if (Array.isArray(rels[pred]) && rels[pred].includes(donorURI)) {
              return {
                satisfied: false,
                reason: `同库入站关系拥有者 [${ownerKey}] 依然保留指向已废弃 Donor [${ok}] 的旧关系引用`,
              };
            }
          }
        }
      }
    }
  }

  return { satisfied: true };
}

/**
 * 查找指向指定 donor 的入站关系拥有者（同文库、非 master）
 */
async function getInboundRelationOwners(
  donor: any,
  master: any,
  libraryID: number,
): Promise<any[]> {
  if (typeof Zotero === "undefined" || !Zotero.Relations || !Zotero.URI) {
    return [];
  }
  const donorURI = Zotero.URI.getItemURI(donor);
  let rels: any[] = [];
  try {
    rels = await Zotero.Relations.getByObject("item", donorURI);
  } catch {
    rels = [];
  }

  const replPred = Zotero.Relations.replacedItemPredicate || "dc:replaces";
  const owners: any[] = [];
  const seenOwnerIDs = new Set<number>();

  for (const rel of rels) {
    if (rel.predicate === replPred) continue;
    const subject = rel.subject;
    if (!subject) continue;
    if (subject.libraryID !== libraryID) continue;
    if (subject.id === master.id || subject.key === master.key) continue;
    if (!seenOwnerIDs.has(subject.id)) {
      seenOwnerIDs.add(subject.id);
      owners.push(subject);
    }
  }
  return owners;
}

export interface MergeGroupInput {
  masterKey: string;
  otherKeys: string[];
  fieldSources?: Record<string, string>;
  creatorsSourceKey?: string;
}

/**
 * DuplicateService 实现 OperationAdapter
 * tool = 'merge_items', lane = 'mutation'
 */
export class DuplicateService implements OperationAdapter {
  tool = "merge_items";
  lane = "mutation" as const;

  async prepare(args: JsonObject): Promise<OperationPlan> {
    const libraryID = requireLibraryID(args.libraryID);
    const groupsRaw = args.groups;

    if (!Array.isArray(groupsRaw) || groupsRaw.length === 0) {
      throw new PlusError("INVALID_ARGUMENT", "groups 必须是非空数组");
    }
    if (groupsRaw.length > MAX_MERGE_GROUPS) {
      throw new PlusError(
        "INVALID_ARGUMENT",
        `每次最多允许 ${MAX_MERGE_GROUPS} 个合并组，当前提交了 ${groupsRaw.length} 组`,
      );
    }

    const attachmentPolicy = args.attachmentPolicy || "preserve_all";
    if (attachmentPolicy !== "preserve_all") {
      throw new PlusError(
        "UNSUPPORTED_POLICY",
        "首版仅支持 preserve_all 附件保全策略",
      );
    }

    // 检查所有 keys 及组内/组间唯一性
    const allEncounteredKeys = new Set<string>();
    let totalItemsCount = 0;

    const validatedGroups: MergeGroupInput[] = [];

    for (let i = 0; i < groupsRaw.length; i++) {
      const g = groupsRaw[i];
      if (!g || typeof g !== "object") {
        throw new PlusError("INVALID_ARGUMENT", `第 ${i + 1} 组格式错误`);
      }
      const masterKey = g.masterKey;
      const otherKeys = g.otherKeys;

      if (typeof masterKey !== "string" || !/^[A-Z0-9]{8}$/.test(masterKey)) {
        throw new PlusError(
          "INVALID_ARGUMENT",
          `第 ${i + 1} 组 masterKey 格式无效: ${masterKey}`,
        );
      }
      if (!Array.isArray(otherKeys) || otherKeys.length === 0) {
        throw new PlusError(
          "INVALID_ARGUMENT",
          `第 ${i + 1} 组 otherKeys 必须是非空数组`,
        );
      }

      // 组内唯一性
      const groupKeySet = new Set<string>();
      groupKeySet.add(masterKey);

      for (const ok of otherKeys) {
        if (typeof ok !== "string" || !/^[A-Z0-9]{8}$/.test(ok)) {
          throw new PlusError(
            "INVALID_ARGUMENT",
            `第 ${i + 1} 组 otherKeys 中存在无效 key: ${ok}`,
          );
        }
        if (ok === masterKey) {
          throw new PlusError(
            "DUPLICATE_KEY",
            `第 ${i + 1} 组中 masterKey 与 otherKeys 包含相同 key: ${ok}`,
          );
        }
        if (groupKeySet.has(ok)) {
          throw new PlusError(
            "DUPLICATE_KEY",
            `第 ${i + 1} 组 otherKeys 内部存在重复 key: ${ok}`,
          );
        }
        groupKeySet.add(ok);
      }

      // 组间唯一性
      for (const k of groupKeySet) {
        if (allEncounteredKeys.has(k)) {
          throw new PlusError(
            "CONFLICTING_KEYS",
            `Key [${k}] 同时出现在多个合并组中，操作被阻断`,
          );
        }
        allEncounteredKeys.add(k);
      }

      totalItemsCount += groupKeySet.size;
      validatedGroups.push({
        masterKey,
        otherKeys: [...otherKeys],
        fieldSources: g.fieldSources,
        creatorsSourceKey: g.creatorsSourceKey,
      });
    }

    if (totalItemsCount > MAX_TOTAL_MERGE_ITEMS) {
      throw new PlusError(
        "INVALID_ARGUMENT",
        `每次最多允许处理 ${MAX_TOTAL_MERGE_ITEMS} 个条目，当前共计 ${totalItemsCount} 项`,
      );
    }

    const steps: PlanStep[] = [];
    const warnings: string[] = [];
    const allAssignedTargets = new Map<string, number>(); // targetID -> groupIndex

    for (let groupIdx = 0; groupIdx < validatedGroups.length; groupIdx++) {
      const group = validatedGroups[groupIdx];
      const blockers: Array<{ code: string; message: string }> = [];

      const master = await getItem(libraryID, group.masterKey);
      if (!master) {
        throw new PlusError(
          "ITEM_NOT_FOUND",
          `Master item [${group.masterKey}] 不存在`,
        );
      }

      const donors: any[] = [];
      for (const ok of group.otherKeys) {
        const d = await getItem(libraryID, ok);
        if (!d) {
          throw new PlusError("ITEM_NOT_FOUND", `Donor item [${ok}] 不存在`);
        }
        donors.push(d);
      }

      const allGroupItems = [master, ...donors];

      // 基础属性与权限校验
      requireWritable(libraryID, allGroupItems);

      for (const it of allGroupItems) {
        if (typeof it.isRegularItem === "function" && !it.isRegularItem()) {
          throw new PlusError(
            "NOT_REGULAR_ITEM",
            `条目 [${it.key}] 不是 regular item`,
          );
        }
        if (it.libraryID !== libraryID) {
          throw new PlusError(
            "CROSS_LIBRARY",
            `条目 [${it.key}] 不在指定文库 [${libraryID}] 中`,
          );
        }
        if (it.deleted) {
          throw new PlusError(
            "ITEM_NOT_EDITABLE",
            `条目 [${it.key}] 已在回收站`,
          );
        }
        if (typeof it.isEditable === "function" && !it.isEditable()) {
          throw new PlusError("ITEM_NOT_EDITABLE", `条目 [${it.key}] 不可编辑`);
        }
        if (typeof it.filesEditable === "function" && !it.filesEditable()) {
          throw new PlusError(
            "ITEM_NOT_EDITABLE",
            `条目 [${it.key}] 的附件不可编辑`,
          );
        }
        if (it.itemType !== master.itemType) {
          throw new PlusError(
            "ITEM_TYPE_MISMATCH",
            `条目 [${it.key}] 类型 [${it.itemType}] 与 Master [${master.itemType}] 不一致`,
          );
        }
      }

      // 创作者来源校验
      const creatorsSourceKey = group.creatorsSourceKey || group.masterKey;
      if (
        !group.otherKeys.includes(creatorsSourceKey) &&
        creatorsSourceKey !== group.masterKey
      ) {
        throw new PlusError(
          "INVALID_ARGUMENT",
          `creatorsSourceKey [${creatorsSourceKey}] 必须属于当前合并组`,
        );
      }

      // 字段源校验
      const fieldSources = group.fieldSources || {};
      for (const [fieldName, sourceKey] of Object.entries(fieldSources)) {
        if (SYSTEM_FORBIDDEN_FIELDS.has(fieldName)) {
          throw new PlusError(
            "FORBIDDEN_FIELD",
            `禁止通过 fieldSources 修改系统字段 [${fieldName}]`,
          );
        }
        if (!isValidBibliographicField(fieldName, master.itemType)) {
          throw new PlusError(
            "INVALID_FIELD",
            `字段 [${fieldName}] 不是类型 [${master.itemType}] 的有效书目字段`,
          );
        }
        if (
          sourceKey !== group.masterKey &&
          !group.otherKeys.includes(sourceKey)
        ) {
          throw new PlusError(
            "INVALID_ARGUMENT",
            `字段 [${fieldName}] 的 sourceKey [${sourceKey}] 不属于当前合并组`,
          );
        }
      }

      // 强 DOI / ISBN 冲突检测
      const masterDOI = normalizeDOI(
        master.getField ? master.getField("DOI") : master.DOI,
      );
      const masterISBN = normalizeISBN(
        master.getField ? master.getField("ISBN") : master.ISBN,
      );

      for (const d of donors) {
        const dDOI = normalizeDOI(d.getField ? d.getField("DOI") : d.DOI);
        const dISBN = normalizeISBN(d.getField ? d.getField("ISBN") : d.ISBN);

        if (masterDOI && dDOI && masterDOI !== dDOI) {
          blockers.push({
            code: "DOI_CONFLICT",
            message: `条目 [${master.key}] (DOI: ${masterDOI}) 与 [${d.key}] (DOI: ${dDOI}) 存在不可调和的 DOI 强冲突`,
          });
        }
        if (masterISBN && dISBN && masterISBN !== dISBN) {
          blockers.push({
            code: "ISBN_CONFLICT",
            message: `条目 [${master.key}] (ISBN: ${masterISBN}) 与 [${d.key}] (ISBN: ${dISBN}) 存在不可调和的 ISBN 强冲突`,
          });
        }
      }

      // 附件保全限制校验（preserve_all）
      // master 可以有 PDF/Web，但 donors 绝对不得持有 PDF/Web 附件（含回收站）
      const allDonorAttachments: any[] = [];
      const allDonorNotes: any[] = [];

      for (const d of donors) {
        const atts = await getChildItems(d, "attachments", true);
        for (const att of atts) {
          allDonorAttachments.push(att);
          if (isPDFAttachment(att) || isWebAttachment(att)) {
            blockers.push({
              code: "ATTACHMENT_PRESERVATION_UNSUPPORTED",
              message: `Donor [${d.key}] 持有 PDF 或网页附件 [${att.key}] (deleted: ${!!att.deleted})。原生合并会触发自动去重或破坏附件保全，在 preserve_all 策略下禁止执行`,
            });
          }
        }
        const notes = await getChildItems(d, "notes", true);
        for (const note of notes) {
          allDonorNotes.push(note);
        }
      }

      // 检测原生 merge 支持性，失败则标注阻断项，不发放可执行计划
      const nativeMergeFunc = await getNativeMergeFunction();
      if (!nativeMergeFunc) {
        blockers.push({
          code: "NATIVE_MERGE_UNAVAILABLE",
          message:
            "当前运行环境无法定位或导入 Zotero 原生 mergeItems 入口，无法提供可执行合并计划",
        });
      }

      // 查找入站引用拥有者 (Inbound relation owners)
      const inboundOwners: any[] = [];
      for (const d of donors) {
        const owners = await getInboundRelationOwners(d, master, libraryID);
        for (const o of owners) {
          if (!inboundOwners.some((x) => x.id === o.id || x.key === o.key)) {
            inboundOwners.push(o);
          }
        }
      }

      // 实际写入范围包括：master、donors、所有子附件/笔记（含 trashed 子项）、同库入站关系拥有者
      requireWritable(libraryID, [master, ...donors, ...inboundOwners]);

      for (const child of [...allDonorAttachments, ...allDonorNotes]) {
        if (child.libraryID !== libraryID) {
          throw new PlusError(
            "CROSS_LIBRARY",
            `子项 [${child.key}] 不在指定文库 [${libraryID}] 中`,
          );
        }
        if (typeof child.isEditable === "function" && !child.isEditable()) {
          throw new PlusError(
            "ITEM_NOT_EDITABLE",
            `子项 [${child.key}] 不可编辑`,
          );
        }
      }

      // 构建 targets 列表
      const targets: TargetRef[] = [
        { libraryID, key: master.key, kind: "item" },
        ...donors.map((d) => ({
          libraryID,
          key: d.key,
          kind: "item" as const,
        })),
        ...allDonorAttachments.map((a) => ({
          libraryID,
          key: a.key,
          kind: "item" as const,
        })),
        ...allDonorNotes.map((n) => ({
          libraryID,
          key: n.key,
          kind: "item" as const,
        })),
        ...inboundOwners.map((o) => ({
          libraryID,
          key: o.key,
          kind: "item" as const,
        })),
      ];

      // 交叉组影响冲突检查（Targets 写入范围重叠检查）
      for (const t of targets) {
        const tid = targetID(t);
        if (allAssignedTargets.has(tid)) {
          const prevGroup = allAssignedTargets.get(tid)! + 1;
          throw new PlusError(
            "TARGET_OVERLAP_CONFLICT",
            `目标 [${t.key}] 同时被第 ${prevGroup} 组与第 ${groupIdx + 1} 组纳入实际写入影响范围，存在写冲突，操作被阻断`,
          );
        }
        allAssignedTargets.set(tid, groupIdx);
      }

      // 生成只读 Preview 数据
      const beforeFields: Record<string, any> = {};
      if (typeof master.getFields === "function") {
        for (const f of master.getFields()) {
          beforeFields[f] = master.getField(f);
        }
      } else {
        beforeFields.title =
          master.title || (master.getField && master.getField("title"));
        beforeFields.DOI =
          master.DOI || (master.getField && master.getField("DOI"));
        beforeFields.ISBN =
          master.ISBN || (master.getField && master.getField("ISBN"));
      }

      const afterFields: Record<string, any> = { ...beforeFields };
      for (const [f, srcKey] of Object.entries(fieldSources)) {
        const srcItem = allGroupItems.find((x) => x.key === srcKey);
        if (srcItem) {
          afterFields[f] = srcItem.getField ? srcItem.getField(f) : srcItem[f];
        }
      }

      const creatorsSourceItem = allGroupItems.find(
        (x) => x.key === creatorsSourceKey,
      );
      const afterCreators = creatorsSourceItem?.getCreators
        ? creatorsSourceItem.getCreators()
        : [];

      // 集合与标签并集
      const collectionsUnion = new Set<any>(
        master.getCollections ? master.getCollections() : [],
      );
      for (const d of donors) {
        if (d.getCollections) {
          for (const c of d.getCollections()) collectionsUnion.add(c);
        }
      }

      const tagsUnion = new Set<string>();
      if (master.getTags) {
        for (const t of master.getTags())
          tagsUnion.add(typeof t === "string" ? t : t.tag);
      }
      for (const d of donors) {
        if (d.getTags) {
          for (const t of d.getTags())
            tagsUnion.add(typeof t === "string" ? t : t.tag);
        }
      }

      // 最早 dateAdded
      let earliestDateAdded = master.dateAdded;
      for (const d of donors) {
        if (
          d.dateAdded &&
          (!earliestDateAdded || d.dateAdded < earliestDateAdded)
        ) {
          earliestDateAdded = d.dateAdded;
        }
      }

      // 附件与笔记迁移统计（列出真实 keys、id 及状态）
      const reparentAttachments: Array<{
        key: string;
        id: number;
        title: string;
        deleted: boolean;
      }> = allDonorAttachments.map((a) => ({
        key: a.key,
        id: a.id,
        title: a.getField ? a.getField("title") : a.attachmentFilename || a.key,
        deleted: !!a.deleted,
      }));

      const reparentNotes: Array<{
        key: string;
        id: number;
        title: string;
        deleted: boolean;
      }> = allDonorNotes.map((n) => ({
        key: n.key,
        id: n.id,
        title: n.getNoteTitle ? n.getNoteTitle() : n.key,
        deleted: !!n.deleted,
      }));

      const preview = {
        masterKey: master.key,
        before: {
          fields: beforeFields,
          creators: master.getCreators ? master.getCreators() : [],
          collections: master.getCollections ? master.getCollections() : [],
          tags: Array.from(tagsUnion),
        },
        after: {
          fields: afterFields,
          creators: afterCreators,
          collections: Array.from(collectionsUnion),
          tags: Array.from(tagsUnion),
          dateAdded: earliestDateAdded,
        },
        donors: donors.map((d) => ({
          key: d.key,
          action: "moveToTrash",
          deleted: true,
        })),
        reparentAttachments,
        reparentNotes,
        inboundRelationOwners: inboundOwners.map((o) => o.key),
      };

      // 构造足够校验和哈希的关键状态快照（包含 master、donors、所有 children 及入站关系拥有者）
      const fpPayload = {
        master: {
          key: master.key,
          version: master.version,
          dateModified: master.dateModified,
          deleted: master.deleted,
          fields: beforeFields,
          creators: master.getCreators ? master.getCreators() : [],
        },
        donors: donors.map((d) => ({
          key: d.key,
          version: d.version,
          dateModified: d.dateModified,
          deleted: d.deleted,
        })),
        children: [
          ...allDonorAttachments.map((a) => ({
            key: a.key,
            parentItemID: a.parentItemID,
            version: a.version,
            dateModified: a.dateModified,
            deleted: a.deleted,
          })),
          ...allDonorNotes.map((n) => ({
            key: n.key,
            parentItemID: n.parentItemID,
            version: n.version,
            dateModified: n.dateModified,
            deleted: n.deleted,
          })),
        ],
        inboundOwners: inboundOwners.map((o) => ({
          key: o.key,
          version: o.version,
          dateModified: o.dateModified,
          deleted: o.deleted,
        })),
        fieldSources,
        creatorsSourceKey,
      };

      const fp = await fingerprint(fpPayload);

      const step: PlanStep = {
        id: secureID("merge-step"),
        input: {
          libraryID,
          masterKey: master.key,
          otherKeys: donors.map((d) => d.key),
          fieldSources,
          creatorsSourceKey,
          attachmentPolicy,
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
      warnings,
    };
  }

  async check(step: PlanStep): Promise<void> {
    if (step.blockers && step.blockers.length > 0) {
      throw new PlusError(
        step.blockers[0].code,
        `操作存在阻断项: ${step.blockers[0].message}`,
        { blockers: step.blockers },
      );
    }

    const { libraryID, masterKey, otherKeys, fieldSources, creatorsSourceKey } =
      step.input;
    const master = await getItem(libraryID, masterKey);
    if (!master) {
      throw new PlusError("ITEM_NOT_FOUND", `Master [${masterKey}] 不存在`);
    }

    const donors: any[] = [];
    for (const ok of otherKeys) {
      const d = await getItem(libraryID, ok);
      if (!d) {
        throw new PlusError("ITEM_NOT_FOUND", `Donor [${ok}] 不存在`);
      }
      donors.push(d);
    }

    // 重新解析子条目
    const currentAttachments: any[] = [];
    const currentNotes: any[] = [];
    for (const d of donors) {
      const atts = await getChildItems(d, "attachments", true);
      for (const a of atts) {
        currentAttachments.push(a);
        if (isPDFAttachment(a) || isWebAttachment(a)) {
          throw new PlusError(
            "ATTACHMENT_PRESERVATION_UNSUPPORTED",
            `Donor [${d.key}] 包含 PDF 或 Web 附件 [${a.key}]，阻断执行`,
          );
        }
      }
      const notes = await getChildItems(d, "notes", true);
      for (const n of notes) {
        currentNotes.push(n);
      }
    }

    const inboundOwners: any[] = [];
    for (const d of donors) {
      const owners = await getInboundRelationOwners(d, master, libraryID);
      for (const o of owners) {
        if (!inboundOwners.some((x) => x.id === o.id || x.key === o.key)) {
          inboundOwners.push(o);
        }
      }
    }

    requireWritable(libraryID, [master, ...donors, ...inboundOwners]);

    for (const child of [...currentAttachments, ...currentNotes]) {
      if (child.libraryID !== libraryID) {
        throw new PlusError(
          "CROSS_LIBRARY",
          `子项 [${child.key}] 不在指定文库 [${libraryID}] 中`,
        );
      }
      if (typeof child.isEditable === "function" && !child.isEditable()) {
        throw new PlusError(
          "ITEM_NOT_EDITABLE",
          `子项 [${child.key}] 不可编辑`,
        );
      }
    }

    const beforeFields: Record<string, any> = {};
    if (typeof master.getFields === "function") {
      for (const f of master.getFields()) {
        beforeFields[f] = master.getField(f);
      }
    } else {
      beforeFields.title =
        master.title || (master.getField && master.getField("title"));
      beforeFields.DOI =
        master.DOI || (master.getField && master.getField("DOI"));
      beforeFields.ISBN =
        master.ISBN || (master.getField && master.getField("ISBN"));
    }

    const currentFpPayload = {
      master: {
        key: master.key,
        version: master.version,
        dateModified: master.dateModified,
        deleted: master.deleted,
        fields: beforeFields,
        creators: master.getCreators ? master.getCreators() : [],
      },
      donors: donors.map((d) => ({
        key: d.key,
        version: d.version,
        dateModified: d.dateModified,
        deleted: d.deleted,
      })),
      children: [
        ...currentAttachments.map((a) => ({
          key: a.key,
          parentItemID: a.parentItemID,
          version: a.version,
          dateModified: a.dateModified,
          deleted: a.deleted,
        })),
        ...currentNotes.map((n) => ({
          key: n.key,
          parentItemID: n.parentItemID,
          version: n.version,
          dateModified: n.dateModified,
          deleted: n.deleted,
        })),
      ],
      inboundOwners: inboundOwners.map((o) => ({
        key: o.key,
        version: o.version,
        dateModified: o.dateModified,
        deleted: o.deleted,
      })),
      fieldSources,
      creatorsSourceKey,
    };

    const currentFp = await fingerprint(currentFpPayload);
    if (currentFp !== step.fingerprint) {
      throw new PlusError(
        "STATE_CHANGED",
        "条目、子项或关联关系状态在生成预览后已发生变化，请重新获取预览后再确认执行",
      );
    }
  }

  async execute(
    step: PlanStep,
    context: ExecutionContext,
  ): Promise<StepOutcome> {
    await this.check(step);

    await context.update("submitted", { stepID: step.id });

    const { libraryID, masterKey, otherKeys, fieldSources, creatorsSourceKey } =
      step.input;
    const master = await getItem(libraryID, masterKey);
    const donors: any[] = [];
    for (const ok of otherKeys) {
      donors.push(await getItem(libraryID, ok));
    }

    // 将字段和创作者选择暂存到 master 内存中（不调用 master.save()）
    const allItems = [master, ...donors];
    if (creatorsSourceKey && creatorsSourceKey !== masterKey) {
      const src = allItems.find((x) => x.key === creatorsSourceKey);
      if (
        src &&
        typeof src.getCreators === "function" &&
        typeof master.setCreators === "function"
      ) {
        master.setCreators(src.getCreators());
      }
    }

    if (fieldSources && typeof fieldSources === "object") {
      for (const [fieldName, srcKey] of Object.entries(fieldSources)) {
        const src = allItems.find((x) => x.key === srcKey);
        if (src) {
          const val = src.getField ? src.getField(fieldName) : src[fieldName];
          if (typeof master.setField === "function") {
            master.setField(fieldName, val);
          } else {
            master[fieldName] = val;
          }
        }
      }
    }

    // 获取原生 mergeItems 实现（不外包自身事务！）
    const nativeMerge = await getNativeMergeFunction();
    if (!nativeMerge) {
      throw new PlusError(
        "NATIVE_MERGE_UNAVAILABLE",
        "无法定位 Zotero 原生 mergeItems 入口",
      );
    }

    await context.update("running", { stepID: step.id });

    let nativeError: unknown = null;
    try {
      await nativeMerge(master, donors);
    } catch (err) {
      nativeError = err;
    }

    // 无论成功还是异常，必须进行全面深入的后置条件验证
    const verify = await verifyMergePostconditions(step);
    if (verify.satisfied) {
      return {
        state: "succeeded",
        result: {
          masterKey,
          otherKeys,
          nativeNotice: nativeError ? String(nativeError) : undefined,
        },
        retrySafe: false,
      };
    }

    // 只要结果未满足，即使条目看似未变，也可能原生仍在等事务或处理 hash，不能由 adapter 凭快照宣称 retrySafe
    return {
      state: "needs_review",
      error: {
        code: "INCONSISTENT_STATE",
        message: `合并后置条件验证未通过: ${verify.reason || (nativeError ? String(nativeError) : "merge incomplete")}`,
      },
      retrySafe: false,
    };
  }

  async reconcile(step: PlanStep): Promise<StepOutcome> {
    const verify = await verifyMergePostconditions(step);
    if (verify.satisfied) {
      return {
        state: "externally_satisfied",
        result: {
          masterKey: step.input.masterKey,
          otherKeys: step.input.otherKeys,
        },
        retrySafe: false,
      };
    }

    // 插件热重载后原生 merge 可能仍在等事务/处理 hash 尚未落库。
    // 所有已进入 intent 而结果未满足或无法证明原生结束的情况都返回 needs_review；
    // 未调用的 validating 阶段由主 TaskStore 证明并复原 pending，adapter 绝不凭相同快照授权重试。
    return {
      state: "needs_review",
      error: {
        code: "INCONCLUSIVE_STATE",
        message: `合并后置条件未完全验证通过: ${verify.reason || "unknown"}`,
      },
      retrySafe: false,
    };
  }
}

export interface DuplicateCandidateGroup {
  masterKeyCandidate: string;
  itemKeys: string[];
  matchReason:
    | "IDENTICAL_DOI"
    | "IDENTICAL_ISBN"
    | "MATCHING_TITLE_AUTHOR_YEAR";
  confidence: "high" | "medium";
  conflicts: Array<{ type: string; message: string }>;
  itemsSummary: Array<{
    key: string;
    title: string;
    year: string | null;
    firstAuthor: string;
    doi: string | null;
    isbn: string | null;
    numAttachments: number;
    numNotes: number;
  }>;
}

/**
 * findDuplicates:
 * - 统一扫描参数：maxItems（本次扫描预算）、offset（扫描起点）、collectionKey
 * - 范围明确 (libraryID / collectionKey)，排除 trash
 * - Bounded 扫描，返回 complete / scannedCount / coverage 覆盖信息
 * - 覆盖说明严谨：未完成全库扫描时明确披露仅覆盖本次扫描窗口，不夸大跨分页重复检测
 * - 规范化 DOI / ISBN，强冲突阻断，两两无冲突连通
 */
export async function findDuplicates(args: JsonObject): Promise<JsonObject> {
  const libraryID = requireLibraryID(args.libraryID);
  const collectionKey = args.collectionKey;
  const maxItems = Math.min(
    Math.max(Number(args.maxItems ?? args.budget) || 500, 1),
    10000,
  );
  const offset = Math.max(Number(args.offset) || 0, 0);
  const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 200);

  if (typeof Zotero === "undefined") {
    throw new PlusError("INTERNAL_ERROR", "Zotero runtime unavailable");
  }

  let rawItems: any[] = [];
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
      rawItems = await Zotero.Items.getAsync(itemIDs);
    } else {
      rawItems = itemIDs.map((id: number) => Zotero.Items.get(id));
    }
  } else {
    if (Zotero.Items?.getAll) {
      rawItems = await Zotero.Items.getAll(libraryID, false, false, true);
    }
  }

  // 过滤：仅 regular items，且非 trash
  const regularItems = (rawItems || []).filter((it: any) => {
    if (!it) return false;
    if (it.deleted) return false;
    if (typeof it.isRegularItem === "function") return it.isRegularItem();
    // fallback
    const t = it.itemType;
    return t && t !== "attachment" && t !== "note" && t !== "annotation";
  });

  const totalCount = regularItems.length;
  const scanSlice = regularItems.slice(offset, offset + maxItems);
  const scannedCount = scanSlice.length;
  const isFullScan = offset === 0 && scannedCount >= totalCount;
  const reachedEnd = offset + scannedCount >= totalCount;
  const nextOffset = reachedEnd ? undefined : offset + scannedCount;

  const coverageNote = isFullScan
    ? `已完成${collectionKey ? `指定集合 [${collectionKey}]` : "文库"}内全部常规条目的扫描。`
    : `本次扫描仅覆盖条目区间 [${offset}, ${offset + scannedCount})。${
        reachedEnd
          ? "已到达常规条目列表末尾，但由于扫描存在起始偏移量，且窗口扫描无法检测跨越已处理与未处理分页边界的潜在重复项，不能判定全库已完全去重。"
          : `达到 maxItems (${maxItems}) 预算上限，跨越未扫描分页的潜在重复项未被检测，不能据此认定未扫描条目无重复或全库仅有当前候选。`
      }`;

  // 提取标准信息结构
  const processed = scanSlice.map((it: any) => {
    const title = (it.getField ? it.getField("title") : it.title) || "";
    const rawDOI = (it.getField ? it.getField("DOI") : it.DOI) || "";
    const rawISBN = (it.getField ? it.getField("ISBN") : it.ISBN) || "";
    const date = (it.getField ? it.getField("date") : it.date) || "";

    const normDOI = normalizeDOI(rawDOI);
    const normISBN = normalizeISBN(rawISBN);
    const normT = normalizeTitle(title);
    const year = extractYear(date);
    const firstAuthor = extractFirstAuthorLastName(it);

    let numAttachments = 0;
    if (typeof it.getAttachments === "function") {
      numAttachments = it.getAttachments().length;
    } else if (typeof it.numAttachments === "function") {
      numAttachments = it.numAttachments();
    }

    let numNotes = 0;
    if (typeof it.getNotes === "function") {
      numNotes = it.getNotes().length;
    }

    return {
      item: it,
      key: it.key,
      title,
      normTitle: normT,
      rawDOI,
      normDOI,
      rawISBN,
      normISBN,
      year,
      firstAuthor,
      numAttachments,
      numNotes,
      dateAdded: it.dateAdded || "",
    };
  });

  // 冲突与匹配检查函数
  const hasStrongConflict = (
    a: (typeof processed)[0],
    b: (typeof processed)[0],
  ): boolean => {
    if (a.normDOI && b.normDOI && a.normDOI !== b.normDOI) return true;
    if (a.normISBN && b.normISBN && a.normISBN !== b.normISBN) return true;
    return false;
  };

  const isDuplicatePair = (
    a: (typeof processed)[0],
    b: (typeof processed)[0],
  ): {
    matched: boolean;
    reason?: "IDENTICAL_DOI" | "IDENTICAL_ISBN" | "MATCHING_TITLE_AUTHOR_YEAR";
    confidence?: "high" | "medium";
  } => {
    if (hasStrongConflict(a, b)) return { matched: false };

    if (a.normDOI && b.normDOI && a.normDOI === b.normDOI) {
      return { matched: true, reason: "IDENTICAL_DOI", confidence: "high" };
    }
    if (a.normISBN && b.normISBN && a.normISBN === b.normISBN) {
      return { matched: true, reason: "IDENTICAL_ISBN", confidence: "high" };
    }

    if (a.normTitle && a.normTitle.length > 5 && a.normTitle === b.normTitle) {
      const authorMatches =
        !a.firstAuthor || !b.firstAuthor || a.firstAuthor === b.firstAuthor;
      const yearMatches = !a.year || !b.year || a.year === b.year;
      if (authorMatches && yearMatches) {
        return {
          matched: true,
          reason: "MATCHING_TITLE_AUTHOR_YEAR",
          confidence: "medium",
        };
      }
    }

    return { matched: false };
  };

  // 两两构建匹配组，保证组内任意两项都互不冲突
  const clusters: Array<Array<(typeof processed)[0]>> = [];
  const clusterReasons = new Map<
    number,
    "IDENTICAL_DOI" | "IDENTICAL_ISBN" | "MATCHING_TITLE_AUTHOR_YEAR"
  >();
  const clusterConfidence = new Map<number, "high" | "medium">();

  for (let i = 0; i < processed.length; i++) {
    const itemA = processed[i];
    let placed = false;

    for (let cIdx = 0; cIdx < clusters.length; cIdx++) {
      const cluster = clusters[cIdx];
      // 检查 itemA 是否与 cluster 中每一项都不冲突且至少与一项匹配
      const conflictsWithAny = cluster.some((member) =>
        hasStrongConflict(itemA, member),
      );
      if (conflictsWithAny) continue;

      let matchesAny = false;
      let matchedReason: any;
      let matchedConf: any;

      for (const member of cluster) {
        const res = isDuplicatePair(itemA, member);
        if (res.matched) {
          matchesAny = true;
          matchedReason = res.reason;
          matchedConf = res.confidence;
          break;
        }
      }

      if (matchesAny) {
        cluster.push(itemA);
        if (matchedConf === "high") {
          clusterConfidence.set(cIdx, "high");
          clusterReasons.set(cIdx, matchedReason);
        }
        placed = true;
        break;
      }
    }

    if (!placed) {
      // 尝试与后续项寻找配对
      for (let j = i + 1; j < processed.length; j++) {
        const itemB = processed[j];
        const res = isDuplicatePair(itemA, itemB);
        if (res.matched) {
          const newIdx = clusters.length;
          clusters.push([itemA]);
          clusterReasons.set(newIdx, res.reason!);
          clusterConfidence.set(newIdx, res.confidence!);
          break;
        }
      }
    }
  }

  // 过滤出真正具有 2 项及以上的重复组
  const multiItemClusters = clusters.filter((c) => c.length >= 2);

  const groups: DuplicateCandidateGroup[] = [];

  for (
    let cIdx = 0;
    cIdx < multiItemClusters.length && groups.length < limit;
    cIdx++
  ) {
    const cluster = multiItemClusters[cIdx];
    // 挑选推荐的 master：优先有有效附件的，其次 dateAdded 最早的
    const sorted = [...cluster].sort((a, b) => {
      if (b.numAttachments !== a.numAttachments) {
        return b.numAttachments - a.numAttachments;
      }
      if (a.dateAdded && b.dateAdded) {
        return a.dateAdded.localeCompare(b.dateAdded);
      }
      return 0;
    });

    const masterCandidate = sorted[0].key;
    const reason = clusterReasons.get(cIdx) || "MATCHING_TITLE_AUTHOR_YEAR";
    const confidence = clusterConfidence.get(cIdx) || "medium";

    groups.push({
      masterKeyCandidate: masterCandidate,
      itemKeys: cluster.map((x) => x.key),
      matchReason: reason,
      confidence,
      conflicts: [],
      itemsSummary: cluster.map((x) => ({
        key: x.key,
        title: x.title,
        year: x.year,
        firstAuthor: x.firstAuthor,
        doi: x.normDOI,
        isbn: x.normISBN,
        numAttachments: x.numAttachments,
        numNotes: x.numNotes,
      })),
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
    },
    complete: isFullScan,
    reachedEnd,
    scannedCount,
    totalEstimated: totalCount,
    paging: {
      maxItems,
      limit,
      offset,
      nextOffset,
    },
    groups,
  };
}
