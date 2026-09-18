import { expect } from "chai";
import {
  findStandaloneAttachments,
  determineAttachmentFileStatus,
  isPDFAttachment,
  getItemCollectionKeys,
} from "../../src/modules/standaloneService.ts";
import { PlusError } from "../../src/modules/plusTypes.ts";

async function expectRejection(
  promise: Promise<any>,
  errorType?: any,
  pattern?: RegExp,
): Promise<any> {
  let caught: any = null;
  try {
    await promise;
  } catch (err: any) {
    caught = err;
  }
  expect(caught, "Expected promise to reject").to.not.be.null;
  if (errorType) {
    expect(caught).to.be.instanceOf(errorType);
  }
  if (pattern) {
    expect(`${caught.code || ""} ${caught.message}`).to.match(pattern);
  }
  return caught;
}

describe("standaloneService", function () {
  let fakeZotero: any;
  let itemsMap: Map<any, any>;
  let searchConditions: any[];

  function createMockAttachment(opts: {
    id: number;
    key: string;
    libraryID?: number;
    parentItemID?: number | null;
    parentItem?: any;
    contentType?: string;
    filename?: string;
    title?: string;
    deleted?: boolean;
    fileExists?: boolean | (() => Promise<boolean>);
    collections?: any[];
    linkMode?: number;
    syncState?: number | string;
    dateAdded?: string;
    dateModified?: string;
    isTopLevel?: boolean;
    tags?: any[];
    isAttachment?: boolean;
    itemType?: string;
    content?: string;
  }) {
    const item = {
      id: opts.id,
      key: opts.key,
      libraryID: opts.libraryID ?? 1,
      itemType: opts.itemType ?? "attachment",
      parentItemID: opts.parentItemID ?? null,
      parentItem: opts.parentItem ?? null,
      attachmentContentType: opts.contentType ?? "application/pdf",
      attachmentFilename: opts.filename ?? `${opts.key}.pdf`,
      title: opts.title ?? opts.filename ?? `${opts.key}.pdf`,
      deleted: opts.deleted ?? false,
      attachmentLinkMode: opts.linkMode ?? 0,
      attachmentSyncState: opts.syncState,
      dateAdded: opts.dateAdded ?? "2026-09-18 10:00:00",
      dateModified: opts.dateModified ?? "2026-09-18 10:00:00",
      _collections: opts.collections ?? [],
      _tags: opts.tags ?? [],
      _content: opts.content ?? "",
      isAttachment() {
        if (opts.isAttachment !== undefined) return opts.isAttachment;
        return this.itemType === "attachment";
      },
      isPDFAttachment() {
        return (
          (this.attachmentContentType || "").toLowerCase() === "application/pdf"
        );
      },
      isTopLevelItem() {
        if (opts.isTopLevel !== undefined) return opts.isTopLevel;
        return !this.parentItemID && !this.parentItem;
      },
      isStoredFileAttachment() {
        return this.attachmentLinkMode === 0 || this.attachmentLinkMode === 1;
      },
      isLinkedURLAttachment() {
        return this.attachmentLinkMode === 3;
      },
      async fileExists() {
        if (typeof opts.fileExists === "function") {
          return opts.fileExists();
        }
        return opts.fileExists ?? true;
      },
      getCollections() {
        return this._collections;
      },
      getTags() {
        return this._tags;
      },
      getField(field: string) {
        if (field === "title") return this.title;
        return (this as any)[field];
      },
      // filePath property that must NOT be leaked
      filePath: `C:\\Users\\mock\\zotero\\storage\\${opts.key}\\${opts.filename || "doc.pdf"}`,
    };
    return item;
  }

  beforeEach(function () {
    itemsMap = new Map<any, any>();
    searchConditions = [];

    const librariesMap = new Map<number, any>([
      [1, { id: 1, editable: true, libraryType: "user" }],
      [2, { id: 2, editable: false, libraryType: "group" }],
    ]);

    const collectionsMap = new Map<string, any>([
      ["COLL0001", { id: 101, key: "COLL0001", libraryID: 1 }],
      ["COLL0002", { id: 102, key: "COLL0002", libraryID: 1 }],
    ]);

    class MockSearch {
      libraryID?: number;
      conditions: any[] = [];
      addCondition(condition: string, operator: string, value: any) {
        const cond = { condition, operator, value };
        this.conditions.push(cond);
        searchConditions.push(cond);
      }
      async search(): Promise<number[]> {
        let results = Array.from(itemsMap.values());
        if (this.libraryID) {
          results = results.filter((it) => it.libraryID === this.libraryID);
        }
        for (const cond of this.conditions) {
          if (cond.condition === "itemType" && cond.operator === "is") {
            results = results.filter((it) =>
              typeof it.isAttachment === "function"
                ? it.isAttachment()
                : it.itemType === cond.value,
            );
          }
          if (cond.condition === "collection" && cond.operator === "is") {
            results = results.filter((it) => {
              const collKeys = getItemCollectionKeys(it);
              return collKeys.includes(cond.value);
            });
          }
          if (cond.condition === "fulltextContent") {
            results = results.filter(
              (it) =>
                (it.title || "").includes(cond.value) ||
                (it._content || "").includes(cond.value),
            );
          }
          if (cond.condition === "quicksearch-everything") {
            results = results.filter((it) => {
              const val = String(cond.value).toLowerCase();
              return (
                (it.title || "").toLowerCase().includes(val) ||
                (it._content || "").toLowerCase().includes(val) ||
                (it.key || "").toLowerCase().includes(val)
              );
            });
          }
          if (cond.condition === "tag" && cond.operator === "contains") {
            results = results.filter((it) => {
              const tags = typeof it.getTags === "function" ? it.getTags() : [];
              return tags.some((t: any) =>
                (typeof t === "string" ? t : t.tag || "")
                  .toLowerCase()
                  .includes(String(cond.value).toLowerCase()),
              );
            });
          }
        }
        return results.map((it) => it.id);
      }
    }

    fakeZotero = {
      Libraries: {
        userLibraryID: 1,
        get(id: number) {
          return librariesMap.get(id);
        },
      },
      Collections: {
        get(id: number) {
          for (const c of collectionsMap.values()) {
            if (c.id === id) return c;
          }
          return null;
        },
        getLibraryAndKeyFromID(id: number) {
          for (const c of collectionsMap.values()) {
            if (c.id === id) return { libraryID: c.libraryID, key: c.key };
          }
          return { libraryID: null, key: null };
        },
        getByLibraryAndKey(libID: number, key: string) {
          const c = collectionsMap.get(key);
          return c && c.libraryID === libID ? c : null;
        },
        async getByLibraryAndKeyAsync(libID: number, key: string) {
          return this.getByLibraryAndKey(libID, key);
        },
      },
      Items: {
        _itemsMap: itemsMap,
        get(id: any) {
          for (const item of itemsMap.values()) {
            if (item.id === id) return item;
          }
          return itemsMap.get(id) || null;
        },
        async getAsync(ids?: any) {
          if (ids === undefined) return Array.from(itemsMap.values());
          if (Array.isArray(ids)) {
            return ids.map((id) => this.get(id)).filter(Boolean);
          }
          return this.get(ids);
        },
        async getAll(libraryID: number) {
          return Array.from(itemsMap.values()).filter(
            (it) => it.libraryID === libraryID,
          );
        },
      },
      Search: MockSearch,
      RecognizeDocument: {
        canRecognize(item: any) {
          return item.isPDFAttachment() && item.isTopLevelItem();
        },
      },
      Attachments: {
        LINK_MODE_IMPORTED_FILE: 0,
        LINK_MODE_IMPORTED_URL: 1,
        LINK_MODE_LINKED_FILE: 2,
        LINK_MODE_LINKED_URL: 3,
      },
      Sync: {
        Storage: {
          Local: {
            SYNC_STATE_TO_UPLOAD: 0,
            SYNC_STATE_TO_DOWNLOAD: 1,
            SYNC_STATE_IN_SYNC: 2,
            SYNC_STATE_FORCE_UPLOAD: 3,
            SYNC_STATE_FORCE_DOWNLOAD: 4,
            SYNC_STATE_IN_CONFLICT: 5,
          },
        },
      },
    };

    (globalThis as any).Zotero = fakeZotero;
  });

  afterEach(function () {
    delete (globalThis as any).Zotero;
  });

  describe("getItemCollectionKeys", function () {
    it("resolves 8-character string keys and numeric IDs via Zotero.Collections", function () {
      const item = {
        key: "ITEM0001",
        getCollections: () => ["COLL0001", 102],
      };
      const keys = getItemCollectionKeys(item);
      expect(keys).to.deep.equal(["COLL0001", "COLL0002"]);
    });

    it("throws PlusError COLLECTION_KEY_UNRESOLVED instead of returning fake String(numericID)", function () {
      const badItem = {
        key: "BADITEM1",
        getCollections: () => [88888], // ID 88888 does not exist
      };
      expect(() => getItemCollectionKeys(badItem)).to.throw(PlusError);
      try {
        getItemCollectionKeys(badItem);
      } catch (err: any) {
        expect(err.code).to.equal("COLLECTION_KEY_UNRESOLVED");
      }
    });
  });

  describe("File status determination", function () {
    it("identifies available, not_local, missing, unavailable, and linked_url", async function () {
      // 1. Available
      const itemAvail = createMockAttachment({
        id: 1,
        key: "AVAIL001",
        fileExists: true,
      });
      expect(await determineAttachmentFileStatus(itemAvail)).to.equal(
        "available",
      );

      // 2. Not local (stored file pending sync download)
      const itemNotLocal = createMockAttachment({
        id: 2,
        key: "NOTLOC01",
        fileExists: false,
        linkMode: 0,
        syncState: 1, // SYNC_STATE_TO_DOWNLOAD
      });
      expect(await determineAttachmentFileStatus(itemNotLocal)).to.equal(
        "not_local",
      );

      // 3. Missing (file not found on disk, not pending download)
      const itemMissing = createMockAttachment({
        id: 3,
        key: "MISS0001",
        fileExists: false,
        linkMode: 0,
        syncState: 2, // SYNC_STATE_IN_SYNC but file gone
      });
      expect(await determineAttachmentFileStatus(itemMissing)).to.equal(
        "missing",
      );

      // 4. Unavailable (filesystem access error)
      const itemUnavail = createMockAttachment({
        id: 4,
        key: "UNAVAIL1",
        fileExists: () => {
          throw new Error("EACCES: permission denied");
        },
      });
      expect(await determineAttachmentFileStatus(itemUnavail)).to.equal(
        "unavailable",
      );

      // 5. Linked URL
      const itemUrl = createMockAttachment({
        id: 5,
        key: "URL00001",
        linkMode: 3, // LINK_MODE_LINKED_URL
      });
      expect(await determineAttachmentFileStatus(itemUrl)).to.equal(
        "linked_url",
      );
    });
  });

  describe("findStandaloneAttachments", function () {
    it("validates libraryID and collectionKey", async function () {
      await expectRejection(
        findStandaloneAttachments({ libraryID: -1 }),
        PlusError,
        /libraryID/,
      );

      await expectRejection(
        findStandaloneAttachments({ libraryID: 999 }),
        PlusError,
        /文库不存在/,
      );

      await expectRejection(
        findStandaloneAttachments({ libraryID: 1, collectionKey: "INVALID!" }),
        PlusError,
        /collectionKey/,
      );

      await expectRejection(
        findStandaloneAttachments({ libraryID: 1, collectionKey: "NOTEXIST" }),
        PlusError,
        /指定的集合/,
      );
    });

    it("filters only standalone PDFs by default (excludes child, non-PDF, deleted, cross-library)", async function () {
      // Valid standalone PDF
      const valid1 = createMockAttachment({
        id: 10,
        key: "VALID001",
        fileExists: true,
      });
      // Child attachment
      const child = createMockAttachment({
        id: 11,
        key: "CHILD001",
        parentItemID: 999,
      });
      // EPUB attachment
      const epub = createMockAttachment({
        id: 12,
        key: "EPUB0001",
        contentType: "application/epub+zip",
        filename: "book.epub",
      });
      // Deleted item
      const deleted = createMockAttachment({
        id: 13,
        key: "DEL00001",
        deleted: true,
      });
      // Other library item
      const otherLib = createMockAttachment({
        id: 14,
        key: "OTHERLIB",
        libraryID: 2,
      });

      for (const it of [valid1, child, epub, deleted, otherLib]) {
        itemsMap.set(it.key, it);
      }

      const result = await findStandaloneAttachments({ libraryID: 1 });
      expect(result.total).to.equal(1);
      expect(result.items).to.have.lengthOf(1);
      expect(result.items[0].key).to.equal("VALID001");
      expect(result.items[0].contentType).to.equal("application/pdf");
      expect(result.items[0].canRecognize).to.be.true;
    });

    it("supports options.pdfOnly = false to retain non-PDF standalone attachments (EPUB, HTML) but strictly excludes regular items", async function () {
      const pdf = createMockAttachment({
        id: 15,
        key: "PDF00001",
        contentType: "application/pdf",
      });
      const epub = createMockAttachment({
        id: 16,
        key: "EPUB0002",
        contentType: "application/epub+zip",
        filename: "novel.epub",
      });
      const html = createMockAttachment({
        id: 17,
        key: "HTML0001",
        contentType: "text/html",
        filename: "page.html",
      });
      // Regular book item in library that is NOT an attachment
      const regularBook = createMockAttachment({
        id: 18,
        key: "BOOK0001",
        itemType: "book",
        isAttachment: false,
        title: "A Great Book",
      });

      for (const it of [pdf, epub, html, regularBook]) {
        itemsMap.set(it.key, it);
      }

      // Default pdfOnly=true excludes non-PDF and regular items
      const defaultRes = await findStandaloneAttachments({ libraryID: 1 });
      expect(defaultRes.total).to.equal(1);
      expect(defaultRes.items[0].key).to.equal("PDF00001");

      // options.pdfOnly=false retains EPUB and HTML, but EXCLUDES regular items!
      const allRes = await findStandaloneAttachments(
        { libraryID: 1 },
        { pdfOnly: false },
      );
      expect(allRes.total).to.equal(3);
      const keys = allRes.items.map((i: any) => i.key);
      expect(keys).to.include("PDF00001");
      expect(keys).to.include("EPUB0002");
      expect(keys).to.include("HTML0001");
      expect(keys).to.not.include("BOOK0001");

      // Non-PDF items have canRecognize = false
      const epubItem = allRes.items.find((i: any) => i.key === "EPUB0002");
      expect(epubItem?.canRecognize).to.be.false;
    });

    it("preserves fulltext/content hits from Zotero.Search without wiping them via secondary title filtering", async function () {
      // Document title is generic "report.pdf", but its content/creator matches "Relativity"
      const contentMatch = createMockAttachment({
        id: 22,
        key: "RELAT001",
        title: "report.pdf",
        content: "Theory of General Relativity and Gravitation",
      });
      const nonMatch = createMockAttachment({
        id: 23,
        key: "OTHER002",
        title: "notes.pdf",
        content: "Botanical taxonomy notes",
      });

      itemsMap.set(contentMatch.key, contentMatch);
      itemsMap.set(nonMatch.key, nonMatch);

      // quicksearch-everything query for "Relativity" matches contentMatch through Zotero.Search
      const res = await findStandaloneAttachments({
        libraryID: 1,
        query: "Relativity",
      });
      expect(res.total).to.equal(1);
      expect(res.items[0].key).to.equal("RELAT001");
    });

    it("filters by tag single string parameter", async function () {
      const tagged1 = createMockAttachment({
        id: 25,
        key: "TAGGED01",
        tags: [{ tag: "MachineLearning" }],
      });
      const tagged2 = createMockAttachment({
        id: 26,
        key: "TAGGED02",
        tags: ["DeepLearning"],
      });
      const untagged = createMockAttachment({
        id: 27,
        key: "UNTAGGED",
        tags: [],
      });

      for (const it of [tagged1, tagged2, untagged]) {
        itemsMap.set(it.key, it);
      }

      const resTag = await findStandaloneAttachments({
        libraryID: 1,
        tag: "Learning",
      });
      expect(resTag.total).to.equal(2);
      const keys = resTag.items.map((i: any) => i.key);
      expect(keys).to.include("TAGGED01");
      expect(keys).to.include("TAGGED02");
      expect(keys).to.not.include("UNTAGGED");
    });

    it("never exposes absolute file paths in output items", async function () {
      const valid = createMockAttachment({
        id: 20,
        key: "SECPDF01",
        fileExists: true,
      });
      itemsMap.set("SECPDF01", valid);

      const result = await findStandaloneAttachments({ libraryID: 1 });
      const item = result.items[0];

      expect(item.key).to.equal("SECPDF01");
      expect((item as any).filePath).to.be.undefined;
      expect((item as any).path).to.be.undefined;
      const jsonString = JSON.stringify(result);
      expect(jsonString).to.not.include("C:\\Users\\mock");
    });

    it("filters by collectionKey with 0, 1, and multiple collections", async function () {
      const noColl = createMockAttachment({
        id: 30,
        key: "NOCOLL01",
        collections: [],
      });
      const inColl1 = createMockAttachment({
        id: 31,
        key: "INCOLL01",
        collections: [101],
      });
      const inBoth = createMockAttachment({
        id: 32,
        key: "INBOTH01",
        collections: [101, 102],
      });
      const inColl2 = createMockAttachment({
        id: 33,
        key: "INCOLL02",
        collections: [102],
      });

      for (const it of [noColl, inColl1, inBoth, inColl2]) {
        itemsMap.set(it.key, it);
      }

      const resColl1 = await findStandaloneAttachments({
        libraryID: 1,
        collectionKey: "COLL0001",
      });

      expect(resColl1.total).to.equal(2);
      const keys = resColl1.items.map((it: any) => it.key);
      expect(keys).to.include("INCOLL01");
      expect(keys).to.include("INBOTH01");
      expect(keys).to.not.include("NOCOLL01");
      expect(keys).to.not.include("INCOLL02");
    });

    it("filters by fileStatus parameter (e.g. available, not_local, missing)", async function () {
      const avail = createMockAttachment({
        id: 40,
        key: "FSTATAV1",
        fileExists: true,
      });
      const notLocal = createMockAttachment({
        id: 41,
        key: "FSTATNL1",
        fileExists: false,
        syncState: 1,
      });
      const missing = createMockAttachment({
        id: 42,
        key: "FSTATMS1",
        fileExists: false,
        syncState: 2,
      });

      for (const it of [avail, notLocal, missing]) {
        itemsMap.set(it.key, it);
      }

      // Filter available
      const resAvail = await findStandaloneAttachments({
        libraryID: 1,
        fileStatus: "available",
      });
      expect(resAvail.total).to.equal(1);
      expect(resAvail.items[0].key).to.equal("FSTATAV1");

      // Filter not_local
      const resNotLocal = await findStandaloneAttachments({
        libraryID: 1,
        fileStatus: "not_local",
      });
      expect(resNotLocal.total).to.equal(1);
      expect(resNotLocal.items[0].key).to.equal("FSTATNL1");

      // Filter missing
      const resMissing = await findStandaloneAttachments({
        libraryID: 1,
        fileStatus: "missing",
      });
      expect(resMissing.total).to.equal(1);
      expect(resMissing.items[0].key).to.equal("FSTATMS1");

      // Reject invalid fileStatus
      await expectRejection(
        findStandaloneAttachments({ libraryID: 1, fileStatus: "bogus_status" }),
        PlusError,
        /fileStatus/,
      );
    });

    it("filters by query / q and fulltext using Zotero.Search", async function () {
      const matchItem = createMockAttachment({
        id: 50,
        key: "MATCH001",
        title: "Deep Learning Quantum Systems",
      });
      const otherItem = createMockAttachment({
        id: 51,
        key: "OTHER001",
        title: "Classical Mechanics",
      });
      itemsMap.set(matchItem.key, matchItem);
      itemsMap.set(otherItem.key, otherItem);

      const resQ = await findStandaloneAttachments({
        libraryID: 1,
        q: "Quantum",
      });
      expect(resQ.total).to.equal(1);
      expect(resQ.items[0].key).to.equal("MATCH001");

      const resFull = await findStandaloneAttachments({
        libraryID: 1,
        fulltext: "Deep Learning",
      });
      expect(resFull.total).to.equal(1);
      expect(resFull.items[0].key).to.equal("MATCH001");
    });

    it("supports sorting with direction and key tiebreaker", async function () {
      const item1 = createMockAttachment({
        id: 60,
        key: "KEYBBBBB",
        dateAdded: "2026-09-18 10:00:00",
        title: "Alpha",
      });
      const item2 = createMockAttachment({
        id: 61,
        key: "KEYAAAAA",
        dateAdded: "2026-09-18 10:00:00", // Same dateAdded!
        title: "Beta",
      });
      const item3 = createMockAttachment({
        id: 62,
        key: "KEYCCCCC",
        dateAdded: "2026-09-18 09:00:00",
        title: "Gamma",
      });

      for (const it of [item1, item2, item3]) {
        itemsMap.set(it.key, it);
      }

      // Sort by dateAdded asc: item3 is first. For item1 & item2, dateAdded is equal,
      // so key tiebreaker sorts KEYAAAAA before KEYBBBBB.
      const resAsc = await findStandaloneAttachments({
        libraryID: 1,
        sort: "dateAdded",
        direction: "asc",
      });
      expect(resAsc.items.map((i: any) => i.key)).to.deep.equal([
        "KEYCCCCC",
        "KEYAAAAA",
        "KEYBBBBB",
      ]);

      // Sort by title desc
      const resDesc = await findStandaloneAttachments({
        libraryID: 1,
        sort: "title",
        direction: "desc",
      });
      expect(resDesc.items.map((i: any) => i.key)).to.deep.equal([
        "KEYCCCCC", // Gamma
        "KEYAAAAA", // Beta
        "KEYBBBBB", // Alpha
      ]);
    });

    it("supports offset/limit and cursor pagination with max 100 limit", async function () {
      for (let i = 1; i <= 5; i++) {
        const key = `PAGE000${i}`;
        itemsMap.set(
          key,
          createMockAttachment({
            id: 100 + i,
            key,
            dateAdded: `2026-09-18 10:0${i}:00`,
          }),
        );
      }

      // Page 1: limit 2
      const p1 = await findStandaloneAttachments({
        libraryID: 1,
        limit: 2,
        offset: 0,
      });
      expect(p1.items).to.have.lengthOf(2);
      expect(p1.total).to.equal(5);
      expect(p1.complete).to.be.false;
      expect(p1.nextCursor).to.be.a("string");

      // Page 2: using nextCursor
      const p2 = await findStandaloneAttachments({
        libraryID: 1,
        limit: 2,
        cursor: p1.nextCursor,
      });
      expect(p2.items).to.have.lengthOf(2);
      expect(p2.complete).to.be.false;
      expect(p2.items[0].key).to.equal(itemsMap.get("PAGE0003").key);

      // Page 3: final item
      const p3 = await findStandaloneAttachments({
        libraryID: 1,
        limit: 2,
        cursor: p2.nextCursor,
      });
      expect(p3.items).to.have.lengthOf(1);
      expect(p3.complete).to.be.true;
      expect(p3.nextCursor).to.be.undefined;

      // Limit bounds
      await expectRejection(
        findStandaloneAttachments({ libraryID: 1, limit: 101 }),
        PlusError,
        /limit/,
      );

      await expectRejection(
        findStandaloneAttachments({ libraryID: 1, limit: 0 }),
        PlusError,
        /limit/,
      );
    });
  });
});
