import { expect } from "chai";
import {
  libraryHealth,
  determineAttachmentFileStatus,
  checkItemMetadataDeficiencies,
} from "../../src/modules/healthService.ts";

/**
 * 构造模拟的 Regular Item
 */
function createMockItem(options: {
  key: string;
  id?: number;
  libraryID?: number;
  itemType?: string;
  deleted?: boolean;
  fields?: Record<string, any>;
  creators?: any[];
  dateAdded?: string;
}) {
  const key = options.key;
  const id = options.id || Math.floor(Math.random() * 100000) + 1;
  const libraryID = options.libraryID !== undefined ? options.libraryID : 1;
  const itemType = options.itemType || "journalArticle";
  const deleted = !!options.deleted;
  const fields = { title: `Title ${key}`, ...options.fields };
  const creators =
    options.creators !== undefined
      ? options.creators
      : [{ firstName: "John", lastName: "Doe" }];

  let saveCalls = 0;

  return {
    id,
    key,
    libraryID,
    itemType,
    deleted,
    dateAdded: options.dateAdded || "2023-01-01T00:00:00Z",
    isRegularItem: () =>
      !["attachment", "note", "annotation"].includes(itemType),
    isAttachment: () => false,
    getField: (f: string) => fields[f],
    getCreators: () => creators,
    getAttachments: () => [],
    getNotes: () => [],
    save: async () => {
      saveCalls++;
    },
    getSaveCalls: () => saveCalls,
  };
}

/**
 * 构造模拟的 Attachment Item
 */
function createMockAttachment(options: {
  key: string;
  id?: number;
  libraryID?: number;
  parentItemID?: number;
  parentItemKey?: string;
  isPDF?: boolean;
  isWeb?: boolean;
  linkMode?: number;
  deleted?: boolean;
  fileExists?: boolean;
  isStored?: boolean;
  downloadState?: string;
  isDownloaded?: boolean;
  syncState?: number;
  filename?: string;
}) {
  const id = options.id || Math.floor(Math.random() * 100000) + 1;
  const key = options.key;
  const libraryID = options.libraryID !== undefined ? options.libraryID : 1;
  const deleted = !!options.deleted;
  const isPDF = !!options.isPDF;
  const isWeb = !!options.isWeb;
  const linkMode = options.linkMode !== undefined ? options.linkMode : 0; // 0 = IMPORTED_FILE
  const fileExists =
    options.fileExists !== undefined ? options.fileExists : true;
  const isStored = options.isStored !== undefined ? options.isStored : true;

  let saveCalls = 0;

  return {
    id,
    key,
    libraryID,
    itemType: "attachment",
    parentItemID: options.parentItemID,
    parentItemKey: options.parentItemKey,
    deleted,
    attachmentLinkMode: linkMode,
    attachmentContentType: isPDF
      ? "application/pdf"
      : isWeb
        ? "text/html"
        : "application/octet-stream",
    attachmentFilename: options.filename || `${key}.pdf`,
    filename: options.filename || `${key}.pdf`,
    syncState: options.syncState,
    downloadState: options.downloadState,
    isDownloaded: options.isDownloaded,
    isRegularItem: () => false,
    isAttachment: () => true,
    isPDFAttachment: () => isPDF,
    isWebAttachment: () => isWeb,
    isStoredFileAttachment: () => isStored,
    fileExists: () => fileExists,
    getField: (f: string) => (f === "title" ? `Attachment ${key}` : ""),
    save: async () => {
      saveCalls++;
    },
    getSaveCalls: () => saveCalls,
  };
}

describe("healthService unit tests", function () {
  let mockDB: Map<string, any>;

  beforeEach(function () {
    mockDB = new Map();

    (globalThis as any).Zotero = {
      Libraries: {
        userLibraryID: 1,
        get: (id: number) => (id === 1 ? { id: 1, editable: true } : null),
      },
      Items: {
        getAll: async (libraryID: number) => {
          const items: any[] = [];
          for (const it of mockDB.values()) {
            if (it.libraryID === libraryID) items.push(it);
          }
          return items;
        },
        getByLibraryAndKeyAsync: async (libraryID: number, key: string) => {
          return mockDB.get(`${libraryID}:${key}`) || null;
        },
        getAsync: async (ids: any) => {
          if (Array.isArray(ids)) {
            return ids
              .map((id) => {
                for (const it of mockDB.values()) {
                  if (it.id === id) return it;
                }
                return null;
              })
              .filter(Boolean);
          }
          return null;
        },
      },
      Attachments: {
        LINK_MODE_IMPORTED_FILE: 0,
        LINK_MODE_IMPORTED_URL: 1,
        LINK_MODE_LINKED_FILE: 2,
        LINK_MODE_LINKED_URL: 3,
      },
      URI: {
        getItemURI: (it: any) => `http://zotero.org/items/${it.key}`,
      },
    };
  });

  afterEach(function () {
    delete (globalThis as any).Zotero;
  });

  describe("determineAttachmentFileStatus", function () {
    it("classifies linked URL as linked_url regardless of file existence", function () {
      const att = createMockAttachment({
        key: "URLATT01",
        linkMode: 3, // LINK_MODE_LINKED_URL
        fileExists: false,
      });
      const res = determineAttachmentFileStatus(att);
      expect(res.status).to.equal("linked_url");
    });

    it("classifies existing local file as available", function () {
      const att = createMockAttachment({
        key: "AVLATT01",
        linkMode: 0,
        fileExists: true,
      });
      const res = determineAttachmentFileStatus(att);
      expect(res.status).to.equal("available");
    });

    it("does not falsely report un-downloaded cloud attachment as damaged or missing", function () {
      const attPending = createMockAttachment({
        key: "CLDATT01",
        linkMode: 0,
        fileExists: false,
        isStored: true,
        downloadState: "pending",
      });
      const res1 = determineAttachmentFileStatus(attPending);
      expect(res1.status).to.equal("not_local");

      const attUnsynced = createMockAttachment({
        key: "CLDATT02",
        linkMode: 0,
        fileExists: false,
        isStored: true,
        isDownloaded: false,
      });
      const res2 = determineAttachmentFileStatus(attUnsynced);
      expect(res2.status).to.equal("not_local");
    });

    it("classifies missing stored file as missing when local file is truly absent", function () {
      const attMissing = createMockAttachment({
        key: "MISATT01",
        linkMode: 0,
        fileExists: false,
        isStored: true,
        downloadState: undefined,
        isDownloaded: undefined,
        syncState: 0, // synced metadata, but local file missing
      });
      const res = determineAttachmentFileStatus(attMissing);
      expect(res.status).to.equal("missing");
    });
  });

  describe("checkItemMetadataDeficiencies", function () {
    it("detects missing required and recommended fields by itemType", function () {
      const article = createMockItem({
        key: "ART00001",
        itemType: "journalArticle",
        fields: {
          title: "A Valid Title",
          // missing publicationTitle, date, DOI
        },
      });
      const check = checkItemMetadataDeficiencies(article);
      expect(check.missingRequired).to.be.empty;
      expect(check.missingRecommended).to.include("publicationTitle");
      expect(check.missingRecommended).to.include("date");
      expect(check.missingRecommended).to.include("DOI");
      expect(check.missingCreators).to.be.false;

      const bookWithoutTitle = createMockItem({
        key: "BOK00001",
        itemType: "book",
        fields: {
          title: "",
          publisher: "MIT Press",
        },
        creators: [],
      });
      const checkBook = checkItemMetadataDeficiencies(bookWithoutTitle);
      expect(checkBook.missingRequired).to.include("title");
      expect(checkBook.missingCreators).to.be.true;
    });
  });

  describe("libraryHealth comprehensive scan", function () {
    it("reports standalone PDFs vs other standalone attachments, and does not count child attachments as standalone", async function () {
      // Standalone PDF
      const standPDF = createMockAttachment({
        key: "STDPDF01",
        isPDF: true,
        parentItemID: undefined,
      });
      // Standalone non-PDF
      const standOther = createMockAttachment({
        key: "STDOTH01",
        isPDF: false,
        isWeb: false,
        parentItemID: undefined,
      });
      // Child PDF attached to a parent item
      const childPDF = createMockAttachment({
        key: "CHDPDF01",
        isPDF: true,
        parentItemID: 12345,
      });

      mockDB.set("1:STDPDF01", standPDF);
      mockDB.set("1:STDOTH01", standOther);
      mockDB.set("1:CHDPDF01", childPDF);

      const health = await libraryHealth({ libraryID: 1 });

      expect(health.standaloneAttachments.pdfCount).to.equal(1);
      expect(health.standaloneAttachments.pdfSamples).to.include("STDPDF01");
      expect(health.standaloneAttachments.otherCount).to.equal(1);
      expect(health.standaloneAttachments.otherSamples).to.include("STDOTH01");

      // Suggests recognize_pdfs tool
      const toolNames = health.suggestedTools.map((t: any) => t.tool);
      expect(toolNames).to.include("recognize_pdfs");
    });

    it("ensures zero writes occur during health check", async function () {
      const item = createMockItem({ key: "ITEM0001" });
      const att = createMockAttachment({ key: "ATT00001" });
      mockDB.set("1:ITEM0001", item);
      mockDB.set("1:ATT00001", att);

      await libraryHealth({ libraryID: 1 });

      expect(item.getSaveCalls()).to.equal(0);
      expect(att.getSaveCalls()).to.equal(0);
    });

    it("integrates taskSummary into health report and recommends task_control if needed", async function () {
      const item = createMockItem({ key: "ITEM0001" });
      mockDB.set("1:ITEM0001", item);

      const taskSummary = {
        interruptedCount: 2,
        needsReviewCount: 1,
        details: [{ taskID: "task-abc", state: "interrupted" }],
      };

      const health = await libraryHealth({ libraryID: 1 }, taskSummary);
      expect(health.tasks.interruptedCount).to.equal(2);
      expect(health.tasks.needsReviewCount).to.equal(1);

      const toolNames = health.suggestedTools.map((t: any) => t.tool);
      expect(toolNames).to.include("task_control");
    });

    it("strictly refuses to leak absolute file paths in health report", async function () {
      const attWithMissing = createMockAttachment({
        key: "ATTPATH1",
        fileExists: false,
        filename: "test-paper.pdf",
      });
      mockDB.set("1:ATTPATH1", attWithMissing);

      const health = await libraryHealth({ libraryID: 1 });
      const jsonStr = JSON.stringify(health);

      // Verify no absolute path indicators like C:\, E:\, /home/, /Users/ exist in the report
      expect(jsonStr).to.not.match(/[A-Za-z]:\\[\w.-]/);
      expect(jsonStr).to.not.match(/\/Users\/[\w.-]/);
      expect(jsonStr).to.not.match(/\/home\/[\w.-]/);
    });

    it("respects maxItems, offset, pagination, and provides accurate coverage note without exaggerating cross-page deduplication", async function () {
      for (let i = 0; i < 25; i++) {
        const item = createMockItem({
          key: `HLT${String(i).padStart(5, "0")}`,
        });
        mockDB.set(`1:${item.key}`, item);
      }

      const res = await libraryHealth({
        libraryID: 1,
        maxItems: 10,
        offset: 0,
      });
      expect(res.coverage.scannedCount).to.equal(10);
      expect(res.coverage.complete).to.be.false;
      expect(res.coverage.maxItems).to.equal(10);
      expect(res.coverage.offset).to.equal(0);
      expect(res.coverage.nextOffset).to.equal(10);
      expect(res.coverage.note).to.include("仅覆盖条目区间");
      expect(res.duplicateCandidates.coverageNote).to.include(
        "跨越未扫描分页的潜在重复项未被检测",
      );

      // 当 offset > 0 扫到末尾时，complete 仍为 false，不能宣称全库已检
      const resEnd = await libraryHealth({
        libraryID: 1,
        maxItems: 30,
        offset: 10,
      });
      expect(resEnd.coverage.complete).to.be.false;
      expect(resEnd.coverage.reachedEnd).to.be.true;
      expect(resEnd.coverage.note).to.include("不能宣称全库已完全检查");
      expect(resEnd.duplicateCandidates.coverage?.offset).to.equal(10);
    });

    it("supports collectionKey scoped health scanning", async function () {
      const colItem1 = createMockItem({ key: "COLITM01" });
      const colItem2 = createMockItem({ key: "COLITM02" });
      const otherItem = createMockItem({ key: "OTHITM01" });

      mockDB.set("1:COLITM01", colItem1);
      mockDB.set("1:COLITM02", colItem2);
      mockDB.set("1:OTHITM01", otherItem);

      (globalThis as any).Zotero.Collections = {
        getByLibraryAndKey: (_libID: number, colKey: string) => {
          if (colKey === "COLKEY01") {
            return {
              getChildItems: () => [colItem1.id, colItem2.id],
            };
          }
          return null;
        },
      };

      const res = await libraryHealth({
        libraryID: 1,
        collectionKey: "COLKEY01",
        maxItems: 50,
      });

      expect(res.collectionKey).to.equal("COLKEY01");
      expect(res.coverage.totalEstimated).to.equal(2);
      expect(res.coverage.complete).to.be.true;
    });
  });
});
