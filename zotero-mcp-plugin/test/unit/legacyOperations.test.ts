import assert from "node:assert/strict";
import {
  LegacyOperationAdapter,
  inspectImportFile,
} from "../../src/modules/legacyOperations.ts";

class ItemFixture {
  key: string;
  libraryID = 1;
  itemTypeID = 2;
  itemType = "journalArticle";
  parentKey: string | null = null;
  deleted = false;
  fields: Record<string, string> = { title: "原始标题" };
  creators: any[] = [];
  tags: string[] = [];
  collectionIDs: number[] = [];
  attachments: number[] = [];
  persisted: any;
  reloadCount = 0;
  constructor(key: string) {
    this.key = key;
  }
  isEditable() {
    return true;
  }
  isRegularItem() {
    return this.itemType === "journalArticle";
  }
  isAttachment() {
    return this.itemType === "attachment";
  }
  isNote() {
    return this.itemType === "note";
  }
  isTopLevelItem() {
    return !this.parentKey;
  }
  getAttachments() {
    return this.attachments;
  }
  getNotes() {
    return [];
  }
  getCollections() {
    return this.collectionIDs;
  }
  getTags() {
    return this.tags.map((tag) => ({ tag }));
  }
  hasTag(tag: string) {
    return this.tags.includes(tag);
  }
  getField(field: string) {
    return this.fields[field] || "";
  }
  setField(field: string, value: string) {
    this.fields[field] = value;
  }
  setCreators(creators: any[]) {
    this.creators = creators;
  }
  toJSON() {
    return {
      key: this.key,
      itemType: this.itemType,
      parentItem: this.parentKey,
      ...this.fields,
      creators: this.creators,
      tags: this.getTags(),
      collections: this.collectionIDs.map(() => "COLLECT1"),
    };
  }
  clone() {
    const result = new ItemFixture(this.key);
    Object.assign(result, this);
    result.fields = { ...this.fields };
    result.creators = structuredClone(this.creators);
    return result;
  }
  persist() {
    this.persisted = structuredClone({
      fields: this.fields,
      creators: this.creators,
      tags: this.tags,
      parentKey: this.parentKey,
      collectionIDs: this.collectionIDs,
      deleted: this.deleted,
    });
  }
  async reload(types: unknown, force: boolean) {
    assert.equal(types, undefined);
    assert.equal(force, true);
    this.reloadCount++;
    if (this.persisted) Object.assign(this, structuredClone(this.persisted));
  }
}

describe("兼容写工具的确认与后置条件", function () {
  let prior: any;
  let items: Map<string, ItemFixture>;
  let membership: number[];
  let collection: any;

  beforeEach(function () {
    prior = (globalThis as any).Zotero;
    items = new Map();
    membership = [];
    collection = {
      id: 1,
      key: "COLLECT1",
      name: "样例集合",
      parentKey: null,
      getChildItems: () => membership,
      hasItem: (item: ItemFixture) => item.getCollections().includes(1),
      getChildCollections: () => [],
      reload: async () => undefined,
    };
    (globalThis as any).Zotero = {
      Libraries: {
        userLibraryID: 1,
        get: (id: number) =>
          id === 1 ? { editable: true, filesEditable: true } : false,
      },
      Items: {
        getByLibraryAndKeyAsync: async (_id: number, key: string) =>
          items.get(key) || false,
      },
      Collections: {
        getByLibraryAndKeyAsync: async (_id: number, key: string) =>
          key === "COLLECT1" ? collection : false,
        get: () => collection,
      },
      ItemFields: {
        getID: (field: string) =>
          ["title", "abstractNote"].includes(field) ? 1 : false,
        isValidForType: () => true,
      },
      CreatorTypes: { getID: () => 1, isValidForItemType: () => true },
      Utilities: {
        extractIdentifiers: (value: string) => [
          { DOI: value.replace(/^https:\/\/doi.org\//i, "").toLowerCase() },
        ],
      },
      Prefs: { get: () => undefined },
      Search: class {
        addCondition() {}
        async search() {
          return [];
        }
      },
    };
  });

  afterEach(function () {
    (globalThis as any).Zotero = prior;
  });

  function item(key: string) {
    const value = new ItemFixture(key);
    value.persist();
    items.set(key, value);
    return value;
  }

  it("metadata 预览列出 before/after，且不改变真实缓存", async function () {
    const target = item("ITEM0001");
    const adapter = new LegacyOperationAdapter("write_metadata", async () => {
      throw new Error("不应执行");
    });
    const plan = await adapter.prepare({
      itemKey: target.key,
      fields: { title: "新标题" },
    });
    assert.equal(target.getField("title"), "原始标题");
    assert.deepEqual(plan.steps[0].preview.changes.fields.title, {
      before: "原始标题",
      after: "新标题",
    });
    await adapter.check(plan.steps[0]);
    target.fields.title = "界面中修改过";
    await assert.rejects(adapter.check(plan.steps[0]), {
      code: "STATE_CHANGED",
    });
  });

  it("原 handler 仅返回 success 但没有落库不能算成功", async function () {
    const target = item("ITEM0001");
    const adapter = new LegacyOperationAdapter("write_metadata", async () => ({
      success: true,
    }));
    const plan = await adapter.prepare({
      itemKey: target.key,
      fields: { title: "未保存的新标题" },
    });
    const result = await adapter.execute(plan.steps[0]);
    assert.equal(result.state, "needs_review");
    assert.equal(result.retrySafe, false);
    assert.equal(target.reloadCount, 1);
  });

  it("成功结果必须与重载后的数据相符", async function () {
    const target = item("ITEM0001");
    const adapter = new LegacyOperationAdapter("write_metadata", async () => {
      target.fields.title = "已保存的新标题";
      target.persist();
      return { success: true };
    });
    const plan = await adapter.prepare({
      itemKey: target.key,
      fields: { title: "已保存的新标题" },
    });
    assert.equal((await adapter.execute(plan.steps[0])).state, "succeeded");
    assert.ok(target.reloadCount > 0);
  });

  it("原 handler 失败后清除未保存的脏缓存并保留待核查", async function () {
    const target = item("ITEM0001");
    const adapter = new LegacyOperationAdapter("write_metadata", async () => {
      target.fields.title = "只改了缓存";
      return { success: false, error: "模拟事务失败" };
    });
    const plan = await adapter.prepare({
      itemKey: target.key,
      fields: { title: "只改了缓存" },
    });
    assert.equal((await adapter.execute(plan.steps[0])).state, "needs_review");
    assert.equal(target.getField("title"), "原始标题");
  });

  it("同组 reparent 作为单个原子步骤，不会因前一个子项改变parent快照而自失效", async function () {
    item("PARENT01");
    for (const key of ["ATTACH01", "ATTACH02"]) {
      const child = item(key);
      child.itemType = "attachment";
    }
    const adapter = new LegacyOperationAdapter("write_item", async () => ({
      success: true,
    }));
    const plan = await adapter.prepare({
      action: "reparent",
      parentKey: "PARENT01",
      attachmentKeys: ["ATTACH01", "ATTACH02", "ATTACH01"],
    });
    assert.equal(plan.steps.length, 1);
    assert.deepEqual(plan.steps[0].input.args.attachmentKeys, [
      "ATTACH01",
      "ATTACH02",
    ]);
    assert.deepEqual(plan.steps[0].targets.map((entry) => entry.key).sort(), [
      "ATTACH01",
      "ATTACH02",
      "PARENT01",
    ]);
  });

  it("identifier 批次向同一集合添加成员不使后续项的快照自失效", async function () {
    const adapter = new LegacyOperationAdapter(
      "add_by_identifier",
      async () => ({ success: true }),
    );
    const plan = await adapter.prepare({
      identifiers: ["10.1000/a", "10.1000/b"],
      collectionKey: "COLLECT1",
    });
    assert.equal(plan.steps.length, 2);
    membership.push(20);
    await adapter.check(plan.steps[1]);
    collection.name = "外部重命名";
    await assert.rejects(adapter.check(plan.steps[1]), {
      code: "STATE_CHANGED",
    });
  });

  it("同批 identifier URL/大小写别名只生成一个步骤", async function () {
    const adapter = new LegacyOperationAdapter(
      "add_by_identifier",
      async () => ({}),
    );
    const plan = await adapter.prepare({
      identifiers: ["10.1000/AbC", "https://doi.org/10.1000/abc"],
    });
    assert.equal(plan.steps.length, 1);
  });

  for (const status of ["exists", "imported", "duplicate_trashed"]) {
    // 使用真实旧 handler 的返回字段，不在 fixture 中自行改名。

    it(`identifier ${status} 按旧 handler 的 itemKey 核验结果`, async function () {
      const target = item("ITEM0001");
      const adapter = new LegacyOperationAdapter(
        "add_by_identifier",
        async () => {
          target.deleted = status === "duplicate_trashed";
          target.persist();
          return {
            success: true,
            data: { status, item: { itemKey: target.key } },
          };
        },
      );
      const plan = await adapter.prepare({
        identifiers: ["10.1000/abc"],
        delayMs: 0,
      });
      assert.equal((await adapter.execute(plan.steps[0])).state, "succeeded");
      assert.ok(target.reloadCount > 0);
    });
  }

  it("identifier 额外返回项也按 itemKey 核验，缺失时保留待核查", async function () {
    const target = item("ITEM0001");
    const extra = item("ITEM0002");
    const adapter = new LegacyOperationAdapter(
      "add_by_identifier",
      async () => ({
        success: true,
        data: {
          status: "imported",
          item: { itemKey: target.key },
          extraItems: [{ itemKey: extra.key }],
        },
      }),
    );
    const plan = await adapter.prepare({
      identifiers: ["10.1000/abc"],
      delayMs: 0,
    });
    assert.equal((await adapter.execute(plan.steps[0])).state, "succeeded");
    items.delete(extra.key);
    assert.equal((await adapter.execute(plan.steps[0])).state, "needs_review");
  });

  it("identifier 已有条目显式 fileExisting 时必须核实集合归属", async function () {
    const target = item("ITEM0001");
    const adapter = new LegacyOperationAdapter(
      "add_by_identifier",
      async () => ({
        success: true,
        data: { status: "exists", item: { itemKey: target.key } },
      }),
    );
    const plan = await adapter.prepare({
      identifiers: ["10.1000/abc"],
      collectionKey: "COLLECT1",
      fileExisting: true,
      delayMs: 0,
    });
    assert.equal((await adapter.execute(plan.steps[0])).state, "needs_review");
    target.collectionIDs = [1];
    target.persist();
    assert.equal((await adapter.execute(plan.steps[0])).state, "succeeded");
  });

  it("identifier 默认不要求把已有条目加入集合", async function () {
    const target = item("ITEM0001");
    const adapter = new LegacyOperationAdapter(
      "add_by_identifier",
      async () => ({
        success: true,
        data: { status: "exists", item: { itemKey: target.key } },
      }),
    );
    const plan = await adapter.prepare({
      identifiers: ["10.1000/abc"],
      collectionKey: "COLLECT1",
      delayMs: 0,
    });
    assert.equal((await adapter.execute(plan.steps[0])).state, "succeeded");
    assert.deepEqual(target.collectionIDs, []);
  });

  it("恢复时不以标题或identifier相同冒认创建完成", async function () {
    item("ITEM0001");
    const adapter = new LegacyOperationAdapter(
      "add_by_identifier",
      async () => ({}),
    );
    const plan = await adapter.prepare({ identifiers: ["10.1000/abc"] });
    assert.equal(
      (await adapter.reconcile(plan.steps[0])).state,
      "needs_review",
    );
  });

  it("没有本地导入目录授权时拒绝读取文件，UNC路径也被拒绝", async function () {
    await assert.rejects(inspectImportFile("C:\\fixture\\paper.pdf"), {
      code: "IMPORT_ROOTS_REQUIRED",
    });
    await assert.rejects(inspectImportFile("\\\\host\\share\\paper.pdf"), {
      code: "IMPORT_PATH_DENIED",
    });
  });

  it("系统字段和无效标签在预览阶段即被拒绝", async function () {
    const target = item("ITEM0001");
    const metadata = new LegacyOperationAdapter(
      "write_metadata",
      async () => ({}),
    );
    await assert.rejects(
      metadata.prepare({
        itemKey: target.key,
        fields: { dateModified: "2030-01-01" },
      }),
      { code: "INVALID_FIELD" },
    );
    const tags = new LegacyOperationAdapter("write_tag", async () => ({}));
    await assert.rejects(
      tags.prepare({ itemKey: target.key, action: "add", tags: [" "] }),
      { code: "INVALID_TAG" },
    );
  });
});
