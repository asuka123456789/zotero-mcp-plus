import { expect } from "chai";
import { RecognitionService } from "../../src/modules/recognitionService.ts";
import {
  PlusError,
  type ExecutionContext,
  type PlanStep,
} from "../../src/modules/plusTypes.ts";

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

describe("RecognitionService (OperationAdapter)", function () {
  let service: RecognitionService;
  let fakeZotero: any;
  let rowsInQueue: any[];
  let listeners: Record<string, Function[]>;
  let recognizeItemsCalls: any[][];
  let privateRecognizeCalled = false;
  let queueCancelCalled = false;

  function createMockItem(opts: {
    id: number;
    key: string;
    libraryID?: number;
    parentItemID?: number | null;
    parentItem?: any;
    contentType?: string;
    filename?: string;
    deleted?: boolean;
    editable?: boolean;
    fileExists?: boolean;
    collections?: any[];
    annotations?: any[];
    version?: number;
    dateModified?: string;
    linkMode?: number;
    fileSize?: number;
    fileMtime?: number;
  }) {
    const item = {
      id: opts.id,
      key: opts.key,
      libraryID: opts.libraryID ?? 1,
      parentItemID: opts.parentItemID ?? null,
      parentItem: opts.parentItem ?? null,
      attachmentContentType: opts.contentType ?? "application/pdf",
      attachmentFilename: opts.filename ?? `${opts.key}.pdf`,
      deleted: opts.deleted ?? false,
      version: opts.version ?? 1,
      dateModified: opts.dateModified ?? "2026-09-18 12:00:00",
      attachmentLinkMode: opts.linkMode ?? 0,
      _collections: opts.collections ?? [],
      _annotations: opts.annotations ?? [],
      fileSize: opts.fileSize ?? 1024,
      fileMtime: opts.fileMtime ?? 1700000000,
      isPDFAttachment() {
        return (
          (this.attachmentContentType || "").toLowerCase() === "application/pdf"
        );
      },
      isTopLevelItem() {
        return !this.parentItemID && !this.parentItem;
      },
      isEditable() {
        return opts.editable ?? true;
      },
      async fileExists() {
        return opts.fileExists ?? true;
      },
      getCollections() {
        return this._collections;
      },
      getAnnotations(includeTrashed = false, asIDs = false) {
        let annots = this._annotations;
        if (!includeTrashed) {
          annots = annots.filter((a: any) => !a.deleted);
        }
        if (asIDs) {
          return annots.map((a: any) => a.id);
        }
        return annots;
      },
      getField(name: string) {
        if (name === "title") return this.attachmentFilename;
        return undefined;
      },
      setParent(parent: any) {
        this.parentItem = parent;
        this.parentItemID = parent.id;
      },
      async reload(_fields?: any, _force?: boolean) {
        // mock reload
        return true;
      },
    };
    return item;
  }

  function createExecutionContext(aborted = false): {
    context: ExecutionContext;
    controller: AbortController;
    updates: Array<{ phase: string; details?: any }>;
  } {
    const controller = new AbortController();
    if (aborted) controller.abort();
    const updates: Array<{ phase: string; details?: any }> = [];

    const context: ExecutionContext = {
      taskID: "task-rec-test",
      attemptID: "att-rec-test",
      signal: controller.signal,
      async update(phase: "submitted" | "running", details?: any) {
        updates.push({ phase, details });
      },
    };
    return { context, controller, updates };
  }

  beforeEach(function () {
    service = new RecognitionService();
    rowsInQueue = [];
    listeners = { rowupdated: [], cancel: [] };
    recognizeItemsCalls = [];
    privateRecognizeCalled = false;
    queueCancelCalled = false;

    const itemsMap = new Map<any, any>();

    const progressQueue = {
      addListener(name: string, cb: Function) {
        if (!listeners[name]) listeners[name] = [];
        listeners[name].push(cb);
      },
      removeListener(name: string, cb: Function) {
        if (!listeners[name]) return;
        listeners[name] = listeners[name].filter((x) => x !== cb);
      },
      getRows() {
        return rowsInQueue;
      },
      cancel() {
        queueCancelCalled = true;
      },
      emitRowUpdated(event: { id: number; status: number; message: string }) {
        const cbs = [...(listeners.rowupdated || [])];
        for (const cb of cbs) {
          cb(event);
        }
      },
    };

    const librariesMap = new Map<number, any>([
      [1, { id: 1, editable: true, libraryType: "user" }],
      [2, { id: 2, editable: false, libraryType: "group" }],
    ]);

    const collectionsMap = new Map<string, any>([
      ["COLL0001", { id: 101, key: "COLL0001", libraryID: 1 }],
      ["COLL0002", { id: 102, key: "COLL0002", libraryID: 1 }],
    ]);

    const prefsMap = new Map<string, any>([["autoRenameFiles", true]]);

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
        get(keyOrId: any) {
          if (typeof keyOrId === "number") {
            for (const item of itemsMap.values()) {
              if (item.id === keyOrId) return item;
            }
            return null;
          }
          return itemsMap.get(keyOrId) || null;
        },
        async getAsync(keyOrId?: any) {
          if (keyOrId === undefined) return Array.from(itemsMap.values());
          if (Array.isArray(keyOrId)) {
            return keyOrId.map((k) => this.get(k)).filter(Boolean);
          }
          return this.get(keyOrId);
        },
        async getByLibraryAndKeyAsync(libraryID: number, key: string) {
          const item = itemsMap.get(key);
          return item && item.libraryID === libraryID ? item : null;
        },
      },
      Prefs: {
        get(pref: string) {
          return prefsMap.get(pref);
        },
        set(pref: string, val: any) {
          prefsMap.set(pref, val);
        },
      },
      ProgressQueues: {
        get(name: string) {
          if (name === "recognize") return progressQueue;
          return null;
        },
      },
      RecognizeDocument: {
        canRecognize(item: any) {
          return (
            item.attachmentContentType === "application/pdf" &&
            item.isTopLevelItem()
          );
        },
        async recognizeItems(items: any[]) {
          recognizeItemsCalls.push(items);
        },
        _recognize() {
          privateRecognizeCalled = true;
          throw new Error("Private _recognize must never be called directly");
        },
      },
      Attachments: {
        LINK_MODE_IMPORTED_FILE: 0,
        LINK_MODE_IMPORTED_URL: 1,
        LINK_MODE_LINKED_FILE: 2,
        LINK_MODE_LINKED_URL: 3,
      },
    };

    (globalThis as any).Zotero = fakeZotero;
  });

  afterEach(function () {
    delete (globalThis as any).Zotero;
  });

  describe("Adapter metadata", function () {
    it("exports tool 'recognize_pdfs' and lane 'recognition'", function () {
      expect(service.tool).to.equal("recognize_pdfs");
      expect(service.lane).to.equal("recognition");
    });
  });

  describe("prepare", function () {
    it("validates libraryID and requires writable library", async function () {
      await expectRejection(
        service.prepare({ libraryID: 999, attachmentKeys: ["KEY00001"] }),
        PlusError,
        /文库不存在/,
      );

      await expectRejection(
        service.prepare({ libraryID: 2, attachmentKeys: ["KEY00001"] }),
        PlusError,
        /不可编辑/,
      );
    });

    it("rejects empty keys or keys over 500 limit", async function () {
      await expectRejection(
        service.prepare({ libraryID: 1, attachmentKeys: [] }),
        PlusError,
        /1–500/,
      );

      const tooMany = Array.from(
        { length: 501 },
        (_, i) => `K${String(i).padStart(7, "0")}`,
      );
      await expectRejection(
        service.prepare({ libraryID: 1, attachmentKeys: tooMany }),
        PlusError,
        /1–500/,
      );
    });

    it("creates PlanSteps with stable step.id, targets, fingerprint, preview, and annotation snapshot", async function () {
      const item = createMockItem({
        id: 10,
        key: "PDFKEY01",
        collections: [101, 102],
        annotations: [
          { id: 1001, key: "ANNOT001", deleted: false, parentItemID: 10 },
          { id: 1002, key: "ANNOT002", deleted: true, parentItemID: 10 },
        ],
      });
      fakeZotero.Items._itemsMap.set("PDFKEY01", item);

      const plan = await service.prepare({
        libraryID: 1,
        attachmentKeys: ["PDFKEY01"],
      });

      expect(plan.schemaVersion).to.equal(1);
      expect(plan.tool).to.equal("recognize_pdfs");
      expect(plan.steps).to.have.lengthOf(1);

      const step = plan.steps[0];
      // step.id must be stable key, NOT title
      expect(step.id).to.equal("PDFKEY01");
      expect(step.targets).to.deep.equal([
        { libraryID: 1, key: "PDFKEY01", kind: "item" },
      ]);
      expect(step.fingerprint).to.be.a("string").with.lengthOf(64);
      expect(step.preview.attachmentKey).to.equal("PDFKEY01");
      expect(step.preview.collectionKeys).to.deep.equal([
        "COLL0001",
        "COLL0002",
      ]);
      expect(step.preview.annotationKeys).to.deep.equal([
        "ANNOT001",
        "ANNOT002",
      ]);
      expect(step.preview.autoRenameFiles).to.be.true;
      expect(step.preview.fileSize).to.equal(1024);
      expect(step.preview.fileMtime).to.equal(1700000000);
      expect(step.preview.networkNotice).to.include("联网查询元数据");
      expect(step.blockers).to.be.undefined;
    });

    it("detects blockers for non-existent, deleted, and non-editable items", async function () {
      const deletedItem = createMockItem({
        id: 11,
        key: "DEL00001",
        deleted: true,
      });
      const nonEditableItem = createMockItem({
        id: 12,
        key: "NON00001",
        editable: false,
      });
      fakeZotero.Items._itemsMap.set("DEL00001", deletedItem);
      fakeZotero.Items._itemsMap.set("NON00001", nonEditableItem);

      const plan = await service.prepare({
        libraryID: 1,
        attachmentKeys: ["NOTEXIST", "DEL00001", "NON00001"],
      });

      expect(plan.steps[0].blockers![0].code).to.equal("ITEM_NOT_FOUND");
      expect(plan.steps[1].blockers![0].code).to.equal("ITEM_DELETED");
      expect(plan.steps[2].blockers![0].code).to.equal("NOT_EDITABLE");
    });

    it("blocks child attachments and non-PDF attachments", async function () {
      const childItem = createMockItem({
        id: 20,
        key: "CHILD001",
        parentItemID: 999,
      });
      const epubItem = createMockItem({
        id: 21,
        key: "EPUB0001",
        contentType: "application/epub+zip",
        filename: "book.epub",
      });
      fakeZotero.Items._itemsMap.set("CHILD001", childItem);
      fakeZotero.Items._itemsMap.set("EPUB0001", epubItem);

      const plan = await service.prepare({
        libraryID: 1,
        attachmentKeys: ["CHILD001", "EPUB0001"],
      });

      expect(plan.steps[0].blockers!.some((b) => b.code === "NOT_STANDALONE"))
        .to.be.true;
      expect(plan.steps[1].blockers!.some((b) => b.code === "NOT_PDF")).to.be
        .true;
    });

    it("blocks items with missing or not-local local file", async function () {
      const missingItem = createMockItem({
        id: 30,
        key: "MISS0001",
        fileExists: false,
      });
      fakeZotero.Items._itemsMap.set("MISS0001", missingItem);

      const plan = await service.prepare({
        libraryID: 1,
        attachmentKeys: ["MISS0001"],
      });

      expect(plan.steps[0].blockers!.some((b) => b.code === "FILE_UNAVAILABLE"))
        .to.be.true;
    });

    it("blocks items already queued or processing in native Zotero queue", async function () {
      const queuedItem = createMockItem({ id: 40, key: "QUEUED01" });
      fakeZotero.Items._itemsMap.set("QUEUED01", queuedItem);
      // Native queue has row with status 1 (ROW_QUEUED)
      rowsInQueue.push({ id: 40, status: 1, message: "" });

      const plan = await service.prepare({
        libraryID: 1,
        attachmentKeys: ["QUEUED01"],
      });

      expect(plan.steps[0].blockers!.some((b) => b.code === "ALREADY_QUEUED"))
        .to.be.true;
    });

    it("blocks items with unresolvable collection keys instead of fake string ID", async function () {
      const badCollItem = createMockItem({
        id: 45,
        key: "BADCOLL1",
        collections: [9999], // ID 9999 does not exist in Collections
      });
      fakeZotero.Items._itemsMap.set("BADCOLL1", badCollItem);

      const plan = await service.prepare({
        libraryID: 1,
        attachmentKeys: ["BADCOLL1"],
      });

      expect(
        plan.steps[0].blockers!.some(
          (b) => b.code === "COLLECTION_KEY_UNRESOLVED",
        ),
      ).to.be.true;
    });
  });

  describe("check", function () {
    let step: PlanStep;

    beforeEach(async function () {
      const item = createMockItem({
        id: 50,
        key: "CHECKPDF",
        collections: [101],
        annotations: [
          { id: 501, key: "ANN00050", deleted: false, parentItemID: 50 },
        ],
      });
      fakeZotero.Items._itemsMap.set("CHECKPDF", item);

      const plan = await service.prepare({
        libraryID: 1,
        attachmentKeys: ["CHECKPDF"],
      });
      step = plan.steps[0];
    });

    it("throws if step contains blockers", async function () {
      step.blockers = [{ code: "BLOCKED_TEST", message: "阻断测试" }];
      await expectRejection(service.check(step), PlusError, /BLOCKED_TEST/);
    });

    it("passes when state has not changed", async function () {
      await service.check(step);
    });

    it("detects modification in item version, collections, or rename preference", async function () {
      const item = fakeZotero.Items.get("CHECKPDF");

      // Version modified
      item.version = 2;
      await expectRejection(service.check(step), PlusError, /STATE_CHANGED/);

      // Revert version, change collections
      item.version = 1;
      item._collections = [102];
      await expectRejection(service.check(step), PlusError, /STATE_CHANGED/);

      // Revert collections, change autoRenameFiles preference
      item._collections = [101];
      fakeZotero.Prefs.set("autoRenameFiles", false);
      await expectRejection(service.check(step), PlusError, /STATE_CHANGED/);
    });

    it("detects modification in file size or mtime on disk (tampering/replacement)", async function () {
      const item = fakeZotero.Items.get("CHECKPDF");

      // File size altered
      item.fileSize = 2048;
      await expectRejection(service.check(step), PlusError, /STATE_CHANGED/);

      // Revert size, alter mtime
      item.fileSize = 1024;
      item.fileMtime = 1700005000;
      await expectRejection(service.check(step), PlusError, /STATE_CHANGED/);
    });

    it("detects modification in attachment annotations (annotation deleted, added, or changed)", async function () {
      const item = fakeZotero.Items.get("CHECKPDF");

      // Annotation deleted flag toggled
      item._annotations = [
        { id: 501, key: "ANN00050", deleted: true, parentItemID: 50 },
      ];
      await expectRejection(service.check(step), PlusError, /STATE_CHANGED/);

      // Revert, then remove annotation
      item._annotations = [];
      await expectRejection(service.check(step), PlusError, /STATE_CHANGED/);
    });

    it("blocks when item was added to native queue between prepare and check", async function () {
      rowsInQueue.push({ id: 50, status: 2, message: "processing" });
      await expectRejection(service.check(step), PlusError, /ALREADY_QUEUED/);
    });

    it("blocks when item file disappeared before check", async function () {
      const item = fakeZotero.Items.get("CHECKPDF");
      item.fileExists = async () => false;
      await expectRejection(service.check(step), PlusError, /FILE_UNAVAILABLE/);
    });
  });

  describe("execute", function () {
    let step: PlanStep;
    let item: any;

    beforeEach(async function () {
      item = createMockItem({
        id: 100,
        key: "EXECPDF1",
        collections: [101],
        annotations: [
          { id: 1001, key: "ANNEXEC1", deleted: false, parentItemID: 100 },
        ],
      });
      fakeZotero.Items._itemsMap.set("EXECPDF1", item);

      const plan = await service.prepare({
        libraryID: 1,
        attachmentKeys: ["EXECPDF1"],
      });
      step = plan.steps[0];
    });

    it("returns early without calling native recognizeItems if signal is aborted before call", async function () {
      const { context } = createExecutionContext(true); // already aborted

      const outcome = await service.execute(step, context);
      expect(outcome.state).to.equal("needs_review");
      expect(outcome.error?.code).to.equal("INTERRUPTED");
      expect(recognizeItemsCalls).to.have.lengthOf(0);
      expect(recognizeItemsCalls).to.be.empty;
    });

    it("registers listener before recognizeItems and submits exactly one item", async function () {
      const { context, updates } = createExecutionContext();
      const queue = fakeZotero.ProgressQueues.get("recognize");

      let listenerAddedBeforeSubmit = false;
      fakeZotero.RecognizeDocument.recognizeItems = async (items: any[]) => {
        recognizeItemsCalls.push(items);
        listenerAddedBeforeSubmit = (listeners.rowupdated || []).length > 0;
        // Simulate native progress queue rowupdated success
        queue.emitRowUpdated({
          id: items[0].id,
          status: 2,
          message: "processing",
        });
        // Parent created by native recognize, with migrated collections
        const parent = {
          id: 200,
          key: "PARENT01",
          libraryID: 1,
          deleted: false,
          title: "Recognized Title",
          getField: () => "Recognized Title",
          isRegularItem: () => true,
          getCollections: () => ["COLL0001"],
          async reload() {
            return true;
          },
        };
        fakeZotero.Items._itemsMap.set("PARENT01", parent);
        items[0].setParent(parent);
        queue.emitRowUpdated({
          id: items[0].id,
          status: 4,
          message: "Recognized Title",
        });
      };

      const outcome = await service.execute(step, context);

      expect(listenerAddedBeforeSubmit).to.be.true;
      expect(recognizeItemsCalls).to.have.lengthOf(1);
      expect(recognizeItemsCalls[0]).to.have.lengthOf(1);
      expect(recognizeItemsCalls[0][0].key).to.equal("EXECPDF1");
      expect(privateRecognizeCalled).to.be.false;
      expect(queueCancelCalled).to.be.false;

      // Check updates
      expect(updates[0].phase).to.equal("submitted");
      expect(updates[1].phase).to.equal("running");

      // Check outcome
      expect(outcome.state).to.equal("succeeded");
      expect(outcome.result?.attachmentKey).to.equal("EXECPDF1");
      expect(outcome.result?.parentKey).to.equal("PARENT01");
      expect(outcome.result?.parentTitle).to.equal("Recognized Title");
      expect(outcome.result?.parentCollectionKeys).to.deep.equal(["COLL0001"]);
      expect(outcome.retrySafe).to.be.false;

      // Listener precisely removed in finally
      expect(listeners.rowupdated).to.be.empty;
    });

    it("verifies post-conditions on ROW_SUCCEEDED: fails if original collections not migrated to parent", async function () {
      const { context } = createExecutionContext();
      const queue = fakeZotero.ProgressQueues.get("recognize");

      fakeZotero.RecognizeDocument.recognizeItems = async (items: any[]) => {
        // Parent created but did NOT migrate collection COLL0001
        const parent = {
          id: 200,
          key: "PARENT01",
          libraryID: 1,
          deleted: false,
          title: "Recognized Title",
          getField: () => "Recognized Title",
          isRegularItem: () => true,
          getCollections: () => [], // Missing COLL0001!
          async reload() {
            return true;
          },
        };
        fakeZotero.Items._itemsMap.set("PARENT01", parent);
        items[0].setParent(parent);
        queue.emitRowUpdated({
          id: items[0].id,
          status: 4,
          message: "Recognized Title",
        });
      };

      const outcome = await service.execute(step, context);
      expect(outcome.state).to.equal("needs_review");
      expect(outcome.error?.code).to.equal("POST_VALIDATION_FAILED");
      expect(outcome.error?.message).to.include("COLL0001");
      expect(outcome.retrySafe).to.be.false;
    });

    it("verifies post-conditions on ROW_SUCCEEDED: fails if an original annotation is lost", async function () {
      const { context } = createExecutionContext();
      const queue = fakeZotero.ProgressQueues.get("recognize");

      fakeZotero.RecognizeDocument.recognizeItems = async (items: any[]) => {
        const parent = {
          id: 200,
          key: "PARENT01",
          libraryID: 1,
          deleted: false,
          title: "Recognized Title",
          getField: () => "Recognized Title",
          isRegularItem: () => true,
          getCollections: () => ["COLL0001"],
          async reload() {
            return true;
          },
        };
        fakeZotero.Items._itemsMap.set("PARENT01", parent);
        items[0].setParent(parent);
        // Annotation was wiped out or lost during recognize
        items[0]._annotations = [];
        queue.emitRowUpdated({
          id: items[0].id,
          status: 4,
          message: "Recognized Title",
        });
      };

      const outcome = await service.execute(step, context);
      expect(outcome.state).to.equal("needs_review");
      expect(outcome.error?.code).to.equal("POST_VALIDATION_FAILED");
      expect(outcome.error?.message).to.include("ANNEXEC1");
      expect(outcome.retrySafe).to.be.false;
    });

    it("verifies post-conditions on ROW_SUCCEEDED: fails if an annotation deleted status changed", async function () {
      const { context } = createExecutionContext();
      const queue = fakeZotero.ProgressQueues.get("recognize");

      fakeZotero.RecognizeDocument.recognizeItems = async (items: any[]) => {
        const parent = {
          id: 200,
          key: "PARENT01",
          libraryID: 1,
          deleted: false,
          title: "Recognized Title",
          getField: () => "Recognized Title",
          isRegularItem: () => true,
          getCollections: () => ["COLL0001"],
          async reload() {
            return true;
          },
        };
        fakeZotero.Items._itemsMap.set("PARENT01", parent);
        items[0].setParent(parent);
        // Annotation was moved to trash (deleted = true)
        items[0]._annotations = [
          { id: 1001, key: "ANNEXEC1", deleted: true, parentItemID: 100 },
        ];
        queue.emitRowUpdated({
          id: items[0].id,
          status: 4,
          message: "Recognized Title",
        });
      };

      const outcome = await service.execute(step, context);
      expect(outcome.state).to.equal("needs_review");
      expect(outcome.error?.code).to.equal("POST_VALIDATION_FAILED");
      expect(outcome.error?.message).to.include("删除状态");
      expect(outcome.retrySafe).to.be.false;
    });

    it("verifies post-conditions on ROW_SUCCEEDED: fails if an annotation parent was unhooked/changed", async function () {
      const { context } = createExecutionContext();
      const queue = fakeZotero.ProgressQueues.get("recognize");

      fakeZotero.RecognizeDocument.recognizeItems = async (items: any[]) => {
        const parent = {
          id: 200,
          key: "PARENT01",
          libraryID: 1,
          deleted: false,
          title: "Recognized Title",
          getField: () => "Recognized Title",
          isRegularItem: () => true,
          getCollections: () => ["COLL0001"],
          async reload() {
            return true;
          },
        };
        fakeZotero.Items._itemsMap.set("PARENT01", parent);
        items[0].setParent(parent);
        // Annotation parent was changed to something else
        items[0]._annotations = [
          { id: 1001, key: "ANNEXEC1", deleted: false, parentItemID: 9999 },
        ];
        queue.emitRowUpdated({
          id: items[0].id,
          status: 4,
          message: "Recognized Title",
        });
      };

      const outcome = await service.execute(step, context);
      expect(outcome.state).to.equal("needs_review");
      expect(outcome.error?.code).to.equal("POST_VALIDATION_FAILED");
      expect(outcome.error?.message).to.include("父条目关联");
      expect(outcome.retrySafe).to.be.false;
    });

    it("verifies post-conditions on ROW_SUCCEEDED: fails if parent is deleted", async function () {
      const { context } = createExecutionContext();
      const queue = fakeZotero.ProgressQueues.get("recognize");

      fakeZotero.RecognizeDocument.recognizeItems = async (items: any[]) => {
        const parent = {
          id: 200,
          key: "PARENT01",
          libraryID: 1,
          deleted: true, // In trash!
          title: "Deleted Parent",
          getField: () => "Deleted Parent",
          isRegularItem: () => true,
          getCollections: () => ["COLL0001"],
          async reload() {
            return true;
          },
        };
        fakeZotero.Items._itemsMap.set("PARENT01", parent);
        items[0].setParent(parent);
        queue.emitRowUpdated({
          id: items[0].id,
          status: 4,
          message: "Deleted",
        });
      };

      const outcome = await service.execute(step, context);
      expect(outcome.state).to.equal("needs_review");
      expect(outcome.error?.code).to.equal("POST_VALIDATION_FAILED");
      expect(outcome.error?.message).to.include("回收站");
      expect(outcome.retrySafe).to.be.false;
    });

    it("ignores rowupdated events for other items", async function () {
      const { context } = createExecutionContext();
      const queue = fakeZotero.ProgressQueues.get("recognize");

      fakeZotero.RecognizeDocument.recognizeItems = async (items: any[]) => {
        // Emit events for unrelated item ID 999
        queue.emitRowUpdated({ id: 999, status: 4, message: "other item" });

        // Now emit success for our item
        const parent = {
          id: 201,
          key: "PARENT02",
          libraryID: 1,
          deleted: false,
          title: "My Paper",
          getField: () => "My Paper",
          isRegularItem: () => true,
          getCollections: () => ["COLL0001"],
          async reload() {
            return true;
          },
        };
        fakeZotero.Items._itemsMap.set("PARENT02", parent);
        items[0].setParent(parent);
        queue.emitRowUpdated({
          id: items[0].id,
          status: 4,
          message: "My Paper",
        });
      };

      const outcome = await service.execute(step, context);
      expect(outcome.state).to.equal("succeeded");
      expect(outcome.result?.parentKey).to.equal("PARENT02");
    });

    it("handles ROW_FAILED: returns needs_review and retrySafe:false because orphan parent creation cannot be ruled out", async function () {
      const { context } = createExecutionContext();
      const queue = fakeZotero.ProgressQueues.get("recognize");

      fakeZotero.RecognizeDocument.recognizeItems = async (items: any[]) => {
        // Native reports failed row
        queue.emitRowUpdated({
          id: items[0].id,
          status: 3,
          message: "No metadata found",
        });
      };

      const outcome = await service.execute(step, context);
      expect(outcome.state).to.equal("needs_review");
      expect(outcome.error?.code).to.equal("RECOGNITION_FAILED");
      expect(outcome.retrySafe).to.be.false;
    });

    it("handles native Promise resolve without terminal event (e.g. UI cancel cleared queue): settles with needs_review", async function () {
      const { context } = createExecutionContext();

      fakeZotero.RecognizeDocument.recognizeItems = async (_items: any[]) => {
        // Native Promise resolves immediately without emitting terminal rowupdated event (e.g. queue.cancel in UI)
        return Promise.resolve();
      };

      const outcome = await service.execute(step, context);
      expect(outcome.state).to.equal("needs_review");
      expect(outcome.error?.code).to.equal("POSSIBLE_ORPHAN_PARENT");
      expect(outcome.retrySafe).to.be.false;
    });

    it("handles native Promise early resolve while queue still has item active: does not settle early", async function () {
      const { context } = createExecutionContext();
      const queue = fakeZotero.ProgressQueues.get("recognize");

      fakeZotero.RecognizeDocument.recognizeItems = async (items: any[]) => {
        // Queue active status
        rowsInQueue.push({ id: items[0].id, status: 2, message: "processing" });
        // Return resolved promise while queue continues processing in background
        setTimeout(() => {
          // Finish background processing and emit event
          const parent = {
            id: 200,
            key: "PARENT01",
            libraryID: 1,
            deleted: false,
            title: "Later Paper",
            getField: () => "Later Paper",
            isRegularItem: () => true,
            getCollections: () => ["COLL0001"],
            async reload() {
              return true;
            },
          };
          fakeZotero.Items._itemsMap.set("PARENT01", parent);
          items[0].setParent(parent);
          // clear active row
          rowsInQueue = [];
          queue.emitRowUpdated({
            id: items[0].id,
            status: 4,
            message: "Later Paper",
          });
        }, 15);
        return Promise.resolve();
      };

      const outcome = await service.execute(step, context);
      expect(outcome.state).to.equal("succeeded");
      expect(outcome.result?.parentKey).to.equal("PARENT01");
    });

    it("handles native Promise resolve without event when item was already parented: read-only reconcile returns externally_satisfied", async function () {
      const { context } = createExecutionContext();

      fakeZotero.RecognizeDocument.recognizeItems = async (items: any[]) => {
        // External process/UI attached parent but did not emit progressQueue row event
        const parent = {
          id: 250,
          key: "EXTPAR99",
          libraryID: 1,
          title: "External Parent",
          deleted: false,
          getField: () => "External Parent",
          isRegularItem: () => true,
          getCollections: () => ["COLL0001"],
          async reload() {
            return true;
          },
        };
        fakeZotero.Items._itemsMap.set("EXTPAR99", parent);
        items[0].setParent(parent);
        return Promise.resolve();
      };

      const outcome = await service.execute(step, context);
      expect(outcome.state).to.equal("externally_satisfied");
      expect(outcome.result?.parentKey).to.equal("EXTPAR99");
      expect(outcome.retrySafe).to.be.false;
    });

    it("handles abort signal: removes listener and returns needs_review without claiming native stopped", async function () {
      const { context, controller } = createExecutionContext();

      fakeZotero.RecognizeDocument.recognizeItems = (_items: any[]) => {
        // Return a pending promise representing in-flight recognition
        setTimeout(() => controller.abort(), 10);
        return new Promise(() => {});
      };

      const outcome = await service.execute(step, context);
      expect(outcome.state).to.equal("needs_review");
      expect(outcome.error?.code).to.equal("INTERRUPTED");
      expect(outcome.retrySafe).to.be.false;
      expect(queueCancelCalled).to.be.false;
      expect(listeners.rowupdated).to.be.empty;
    });
  });

  describe("reconcile", function () {
    let step: PlanStep;

    beforeEach(async function () {
      const item = createMockItem({
        id: 300,
        key: "REC00001",
        collections: [101],
        annotations: [
          { id: 3001, key: "ANNREC01", deleted: false, parentItemID: 300 },
        ],
      });
      fakeZotero.Items._itemsMap.set("REC00001", item);

      const plan = await service.prepare({
        libraryID: 1,
        attachmentKeys: ["REC00001"],
      });
      step = plan.steps[0];
    });

    it("never calls recognizeItems or modifies the library during reconcile", async function () {
      await service.reconcile(step);
      expect(recognizeItemsCalls).to.be.empty;
      expect(privateRecognizeCalled).to.be.false;
    });

    it("returns externally_satisfied when item already has parent fulfilled and native queue is clear", async function () {
      const item = fakeZotero.Items.get("REC00001");
      const parent = {
        id: 400,
        key: "EXTPARENT",
        libraryID: 1,
        title: "External Title",
        deleted: false,
        getField: () => "External Title",
        isRegularItem: () => true,
        getCollections: () => [101],
        async reload() {
          return true;
        },
      };
      fakeZotero.Items._itemsMap.set("EXTPARENT", parent);
      item.setParent(parent);

      const outcome = await service.reconcile(step);
      expect(outcome.state).to.equal("externally_satisfied");
      expect(outcome.result?.parentKey).to.equal("EXTPARENT");
      expect(outcome.retrySafe).to.be.false;
    });

    it("returns needs_review (POST_VALIDATION_FAILED) during reconcile if original annotation was lost", async function () {
      const item = fakeZotero.Items.get("REC00001");
      const parent = {
        id: 400,
        key: "EXTPARENT",
        libraryID: 1,
        title: "External Title",
        deleted: false,
        getField: () => "External Title",
        isRegularItem: () => true,
        getCollections: () => [101],
        async reload() {
          return true;
        },
      };
      fakeZotero.Items._itemsMap.set("EXTPARENT", parent);
      item.setParent(parent);
      // Annotations vanished
      item._annotations = [];

      const outcome = await service.reconcile(step);
      expect(outcome.state).to.equal("needs_review");
      expect(outcome.error?.code).to.equal("POST_VALIDATION_FAILED");
      expect(outcome.error?.message).to.include("ANNREC01");
      expect(outcome.retrySafe).to.be.false;
    });

    it("returns needs_review (NATIVE_STILL_RUNNING) even if parent exists if native queue is still processing", async function () {
      const item = fakeZotero.Items.get("REC00001");
      const parent = {
        id: 400,
        key: "EXTPARENT",
        libraryID: 1,
        title: "External Title",
        deleted: false,
        getField: () => "External Title",
        isRegularItem: () => true,
        getCollections: () => [101],
        async reload() {
          return true;
        },
      };
      fakeZotero.Items._itemsMap.set("EXTPARENT", parent);
      item.setParent(parent);

      // Native queue still has row status 2 (processing) or status 1 (queued)
      rowsInQueue.push({ id: 300, status: 2, message: "renaming" });

      const outcome = await service.reconcile(step);
      expect(outcome.state).to.equal("needs_review");
      expect(outcome.error?.code).to.equal("NATIVE_STILL_RUNNING");
      expect(outcome.retrySafe).to.be.false;
    });

    it("returns needs_review (POSSIBLE_ORPHAN_PARENT) when item is still standalone", async function () {
      // Item is still standalone after previous submission
      const outcome = await service.reconcile(step);
      expect(outcome.state).to.equal("needs_review");
      expect(outcome.error?.code).to.equal("POSSIBLE_ORPHAN_PARENT");
      expect(outcome.retrySafe).to.be.false;
    });

    it("returns needs_review and retrySafe:false when item is missing or deleted during reconcile", async function () {
      // Reconcile cannot assume absence of side effects when item disappeared
      fakeZotero.Items._itemsMap.delete("REC00001");
      const outcome1 = await service.reconcile(step);
      expect(outcome1.state).to.equal("needs_review");
      expect(outcome1.error?.code).to.equal("ITEM_NOT_FOUND");
      expect(outcome1.retrySafe).to.be.false;

      const item = createMockItem({ id: 300, key: "REC00001", deleted: true });
      fakeZotero.Items._itemsMap.set("REC00001", item);
      const outcome2 = await service.reconcile(step);
      expect(outcome2.state).to.equal("needs_review");
      expect(outcome2.error?.code).to.equal("ITEM_DELETED");
      expect(outcome2.retrySafe).to.be.false;
    });
  });
});
