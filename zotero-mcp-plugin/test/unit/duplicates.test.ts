import { expect } from "chai";
import {
  DuplicateService,
  findDuplicates,
  normalizeDOI,
  normalizeISBN,
  normalizeTitle,
  extractYear,
  extractFirstAuthorLastName,
  isPDFAttachment,
  isWebAttachment,
} from "../../src/modules/duplicateService.ts";
import { PlusError, type PlanStep } from "../../src/modules/plusTypes.ts";

/**
 * 辅助异步异常断言函数
 */
async function assertRejects(
  fn: () => Promise<any>,
  expectedType?: any,
  messagePattern?: RegExp,
): Promise<any> {
  let error: any = null;
  try {
    await fn();
  } catch (err) {
    error = err;
  }
  expect(error, "Expected promise to reject, but it resolved").to.be.ok;
  if (expectedType) {
    expect(error).to.be.an.instanceOf(expectedType);
  }
  if (messagePattern) {
    const matched =
      messagePattern.test(error.message) ||
      (typeof error.code === "string" && messagePattern.test(error.code));
    expect(
      matched,
      `Expected error code or message to match ${messagePattern}, but got code: ${error.code}, message: ${error.message}`,
    ).to.be.true;
  }
  return error;
}

/**
 * 构造模拟的 Zotero Item
 * 符合原生 Zotero 规范：
 * - item.getAttachments(includeDeleted) 返回 number[] (附件ID数组)
 * - item.getNotes(includeDeleted) 返回 number[] (笔记ID数组)
 * - item.reload(undefined, true) 原生重载契约
 */
function createMockItem(options: {
  key: string;
  id?: number;
  libraryID?: number;
  itemType?: string;
  deleted?: boolean;
  editable?: boolean;
  filesEditable?: boolean;
  dateAdded?: string;
  dateModified?: string;
  version?: number;
  fields?: Record<string, any>;
  creators?: any[];
  collections?: number[];
  tags?: Array<{ tag: string; type?: number }>;
  attachmentIDs?: number[];
  noteIDs?: number[];
  relations?: Record<string, string[]>;
}) {
  const key = options.key;
  const id = options.id || Math.floor(Math.random() * 100000) + 1;
  const libraryID = options.libraryID !== undefined ? options.libraryID : 1;
  const itemType = options.itemType || "journalArticle";
  let deleted = !!options.deleted;
  const editable = options.editable !== undefined ? options.editable : true;
  const filesEditable =
    options.filesEditable !== undefined ? options.filesEditable : true;
  const dateAdded = options.dateAdded || "2023-01-01T00:00:00Z";
  let dateModified = options.dateModified || "2023-01-01T00:00:00Z";
  let version = options.version !== undefined ? options.version : 1;

  const fields: Record<string, any> = {
    title: `Title of ${key}`,
    ...options.fields,
  };
  let creators = options.creators
    ? [...options.creators]
    : [{ firstName: "John", lastName: "Doe" }];
  const collections = new Set<number>(options.collections || []);
  const tags = new Map<string, number>();
  (options.tags || []).forEach((t) => tags.set(t.tag, t.type || 0));

  const attachmentIDs = options.attachmentIDs ? [...options.attachmentIDs] : [];
  const noteIDs = options.noteIDs ? [...options.noteIDs] : [];
  const relations = options.relations ? { ...options.relations } : {};

  let saveCallCount = 0;
  let reloadCallCount = 0;

  const item: any = {
    id,
    key,
    libraryID,
    itemType,
    get deleted() {
      return deleted;
    },
    set deleted(val: boolean) {
      deleted = val;
    },
    dateAdded,
    get dateModified() {
      return dateModified;
    },
    set dateModified(val: string) {
      dateModified = val;
    },
    get version() {
      return version;
    },
    set version(val: number) {
      version = val;
    },
    isRegularItem: () =>
      !["attachment", "note", "annotation"].includes(itemType),
    isEditable: () => editable,
    filesEditable: () => filesEditable,
    getField: (fieldName: string) => fields[fieldName],
    setField: (fieldName: string, val: any) => {
      fields[fieldName] = val;
    },
    getFields: () => Object.keys(fields),
    getCreators: () => creators.map((c) => ({ ...c })),
    setCreators: (newCreators: any[]) => {
      creators = [...newCreators];
    },
    getCollections: () => Array.from(collections),
    addToCollection: (colID: number) => {
      collections.add(colID);
    },
    getTags: () =>
      Array.from(tags.entries()).map(([tag, type]) => ({ tag, type })),
    hasTag: (t: string) => tags.has(t),
    getTagType: (t: string) => tags.get(t) || 0,
    addTag: (t: string, type = 0) => {
      tags.set(t, type);
    },
    // 原生返回 number[] ID 列表
    getAttachments: (_includeDeleted = false) => {
      return [...attachmentIDs];
    },
    getNotes: (_includeDeleted = false) => {
      return [...noteIDs];
    },
    getRelations: () => relations,
    addRelation: (pred: string, obj: string) => {
      if (!relations[pred]) relations[pred] = [];
      if (!relations[pred].includes(obj)) relations[pred].push(obj);
    },
    removeRelation: (pred: string, obj: string) => {
      if (relations[pred]) {
        relations[pred] = relations[pred].filter((x) => x !== obj);
      }
    },
    getRelationsByPredicate: (pred: string) => relations[pred] || [],
    reload: async (modifier?: any, keepCaches?: boolean) => {
      reloadCallCount++;
      if (typeof modifier === "function") {
        await modifier(item);
      }
      return true;
    },
    save: async () => {
      saveCallCount++;
    },
    getSaveCallCount: () => saveCallCount,
    getReloadCallCount: () => reloadCallCount,
    _rawFields: fields,
    _attachmentIDs: attachmentIDs,
    _noteIDs: noteIDs,
  };

  return item;
}

/**
 * 构造模拟的 Attachment Item
 */
function createMockAttachment(options: {
  key: string;
  id?: number;
  libraryID?: number;
  parentItemID?: number;
  isPDF?: boolean;
  isWeb?: boolean;
  linkMode?: number;
  contentType?: string;
  deleted?: boolean;
  editable?: boolean;
  version?: number;
  dateModified?: string;
  fileExists?: boolean;
}) {
  const id = options.id || Math.floor(Math.random() * 100000) + 1;
  const key = options.key;
  const libraryID = options.libraryID !== undefined ? options.libraryID : 1;
  let deleted = !!options.deleted;
  let parentItemID = options.parentItemID;
  const isPDF = options.isPDF !== undefined ? options.isPDF : false;
  const isWeb = options.isWeb !== undefined ? options.isWeb : false;
  const linkMode = options.linkMode !== undefined ? options.linkMode : 0; // 0 = IMPORTED_FILE
  const fileExists =
    options.fileExists !== undefined ? options.fileExists : true;
  const editable = options.editable !== undefined ? options.editable : true;
  let version = options.version !== undefined ? options.version : 1;
  let dateModified = options.dateModified || "2023-01-01T00:00:00Z";

  let reloadCount = 0;

  return {
    id,
    key,
    libraryID,
    itemType: "attachment",
    get parentItemID() {
      return parentItemID;
    },
    set parentItemID(val: number | undefined) {
      parentItemID = val;
    },
    get version() {
      return version;
    },
    set version(val: number) {
      version = val;
    },
    get dateModified() {
      return dateModified;
    },
    set dateModified(val: string) {
      dateModified = val;
    },
    attachmentLinkMode: linkMode,
    attachmentContentType: isPDF
      ? "application/pdf"
      : isWeb
        ? "text/html"
        : "application/octet-stream",
    get deleted() {
      return deleted;
    },
    set deleted(val: boolean) {
      deleted = val;
    },
    isRegularItem: () => false,
    isAttachment: () => true,
    isPDFAttachment: () => isPDF,
    isWebAttachment: () => isWeb,
    isEditable: () => editable,
    fileExists: () => fileExists,
    getField: (f: string) => (f === "title" ? `Attachment ${key}` : ""),
    reload: async () => {
      reloadCount++;
      return true;
    },
    getReloadCount: () => reloadCount,
    save: async () => {},
  };
}

/**
 * 构造模拟的 Note Item
 */
function createMockNote(options: {
  key: string;
  id?: number;
  libraryID?: number;
  parentItemID?: number;
  deleted?: boolean;
  editable?: boolean;
  version?: number;
  dateModified?: string;
  noteTitle?: string;
}) {
  const id = options.id || Math.floor(Math.random() * 100000) + 1;
  const key = options.key;
  const libraryID = options.libraryID !== undefined ? options.libraryID : 1;
  let deleted = !!options.deleted;
  let parentItemID = options.parentItemID;
  const editable = options.editable !== undefined ? options.editable : true;
  let version = options.version !== undefined ? options.version : 1;
  let dateModified = options.dateModified || "2023-01-01T00:00:00Z";
  const noteTitle = options.noteTitle || `Note ${key}`;

  let reloadCount = 0;

  return {
    id,
    key,
    libraryID,
    itemType: "note",
    get parentItemID() {
      return parentItemID;
    },
    set parentItemID(val: number | undefined) {
      parentItemID = val;
    },
    get version() {
      return version;
    },
    set version(val: number) {
      version = val;
    },
    get dateModified() {
      return dateModified;
    },
    set dateModified(val: string) {
      dateModified = val;
    },
    get deleted() {
      return deleted;
    },
    set deleted(val: boolean) {
      deleted = val;
    },
    isRegularItem: () => false,
    isAttachment: () => false,
    isNote: () => true,
    isEditable: () => editable,
    getNoteTitle: () => noteTitle,
    reload: async () => {
      reloadCount++;
      return true;
    },
    getReloadCount: () => reloadCount,
    save: async () => {},
  };
}

describe("duplicateService unit tests", function () {
  let mockDB: Map<string, any>;
  let mockRelations: Array<{ subject: any; predicate: string; object: string }>;
  let currentMockNativeMerge: (master: any, donors: any[]) => Promise<any>;

  beforeEach(function () {
    mockDB = new Map();
    mockRelations = [];

    // 设置全局 Zotero 模拟环境
    (globalThis as any).Zotero = {
      Libraries: {
        userLibraryID: 1,
        get: (id: number) => {
          if (id === 1) return { id: 1, editable: true };
          if (id === 2) return { id: 2, editable: false }; // read-only
          return null;
        },
      },
      Items: {
        getByLibraryAndKeyAsync: async (libraryID: number, key: string) => {
          return mockDB.get(`${libraryID}:${key}`) || null;
        },
        getByLibraryAndKey: (libraryID: number, key: string) => {
          return mockDB.get(`${libraryID}:${key}`) || null;
        },
        getAsync: async (keysOrIDs: any) => {
          if (Array.isArray(keysOrIDs)) {
            return keysOrIDs
              .map((k) => {
                if (typeof k === "number") {
                  for (const it of mockDB.values()) {
                    if (it.id === k) return it;
                  }
                  return null;
                }
                return mockDB.get(`1:${k}`) || null;
              })
              .filter(Boolean);
          }
          if (typeof keysOrIDs === "number") {
            for (const it of mockDB.values()) {
              if (it.id === keysOrIDs) return it;
            }
            return null;
          }
          return mockDB.get(`1:${keysOrIDs}`) || null;
        },
        getAll: async (libraryID: number) => {
          const res: any[] = [];
          for (const it of mockDB.values()) {
            if (it.libraryID === libraryID) res.push(it);
          }
          return res;
        },
      },
      ItemFields: {
        getID: (field: string) => (field === "invalidField" ? null : 10),
        isValidForType: (_fieldID: number, _typeID: number) => true,
      },
      ItemTypes: {
        getID: (_itemType: string) => 1,
      },
      Attachments: {
        LINK_MODE_IMPORTED_FILE: 0,
        LINK_MODE_IMPORTED_URL: 1,
        LINK_MODE_LINKED_FILE: 2,
        LINK_MODE_LINKED_URL: 3,
      },
      URI: {
        getItemURI: (item: any) =>
          `http://zotero.org/users/1/items/${item.key}`,
      },
      Relations: {
        replacedItemPredicate: "dc:replaces",
        getByObject: async (_type: string, uri: string) => {
          return mockRelations.filter((r) => r.object === uri);
        },
      },
      Notifier: {
        trigger: async () => {},
      },
      DB: {
        executeTransaction: async (fn: any) => fn(),
        requireTransaction: () => {},
      },
    };

    // 默认定义原生 merge 实现
    currentMockNativeMerge = async (master: any, donors: any[]) => {
      // 原生 merge: 标记 donors deleted
      donors.forEach((d) => (d.deleted = true));

      // 原生 merge: 将 donor 的附件与笔记 reparent 给 master
      for (const d of donors) {
        if (d.getAttachments) {
          const attIDs = d.getAttachments(true);
          const atts = await (globalThis as any).Zotero.Items.getAsync(attIDs);
          for (const a of atts) {
            a.parentItemID = master.id;
          }
        }
        if (d.getNotes) {
          const noteIDs = d.getNotes(true);
          const notes = await (globalThis as any).Zotero.Items.getAsync(
            noteIDs,
          );
          for (const n of notes) {
            n.parentItemID = master.id;
          }
        }
      }

      // 原生 merge: 重写同库入站关系
      const masterURI = (globalThis as any).Zotero.URI.getItemURI(master);
      for (const d of donors) {
        const dURI = (globalThis as any).Zotero.URI.getItemURI(d);
        for (const rel of mockRelations) {
          if (rel.object === dURI) {
            rel.object = masterURI;
            if (rel.subject && rel.subject.addRelation) {
              rel.subject.removeRelation(rel.predicate, dURI);
              rel.subject.addRelation(rel.predicate, masterURI);
            }
          }
        }
      }
    };

    // 仅通过 mock ChromeUtils.importESModule 返回原生 merge 函数
    (globalThis as any).ChromeUtils = {
      importESModule: (uri: string) => {
        if (uri === "chrome://zotero/content/mergeItems.mjs") {
          return {
            mergeItems: (master: any, donors: any[]) =>
              currentMockNativeMerge(master, donors),
          };
        }
        throw new Error(`Unexpected importESModule URI: ${uri}`);
      },
    };
  });

  afterEach(function () {
    delete (globalThis as any).Zotero;
    delete (globalThis as any).ChromeUtils;
  });

  describe("Identifier normalization and title matching", function () {
    it("normalizes DOI correctly without stripping legal trailing punctuation like ')' or ';'", function () {
      expect(normalizeDOI("https://doi.org/10.1000/182")).to.equal(
        "10.1000/182",
      );
      expect(
        normalizeDOI("http://dx.doi.org/10.1016/j.cell.2023.01.001"),
      ).to.equal("10.1016/j.cell.2023.01.001");
      // 保留合法的尾部标点符号 ')' 和 ';'，绝不能无条件剥离导致合错候选
      expect(
        normalizeDOI(
          "https://doi.org/10.1002/(SICI)1097-0142(19960815)78:4<822::AID-CNCR20>3.0.CO;2-P",
        ),
      ).to.equal(
        "10.1002/(sici)1097-0142(19960815)78:4<822::aid-cncr20>3.0.co;2-p",
      );
      expect(normalizeDOI("doi: 10.1145/1234567.1234568;")).to.equal(
        "10.1145/1234567.1234568;",
      );
      expect(normalizeDOI("  10.1000/182(A)  ")).to.equal("10.1000/182(a)");
      expect(normalizeDOI("10.1000/ABC-DEF")).to.equal("10.1000/abc-def");
      expect(normalizeDOI("not-a-doi")).to.be.null;
      expect(normalizeDOI("")).to.be.null;
      expect(normalizeDOI(null)).to.be.null;
    });

    it("normalizes and validates ISBN-10, converting to valid ISBN-13 with recalculated check digit", function () {
      // 0-306-40615-2 -> 9780306406157
      const res = normalizeISBN("0-306-40615-2");
      expect(res).to.equal("9780306406157");

      // ISBN-10 with X check digit: 080442957X -> 9780804429573
      const resX = normalizeISBN("0-8044-2957-X");
      expect(resX).to.equal("9780804429573");

      // Valid ISBN-13
      expect(normalizeISBN("978-0-306-40615-7")).to.equal("9780306406157");

      // Invalid ISBN
      expect(normalizeISBN("0-306-40615-9")).to.be.null; // wrong check digit
      expect(normalizeISBN("123")).to.be.null;
      expect(normalizeISBN("")).to.be.null;
    });

    it("normalizes titles and extracts year / author", function () {
      expect(
        normalizeTitle("  A Study on Deep Learning: Methods & Applications! "),
      ).to.equal("a study on deep learning methods applications");
      expect(extractYear("2021/05/12")).to.equal("2021");
      expect(extractYear("May 1999")).to.equal("1999");
      expect(extractYear("no date")).to.be.null;

      const mockItem = {
        getCreators: () => [
          { firstName: "Alice", lastName: "Smith" },
          { firstName: "Bob", lastName: "Jones" },
        ],
      };
      expect(extractFirstAuthorLastName(mockItem)).to.equal("smith");
    });
  });

  describe("DuplicateService.prepare validation & constraints", function () {
    const service = new DuplicateService();

    it("rejects invalid arguments, too many groups (>20) or items (>100)", async function () {
      await assertRejects(
        () => service.prepare({ libraryID: 1, groups: [] }),
        PlusError,
        /groups 必须是非空数组/,
      );

      const twentyOneGroups = Array.from({ length: 21 }, (_, i) => ({
        masterKey: `MST${String(i).padStart(5, "0")}`,
        otherKeys: [`DNR${String(i).padStart(5, "0")}`],
      }));
      await assertRejects(
        () => service.prepare({ libraryID: 1, groups: twentyOneGroups }),
        PlusError,
        /最多允许 20 个合并组/,
      );
    });

    it("fails closed with blocker when native merge is unsupported, refusing monkey patch fallback", async function () {
      const master = createMockItem({ key: "MSTR1111", libraryID: 1 });
      const donor = createMockItem({ key: "DONR1111", libraryID: 1 });
      mockDB.set("1:MSTR1111", master);
      mockDB.set("1:DONR1111", donor);

      // 移除 ChromeUtils 模拟环境，并模拟 monkey patch 试图劫持（必须被拒绝！）
      delete (globalThis as any).ChromeUtils;
      (globalThis as any).Zotero.mergeItems = async () => {};

      const plan = await service.prepare({
        libraryID: 1,
        groups: [{ masterKey: "MSTR1111", otherKeys: ["DONR1111"] }],
      });

      expect(plan.steps[0].blockers).to.be.an("array");
      const hasNativeMergeBlocker = plan.steps[0].blockers?.some(
        (b) => b.code === "NATIVE_MERGE_UNAVAILABLE",
      );
      expect(hasNativeMergeBlocker).to.be.true;

      // check 必须阻断抛错，禁止发放可执行计划
      await assertRejects(
        () => service.check(plan.steps[0]),
        PlusError,
        /NATIVE_MERGE_UNAVAILABLE/,
      );
    });

    it("rejects duplicate keys within same group or across groups", async function () {
      // masterKey in otherKeys
      await assertRejects(
        () =>
          service.prepare({
            libraryID: 1,
            groups: [{ masterKey: "AAAA1111", otherKeys: ["AAAA1111"] }],
          }),
        PlusError,
        /masterKey 与 otherKeys 包含相同 key/,
      );

      // otherKeys duplicate within group
      await assertRejects(
        () =>
          service.prepare({
            libraryID: 1,
            groups: [
              { masterKey: "AAAA1111", otherKeys: ["BBBB2222", "BBBB2222"] },
            ],
          }),
        PlusError,
        /otherKeys 内部存在重复 key/,
      );

      // duplicate keys across groups
      await assertRejects(
        () =>
          service.prepare({
            libraryID: 1,
            groups: [
              { masterKey: "AAAA1111", otherKeys: ["BBBB2222"] },
              { masterKey: "CCCC3333", otherKeys: ["BBBB2222"] },
            ],
          }),
        PlusError,
        /同时出现在多个合并组中/,
      );
    });

    it("enforces regular items, same-library, same-itemType, non-deleted, and editable", async function () {
      const master = createMockItem({
        key: "MSTR1111",
        libraryID: 1,
        itemType: "journalArticle",
      });
      const donorWrongType = createMockItem({
        key: "DONR1111",
        libraryID: 1,
        itemType: "book",
      });
      mockDB.set("1:MSTR1111", master);
      mockDB.set("1:DONR1111", donorWrongType);

      await assertRejects(
        () =>
          service.prepare({
            libraryID: 1,
            groups: [{ masterKey: "MSTR1111", otherKeys: ["DONR1111"] }],
          }),
        PlusError,
        /类型.*不一致/,
      );

      // Deleted item
      const donorDeleted = createMockItem({
        key: "DONR2222",
        libraryID: 1,
        itemType: "journalArticle",
        deleted: true,
      });
      mockDB.set("1:DONR2222", donorDeleted);
      await assertRejects(
        () =>
          service.prepare({
            libraryID: 1,
            groups: [{ masterKey: "MSTR1111", otherKeys: ["DONR2222"] }],
          }),
        PlusError,
        /已在回收站/,
      );

      // Read-only library
      const readOnlyMaster = createMockItem({
        key: "ROMS1111",
        libraryID: 2,
        itemType: "journalArticle",
      });
      const readOnlyDonor = createMockItem({
        key: "RODN1111",
        libraryID: 2,
        itemType: "journalArticle",
      });
      mockDB.set("2:ROMS1111", readOnlyMaster);
      mockDB.set("2:RODN1111", readOnlyDonor);
      await assertRejects(
        () =>
          service.prepare({
            libraryID: 2,
            groups: [{ masterKey: "ROMS1111", otherKeys: ["RODN1111"] }],
          }),
        PlusError,
        /不可编辑/,
      );
    });

    it("strictly blocks forbidden system fields in fieldSources", async function () {
      const master = createMockItem({
        key: "MSTR1111",
        libraryID: 1,
        itemType: "journalArticle",
      });
      const donor = createMockItem({
        key: "DONR1111",
        libraryID: 1,
        itemType: "journalArticle",
      });
      mockDB.set("1:MSTR1111", master);
      mockDB.set("1:DONR1111", donor);

      await assertRejects(
        () =>
          service.prepare({
            libraryID: 1,
            groups: [
              {
                masterKey: "MSTR1111",
                otherKeys: ["DONR1111"],
                fieldSources: { key: "DONR1111" },
              },
            ],
          }),
        PlusError,
        /禁止通过 fieldSources 修改系统字段/,
      );

      await assertRejects(
        () =>
          service.prepare({
            libraryID: 1,
            groups: [
              {
                masterKey: "MSTR1111",
                otherKeys: ["DONR1111"],
                fieldSources: { libraryID: "DONR1111" },
              },
            ],
          }),
        PlusError,
        /禁止通过 fieldSources 修改系统字段/,
      );
    });

    it("blocks strong DOI and ISBN conflicts with explicit blockers", async function () {
      const master = createMockItem({
        key: "MSTR1111",
        fields: { DOI: "10.1000/182", ISBN: "978-0-306-40615-7" },
      });
      const donorDOIConflict = createMockItem({
        key: "DONR1111",
        fields: { DOI: "10.1000/999-DIFFERENT", ISBN: "978-0-306-40615-7" },
      });
      mockDB.set("1:MSTR1111", master);
      mockDB.set("1:DONR1111", donorDOIConflict);

      const plan = await service.prepare({
        libraryID: 1,
        groups: [{ masterKey: "MSTR1111", otherKeys: ["DONR1111"] }],
      });

      expect(plan.steps[0].blockers).to.be.an("array").with.lengthOf(1);
      expect(plan.steps[0].blockers![0].code).to.equal("DOI_CONFLICT");

      // Check method fails closed when step has blockers
      await assertRejects(
        () => service.check(plan.steps[0]),
        PlusError,
        /存在阻断项/,
      );
    });

    it("strictly blocks donor PDF or Web attachments under preserve_all policy using numeric IDs, even if trashed", async function () {
      const master = createMockItem({ key: "MSTR1111" });

      // 1. Donor 持有活跃 PDF 附件（返回数字 ID）
      const pdfAttachment = createMockAttachment({
        key: "ATT1PDF1",
        isPDF: true,
        deleted: false,
      });
      mockDB.set("1:ATT1PDF1", pdfAttachment);

      const donorWithActivePDF = createMockItem({
        key: "DONR1111",
        attachmentIDs: [pdfAttachment.id],
      });
      mockDB.set("1:MSTR1111", master);
      mockDB.set("1:DONR1111", donorWithActivePDF);

      const plan1 = await service.prepare({
        libraryID: 1,
        groups: [{ masterKey: "MSTR1111", otherKeys: ["DONR1111"] }],
      });
      expect(plan1.steps[0].blockers).to.be.an("array");
      expect(plan1.steps[0].blockers![0].code).to.equal(
        "ATTACHMENT_PRESERVATION_UNSUPPORTED",
      );

      // 2. Donor 持有在回收站中的 PDF 附件（返回数字 ID）必须被拦截！
      const trashedPDFAttachment = createMockAttachment({
        key: "ATT2PDF2",
        isPDF: true,
        deleted: true,
      });
      mockDB.set("1:ATT2PDF2", trashedPDFAttachment);

      const donorWithTrashedPDF = createMockItem({
        key: "DONR2222",
        attachmentIDs: [trashedPDFAttachment.id],
      });
      mockDB.set("1:DONR2222", donorWithTrashedPDF);

      const plan2 = await service.prepare({
        libraryID: 1,
        groups: [{ masterKey: "MSTR1111", otherKeys: ["DONR2222"] }],
      });
      expect(plan2.steps[0].blockers).to.be.an("array");
      expect(plan2.steps[0].blockers![0].code).to.equal(
        "ATTACHMENT_PRESERVATION_UNSUPPORTED",
      );

      // 3. Donor 持有在回收站中的 Web 附件（返回数字 ID）必须被拦截！
      const webAttachment = createMockAttachment({
        key: "ATT3WEB3",
        isWeb: true,
        deleted: true,
      });
      mockDB.set("1:ATT3WEB3", webAttachment);

      const donorWithWeb = createMockItem({
        key: "DONR3333",
        attachmentIDs: [webAttachment.id],
      });
      mockDB.set("1:DONR3333", donorWithWeb);

      const plan3 = await service.prepare({
        libraryID: 1,
        groups: [{ masterKey: "MSTR1111", otherKeys: ["DONR3333"] }],
      });
      expect(plan3.steps[0].blockers).to.be.an("array");
      expect(plan3.steps[0].blockers![0].code).to.equal(
        "ATTACHMENT_PRESERVATION_UNSUPPORTED",
      );

      // 4. Master 持有 PDF，Donor 仅持有普通非 PDF/Web 附件被允许！
      const plainAttachment = createMockAttachment({
        key: "ATT4DATA",
        isPDF: false,
        isWeb: false,
        deleted: false,
      });
      mockDB.set("1:ATT4DATA", plainAttachment);

      const masterWithPDF = createMockItem({
        key: "MSTR2222",
        attachmentIDs: [pdfAttachment.id],
      });
      const donorWithPlain = createMockItem({
        key: "DONR4444",
        attachmentIDs: [plainAttachment.id],
      });

      mockDB.set("1:MSTR2222", masterWithPDF);
      mockDB.set("1:DONR4444", donorWithPlain);

      const planAllowed = await service.prepare({
        libraryID: 1,
        groups: [{ masterKey: "MSTR2222", otherKeys: ["DONR4444"] }],
      });
      expect(planAllowed.steps[0].blockers).to.be.undefined;
    });

    it("includes children and inbound relation owners into write targets and checks permissions", async function () {
      const master = createMockItem({ key: "MSTA1111" });

      const childAtt = createMockAttachment({
        key: "ATTA1111",
        isPDF: false,
        isWeb: false,
        deleted: false,
      });
      const childNote = createMockNote({
        key: "NOTA1111",
        deleted: true, // trashed child
      });
      mockDB.set("1:ATTA1111", childAtt);
      mockDB.set("1:NOTA1111", childNote);

      const donor = createMockItem({
        key: "DNRA1111",
        attachmentIDs: [childAtt.id],
        noteIDs: [childNote.id],
      });
      mockDB.set("1:MSTA1111", master);
      mockDB.set("1:DNRA1111", donor);

      // 同库入站关系拥有者
      const inboundOwner = createMockItem({ key: "OWNR1111" });
      mockDB.set("1:OWNR1111", inboundOwner);
      mockRelations.push({
        subject: inboundOwner,
        predicate: "dc:relation",
        object: `http://zotero.org/users/1/items/${donor.key}`,
      });

      const plan = await service.prepare({
        libraryID: 1,
        groups: [{ masterKey: "MSTA1111", otherKeys: ["DNRA1111"] }],
      });

      const targetKeys = plan.steps[0].targets.map((t) => t.key);
      expect(targetKeys).to.include("MSTA1111");
      expect(targetKeys).to.include("DNRA1111");
      expect(targetKeys).to.include("ATTA1111");
      expect(targetKeys).to.include("NOTA1111");
      expect(targetKeys).to.include("OWNR1111");

      // Preview 必须正确列出真实的迁移项 keys
      const p = plan.steps[0].preview;
      expect(p.reparentAttachments[0].key).to.equal("ATTA1111");
      expect(p.reparentNotes[0].key).to.equal("NOTA1111");
      expect(p.reparentNotes[0].deleted).to.be.true;
      expect(p.inboundRelationOwners).to.include("OWNR1111");
    });

    it("blocks cross-group target collision when groups share children or inbound owners", async function () {
      const masterA = createMockItem({ key: "MSTA1111" });
      const donorA = createMockItem({ key: "DNRA1111" });
      const masterB = createMockItem({ key: "MSTB2222" });
      const donorB = createMockItem({ key: "DNRB2222" });
      const externalRelationOwner = createMockItem({ key: "OWNR1111" });

      mockDB.set("1:MSTA1111", masterA);
      mockDB.set("1:DNRA1111", donorA);
      mockDB.set("1:MSTB2222", masterB);
      mockDB.set("1:DNRB2222", donorB);
      mockDB.set("1:OWNR1111", externalRelationOwner);

      // OWNR1111 同时关联 donorA 与 donorB -> 两组写入范围存在交叉
      mockRelations.push({
        subject: externalRelationOwner,
        predicate: "dc:relation",
        object: `http://zotero.org/users/1/items/${donorA.key}`,
      });
      mockRelations.push({
        subject: externalRelationOwner,
        predicate: "dc:relation",
        object: `http://zotero.org/users/1/items/${donorB.key}`,
      });

      await assertRejects(
        () =>
          service.prepare({
            libraryID: 1,
            groups: [
              { masterKey: "MSTA1111", otherKeys: ["DNRA1111"] },
              { masterKey: "MSTB2222", otherKeys: ["DNRB2222"] },
            ],
          }),
        PlusError,
        /TARGET_OVERLAP_CONFLICT/,
      );
    });

    it("verifies dry-run zero writes to library items and children", async function () {
      const childAtt = createMockAttachment({
        key: "ATT00001",
        isPDF: false,
        isWeb: false,
      });
      mockDB.set("1:ATT00001", childAtt);

      const master = createMockItem({
        key: "MSTR1111",
        fields: { title: "Master Title", publicationTitle: "Master Journal" },
        creators: [{ firstName: "Master", lastName: "Author" }],
      });
      const donor = createMockItem({
        key: "DONR1111",
        fields: { title: "Donor Title", publicationTitle: "Donor Journal" },
        creators: [{ firstName: "Donor", lastName: "Author" }],
        attachmentIDs: [childAtt.id],
      });
      mockDB.set("1:MSTR1111", master);
      mockDB.set("1:DONR1111", donor);

      const plan = await service.prepare({
        libraryID: 1,
        groups: [
          {
            masterKey: "MSTR1111",
            otherKeys: ["DONR1111"],
            fieldSources: { publicationTitle: "DONR1111" },
            creatorsSourceKey: "DONR1111",
          },
        ],
      });

      // Assert zero writes happened on master, donor, or child
      expect(master.getSaveCallCount()).to.equal(0);
      expect(donor.getSaveCallCount()).to.equal(0);
      expect(master.getField("publicationTitle")).to.equal("Master Journal");
      expect(donor.deleted).to.be.false;

      // Assert preview accurately reflects union and selection
      const p = plan.steps[0].preview;
      expect(p.masterKey).to.equal("MSTR1111");
      expect(p.before.fields.publicationTitle).to.equal("Master Journal");
      expect(p.after.fields.publicationTitle).to.equal("Donor Journal");
      expect(p.after.creators[0].lastName).to.equal("Author");
      expect(p.donors[0].key).to.equal("DONR1111");
      expect(p.donors[0].deleted).to.be.true;
    });
  });

  describe("Check, Execute and Reconcile safety semantics", function () {
    const service = new DuplicateService();

    it("check detects item or child mutation after plan creation, throwing STATE_CHANGED", async function () {
      const childAtt = createMockAttachment({
        key: "ATT00001",
        version: 1,
      });
      mockDB.set("1:ATT00001", childAtt);

      const master = createMockItem({ key: "MSTR1111", version: 1 });
      const donor = createMockItem({
        key: "DONR1111",
        version: 1,
        attachmentIDs: [childAtt.id],
      });
      mockDB.set("1:MSTR1111", master);
      mockDB.set("1:DONR1111", donor);

      const plan = await service.prepare({
        libraryID: 1,
        groups: [{ masterKey: "MSTR1111", otherKeys: ["DONR1111"] }],
      });

      // 1. 修改 master version
      master.version = 2;
      await assertRejects(
        () => service.check(plan.steps[0]),
        PlusError,
        /STATE_CHANGED/,
      );
      master.version = 1;

      // 2. 修改 child attachment version 同样必须触发 STATE_CHANGED！
      childAtt.version = 2;
      await assertRejects(
        () => service.check(plan.steps[0]),
        PlusError,
        /STATE_CHANGED/,
      );
    });

    it("execute uses verified native merge without nested transaction and invokes real item.reload", async function () {
      const master = createMockItem({
        key: "MSTR1111",
        fields: { title: "Original Master" },
      });
      const donor = createMockItem({
        key: "DONR1111",
        fields: { title: "Donor Title" },
        creators: [{ firstName: "Chosen", lastName: "Creator" }],
      });
      mockDB.set("1:MSTR1111", master);
      mockDB.set("1:DONR1111", donor);

      const plan = await service.prepare({
        libraryID: 1,
        groups: [
          {
            masterKey: "MSTR1111",
            otherKeys: ["DONR1111"],
            fieldSources: { title: "DONR1111" },
            creatorsSourceKey: "DONR1111",
          },
        ],
      });

      let nativeCalled = false;
      let masterSavedPriorToNative = false;

      currentMockNativeMerge = async (m: any, d: any[]) => {
        nativeCalled = true;
        masterSavedPriorToNative = m.getSaveCallCount() > 0;
        d.forEach((item) => (item.deleted = true));
      };

      const mockContext = {
        taskID: "task-1",
        attemptID: "att-1",
        signal: new AbortController().signal,
        update: async () => {},
      };

      const outcome = await service.execute(plan.steps[0], mockContext);

      expect(nativeCalled).to.be.true;
      expect(masterSavedPriorToNative).to.be.false;
      expect(outcome.state).to.equal("succeeded");
      expect(donor.deleted).to.be.true;

      // 验证执行完后调用了真正的 reload (item.reload(undefined, true))
      expect(master.getReloadCallCount()).to.be.greaterThan(0);
      expect(donor.getReloadCallCount()).to.be.greaterThan(0);
    });

    it("refuses to declare succeeded or externally_satisfied if children failed to reparent", async function () {
      const childAtt = createMockAttachment({
        key: "ATT00001",
        isPDF: false,
        isWeb: false,
      });
      mockDB.set("1:ATT00001", childAtt);

      const master = createMockItem({ key: "MSTR1111" });
      const donor = createMockItem({
        key: "DONR1111",
        attachmentIDs: [childAtt.id],
      });
      mockDB.set("1:MSTR1111", master);
      mockDB.set("1:DONR1111", donor);

      const plan = await service.prepare({
        libraryID: 1,
        groups: [{ masterKey: "MSTR1111", otherKeys: ["DONR1111"] }],
      });

      const mockContext = {
        taskID: "task-1",
        attemptID: "att-1",
        signal: new AbortController().signal,
        update: async () => {},
      };

      // 模拟不完整的合并：虽然 donor.deleted=true，但附件并未迁移到 master (parentItemID 仍然不是 master.id)
      currentMockNativeMerge = async (_m: any, d: any[]) => {
        d.forEach((item) => (item.deleted = true));
        childAtt.parentItemID = 999999; // 未正确迁移到 master.id
      };

      const executeOutcome = await service.execute(plan.steps[0], mockContext);
      // 后置条件校验未通过，必须返回 needs_review 且 retrySafe: false
      expect(executeOutcome.state).to.equal("needs_review");
      expect(executeOutcome.retrySafe).to.be.false;
      expect(executeOutcome.error?.message).to.include("未正确重新挂接");

      // reconcile 同样必须判为 needs_review，绝不因 donor.deleted=true 误报 externally_satisfied
      const reconcileOutcome = await service.reconcile(plan.steps[0]);
      expect(reconcileOutcome.state).to.equal("needs_review");
      expect(reconcileOutcome.retrySafe).to.be.false;
    });

    it("refuses to declare succeeded or externally_satisfied if inbound relation rewrite failed", async function () {
      const master = createMockItem({ key: "MSTR1111" });
      const donor = createMockItem({ key: "DONR1111" });
      const inboundOwner = createMockItem({ key: "OWNR1111" });

      mockDB.set("1:MSTR1111", master);
      mockDB.set("1:DONR1111", donor);
      mockDB.set("1:OWNR1111", inboundOwner);

      const donorURI = `http://zotero.org/users/1/items/${donor.key}`;
      inboundOwner.addRelation("dc:relation", donorURI);
      mockRelations.push({
        subject: inboundOwner,
        predicate: "dc:relation",
        object: donorURI,
      });

      const plan = await service.prepare({
        libraryID: 1,
        groups: [{ masterKey: "MSTR1111", otherKeys: ["DONR1111"] }],
      });

      const mockContext = {
        taskID: "task-1",
        attemptID: "att-1",
        signal: new AbortController().signal,
        update: async () => {},
      };

      // 模拟不完整的合并：虽然 donor.deleted=true，但入站关系未能重写（依旧指向 donorURI）
      currentMockNativeMerge = async (_m: any, d: any[]) => {
        d.forEach((item) => (item.deleted = true));
        // 不重写关系，保留旧引用
      };

      const outcome = await service.execute(plan.steps[0], mockContext);
      expect(outcome.state).to.equal("needs_review");
      expect(outcome.retrySafe).to.be.false;
      expect(outcome.error?.message).to.include("旧关系引用");

      const rec = await service.reconcile(plan.steps[0]);
      expect(rec.state).to.equal("needs_review");
      expect(rec.retrySafe).to.be.false;
    });

    it("handles native merge exception: recognizes succeeded if 6-point postconditions are met, marks needs_review without retrySafe otherwise", async function () {
      const master = createMockItem({ key: "MSTR1111" });
      const donor = createMockItem({ key: "DONR1111" });
      mockDB.set("1:MSTR1111", master);
      mockDB.set("1:DONR1111", donor);

      const plan = await service.prepare({
        libraryID: 1,
        groups: [{ masterKey: "MSTR1111", otherKeys: ["DONR1111"] }],
      });

      const mockContext = {
        taskID: "task-1",
        attemptID: "att-1",
        signal: new AbortController().signal,
        update: async () => {},
      };

      // Case 1: 原生事务完全成功并落库，但外部 late observer 抛异常
      currentMockNativeMerge = async (_m: any, d: any[]) => {
        d.forEach((item) => (item.deleted = true));
        throw new Error("Late notifier observer crash");
      };

      const outcome1 = await service.execute(plan.steps[0], mockContext);
      expect(outcome1.state).to.equal("succeeded");
      expect(outcome1.result?.nativeNotice).to.include(
        "Late notifier observer crash",
      );

      // Case 2: 原生事务中止，donor 未标记删除 -> needs_review (绝不授权 retrySafe)
      donor.deleted = false;
      currentMockNativeMerge = async () => {
        throw new Error("Transaction aborted");
      };

      const outcome2 = await service.execute(plan.steps[0], mockContext);
      expect(outcome2.state).to.equal("needs_review");
      expect(outcome2.retrySafe).to.be.false;
    });

    it("reconcile: externally_satisfied when all 6 postconditions pass, needs_review for incomplete/unproven states", async function () {
      const master = createMockItem({ key: "MSTR1111" });
      const donor = createMockItem({ key: "DONR1111" });
      mockDB.set("1:MSTR1111", master);
      mockDB.set("1:DONR1111", donor);

      const step: PlanStep = {
        id: "step-1",
        input: {
          libraryID: 1,
          masterKey: "MSTR1111",
          otherKeys: ["DONR1111"],
        },
        targets: [],
        fingerprint: "abc",
        preview: {},
      };

      // 1. 未触碰状态 -> needs_review (不能证明原生已完成，绝不 retrySafe)
      const rec1 = await service.reconcile(step);
      expect(rec1.state).to.equal("needs_review");
      expect(rec1.retrySafe).to.be.false;

      // 2. 全部后置条件达成 -> externally_satisfied (retrySafe: false)
      donor.deleted = true;
      const rec2 = await service.reconcile(step);
      expect(rec2.state).to.equal("externally_satisfied");
      expect(rec2.retrySafe).to.be.false;

      // 3. 不可核实状态 (master 异常在回收站) -> needs_review
      master.deleted = true;
      const rec3 = await service.reconcile(step);
      expect(rec3.state).to.equal("needs_review");
      expect(rec3.retrySafe).to.be.false;
    });
  });

  describe("findDuplicates bounded scanning and conflict detection", function () {
    it("detects duplicates with identical normalized DOI or ISBN", async function () {
      const item1 = createMockItem({
        key: "ITEM0001",
        fields: {
          title: "First Paper Title",
          DOI: "https://doi.org/10.1000/182",
        },
      });
      const item2 = createMockItem({
        key: "ITEM0002",
        fields: {
          title: "Different Title Completely",
          DOI: "http://dx.doi.org/10.1000/182",
        },
      });
      mockDB.set("1:ITEM0001", item1);
      mockDB.set("1:ITEM0002", item2);

      const res = await findDuplicates({ libraryID: 1 });
      expect(res.complete).to.be.true;
      expect(res.groups).to.have.lengthOf(1);
      expect(res.groups[0].matchReason).to.equal("IDENTICAL_DOI");
      expect(res.groups[0].confidence).to.equal("high");
      expect(res.groups[0].itemKeys).to.include("ITEM0001");
      expect(res.groups[0].itemKeys).to.include("ITEM0002");
    });

    it("matches by title + author + year, but strictly blocks if DOIs conflict", async function () {
      const itemA = createMockItem({
        key: "ITEM000A",
        fields: {
          title: "Quantum Computing Advances",
          date: "2022",
          DOI: "10.1000/AAA",
        },
        creators: [{ lastName: "Turing" }],
      });
      const itemB = createMockItem({
        key: "ITEM000B",
        fields: {
          title: "Quantum Computing Advances: A Review",
          date: "2022",
          DOI: "10.1000/BBB",
        },
        creators: [{ lastName: "Turing" }],
      });
      mockDB.set("1:ITEM000A", itemA);
      mockDB.set("1:ITEM000B", itemB);

      // Title/Author/Year match, but DOIs are in conflict -> must NOT cluster as duplicates!
      const res = await findDuplicates({ libraryID: 1 });
      expect(res.groups).to.have.lengthOf(0);
    });

    it("does not blindly merge A-B and B-C when A and C have a strong conflict", async function () {
      // A and B match via Title
      // B has no DOI
      // A has DOI 10.1000/AAA
      // C has DOI 10.1000/CCC
      const itemA = createMockItem({
        key: "ITEM000A",
        fields: {
          title: "Machine Learning Foundations",
          date: "2020",
          DOI: "10.1000/AAA",
        },
        creators: [{ lastName: "Ng" }],
      });
      const itemB = createMockItem({
        key: "ITEM000B",
        fields: { title: "Machine Learning Foundations", date: "2020" },
        creators: [{ lastName: "Ng" }],
      });
      const itemC = createMockItem({
        key: "ITEM000C",
        fields: {
          title: "Machine Learning Foundations",
          date: "2020",
          DOI: "10.1000/CCC",
        },
        creators: [{ lastName: "Ng" }],
      });
      mockDB.set("1:ITEM000A", itemA);
      mockDB.set("1:ITEM000B", itemB);
      mockDB.set("1:ITEM000C", itemC);

      const res = await findDuplicates({ libraryID: 1 });
      for (const group of res.groups) {
        expect(
          group.itemKeys.includes("ITEM000A") &&
            group.itemKeys.includes("ITEM000C"),
        ).to.be.false;
      }
    });

    it("respects maxItems, offset, pagination, and excludes trashed items with clear coverage note", async function () {
      for (let i = 0; i < 15; i++) {
        const it = createMockItem({
          key: `PGIT${String(i).padStart(4, "0")}`,
          fields: { title: `Paper Number ${i}` },
          deleted: i === 0, // item 0 is trashed
        });
        mockDB.set(`1:${it.key}`, it);
      }

      const res = await findDuplicates({
        libraryID: 1,
        maxItems: 5,
        offset: 0,
      });
      expect(res.coverage.scannedCount).to.equal(5);
      expect(res.coverage.complete).to.be.false;
      expect(res.coverage.maxItems).to.equal(5);
      expect(res.coverage.offset).to.equal(0);
      expect(res.coverage.nextOffset).to.equal(5);
      expect(res.coverage.note).to.include("仅覆盖条目区间");
      expect(res.coverage.note).to.include(
        "跨越未扫描分页的潜在重复项未被检测",
      );

      // 当 offset > 0 且扫描至列表末尾时，complete 仍为 false，不能误报全库已检
      const resEnd = await findDuplicates({
        libraryID: 1,
        maxItems: 20,
        offset: 5,
      });
      expect(resEnd.coverage.complete).to.be.false;
      expect(resEnd.coverage.reachedEnd).to.be.true;
      expect(resEnd.coverage.note).to.include("不能判定全库已完全去重");
    });
  });
});
