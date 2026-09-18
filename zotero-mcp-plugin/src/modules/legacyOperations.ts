import {
  PLUS_PREF_PREFIX,
  PlusError,
  canonicalJSON,
  fingerprint,
  requireKeys,
  requireLibraryID,
  requireWritable,
  type JsonObject,
  type OperationAdapter,
  type OperationPlan,
  type PlanStep,
  type StepOutcome,
  type TargetRef,
} from "./plusTypes.ts";

export type LegacyExecutor = (name: string, args: JsonObject) => Promise<any>;

export async function lookupIdentifier(
  libraryID: number,
  identifier: JsonObject,
): Promise<any | null> {
  const conditions: Array<[string, string, string]> = [];
  if (identifier.DOI) conditions.push(["DOI", "is", identifier.DOI]);
  if (identifier.ISBN) conditions.push(["ISBN", "is", identifier.ISBN]);
  if (identifier.arXiv)
    conditions.push(
      ["extra", "contains", `arXiv:${identifier.arXiv}`],
      ["url", "contains", `arxiv.org/abs/${identifier.arXiv}`],
    );
  if (identifier.PMID && !Array.isArray(identifier.PMID))
    conditions.push(["extra", "contains", `PMID: ${identifier.PMID}`]);
  if (identifier.adsBibcode)
    conditions.push(["extra", "contains", identifier.adsBibcode]);
  for (const [field, operator, value] of conditions) {
    const search = new Zotero.Search();
    (search as any).libraryID = libraryID;
    search.addCondition("noChildren", "true");
    search.addCondition(field as any, operator as any, value);
    const ids = await search.search();
    const items = ids.length ? await Zotero.Items.getAsync(ids) : [];
    const eligible = items
      .filter((item: any) => item.isRegularItem() && !item.deleted)
      .sort((a: any, b: any) => a.key.localeCompare(b.key));
    if (eligible.length) return eligible[0];
  }
  return null;
}

function validateFields(
  item: any,
  fields: JsonObject | undefined,
  creators: any[] | undefined,
): void {
  const clone = item.clone();
  for (const [field, value] of Object.entries(fields || {})) {
    const fieldID = Zotero.ItemFields.getID(field);
    if (
      !fieldID ||
      ["dateAdded", "dateModified"].includes(field) ||
      !Zotero.ItemFields.isValidForType(fieldID, item.itemTypeID)
    ) {
      throw new PlusError(
        "INVALID_FIELD",
        "包含不可修改或不适用于此类型的字段",
      );
    }
    if (typeof value !== "string")
      throw new PlusError("INVALID_ARGUMENT", "书目字段必须是字符串");
    clone.setField(field, value);
  }
  if (creators) {
    for (const creator of creators) {
      const creatorTypeID = Zotero.CreatorTypes.getID(creator.creatorType);
      if (
        !creatorTypeID ||
        !Zotero.CreatorTypes.isValidForItemType(creatorTypeID, item.itemTypeID)
      ) {
        throw new PlusError(
          "INVALID_CREATOR",
          "creatorType 不适用于目标条目类型",
        );
      }
      if (creator.name && (creator.firstName || creator.lastName))
        throw new PlusError(
          "INVALID_CREATOR",
          "单字段姓名与分字段姓名不能混用",
        );
    }
    clone.setCreators(creators);
  }
}

export async function inspectImportFile(
  filePath: unknown,
): Promise<JsonObject> {
  if (
    typeof filePath !== "string" ||
    !filePath ||
    /^(\\\\|\/\/)/.test(filePath)
  ) {
    throw new PlusError(
      "IMPORT_PATH_DENIED",
      "仅允许授权目录中的本地绝对文件路径",
    );
  }
  const rootsJSON = Zotero.Prefs.get(
    `${PLUS_PREF_PREFIX}.imports.allowedRoots`,
    true,
  );
  let roots: unknown;
  try {
    roots = JSON.parse(String(rootsJSON || "[]"));
  } catch {
    roots = [];
  }
  if (
    !Array.isArray(roots) ||
    !roots.length ||
    roots.some((root) => typeof root !== "string")
  ) {
    throw new PlusError(
      "IMPORT_ROOTS_REQUIRED",
      "请先在本地 Plus 设置中明确授权导入目录",
    );
  }
  const file = Cc["@mozilla.org/file/local;1"].createInstance(
    Ci.nsIFile,
  ) as any;
  try {
    file.initWithPath(filePath);
  } catch {
    throw new PlusError("IMPORT_PATH_DENIED", "文件路径无效");
  }
  // 拒绝路径任一分量中的 symlink/junction，而不是只比较字符串前缀。
  let segment = file.clone();
  while (segment) {
    if (segment.isSymlink())
      throw new PlusError(
        "IMPORT_LINK_DENIED",
        "不允许通过符号链接或 junction 导入",
      );
    segment = segment.parent;
  }
  file.normalize();
  let allowed = false;
  for (const rootPath of roots as string[]) {
    const root = Cc["@mozilla.org/file/local;1"].createInstance(
      Ci.nsIFile,
    ) as any;
    try {
      root.initWithPath(rootPath);
      let parent = root.clone();
      while (parent) {
        if (parent.isSymlink())
          throw new PlusError(
            "IMPORT_LINK_DENIED",
            "授权目录不能经过符号链接或 junction",
          );
        parent = parent.parent;
      }
      root.normalize();
      if (root.isDirectory() && root.contains(file, true)) allowed = true;
    } catch (error) {
      if (error instanceof PlusError) throw error;
      throw new PlusError("IMPORT_ROOT_INVALID", "本地授权目录配置无效");
    }
  }
  if (!allowed)
    throw new PlusError("IMPORT_PATH_DENIED", "文件不在本地授权目录内");
  if (!file.exists() || !file.isFile())
    throw new PlusError("IMPORT_FILE_UNAVAILABLE", "待导入文件不可用");
  const ext = String(file.leafName).split(".").pop()?.toLowerCase();
  if (!["pdf", "epub", "md", "txt", "html", "htm"].includes(ext || "")) {
    throw new PlusError(
      "IMPORT_TYPE_DENIED",
      "首版仅允许 PDF、EPUB、Markdown、文本和 HTML 附件",
    );
  }
  if (Zotero.isWin && /[<>:"|?*]/.test(filePath.slice(2)))
    throw new PlusError("IMPORT_PATH_DENIED", "不支持设备路径或替代数据流");
  if (file.fileSize > 100 * 1024 * 1024)
    throw new PlusError("IMPORT_TOO_LARGE", "单文件不能超过 100 MiB");
  const mime = await Zotero.MIME.getMIMETypeFromFile(file);
  const allowedMimes: Record<string, string[]> = {
    pdf: ["application/pdf"],
    epub: ["application/epub+zip", "application/zip"],
    md: ["text/plain", "text/markdown"],
    txt: ["text/plain"],
    html: ["text/html"],
    htm: ["text/html"],
  };
  if (!allowedMimes[ext!]?.includes(mime))
    throw new PlusError("IMPORT_TYPE_DENIED", "文件内容类型与允许的扩展名不符");
  if (typeof IOUtils.computeHexDigest !== "function")
    throw new PlusError("IMPORT_HASH_UNAVAILABLE", "当前环境无法验证文件摘要");
  const sha256 = await IOUtils.computeHexDigest(file.path, "sha256");
  return {
    canonicalPath: file.path,
    filename: file.leafName,
    size: file.fileSize,
    modifiedAt: file.lastModifiedTime,
    mime,
    sha256,
    rootsFingerprint: await fingerprint(roots),
  };
}

export class LegacyOperationAdapter implements OperationAdapter {
  tool: string;
  lane: "mutation" | "identifier";
  private executor: LegacyExecutor;
  constructor(tool: string, executor: LegacyExecutor) {
    this.tool = tool;
    this.lane = tool === "add_by_identifier" ? "identifier" : "mutation";
    this.executor = executor;
  }

  async prepare(args: JsonObject): Promise<OperationPlan> {
    const libraryID = requireLibraryID(args.libraryID);
    const params = { ...args, libraryID };
    const requests: JsonObject[] = [];
    if (this.tool === "add_by_identifier") {
      const raw = args.identifiers ?? args.identifier;
      const inputs = Array.isArray(raw)
        ? raw
        : typeof raw === "string"
          ? raw.split(/[\r\n]+/)
          : [];
      const unique = [
        ...new Set(
          inputs.map((entry: unknown) =>
            typeof entry === "string" ? entry.trim() : "",
          ),
        ),
      ];
      if (
        !unique.length ||
        unique.length > 200 ||
        unique.some((entry) => !entry)
      )
        throw new PlusError("INVALID_ARGUMENT", "需要 1–200 个非空 identifier");
      if (
        args.delayMs !== undefined &&
        (!Number.isInteger(args.delayMs) ||
          args.delayMs < 0 ||
          args.delayMs > 60000)
      )
        throw new PlusError("INVALID_ARGUMENT", "delayMs 范围为 0–60000");
      const canonicalIdentifiers = new Set<string>();
      for (const identifier of unique) {
        const parsed = (Zotero.Utilities as any).extractIdentifiers(identifier);
        if (parsed.length !== 1)
          throw new PlusError(
            "INVALID_IDENTIFIER",
            "每个输入必须准确对应一个 identifier",
          );
        const canonical = canonicalJSON(parsed[0]).toLowerCase();
        if (canonicalIdentifiers.has(canonical)) continue;
        canonicalIdentifiers.add(canonical);
        requests.push({
          ...params,
          identifier,
          identifiers: [identifier],
          async: false,
        });
      }
    } else if (this.tool === "write_item" && args.action === "reparent") {
      requests.push({
        ...params,
        attachmentKeys: requireKeys(args.attachmentKeys, "attachmentKeys"),
      });
    } else {
      requests.push(params);
    }
    const steps: PlanStep[] = [];
    for (const [index, request] of requests.entries()) {
      const state = await this.inspect(request);
      steps.push({
        id: `${index + 1}`,
        input: {
          args: request,
          expectedExistingKey: state.existingKey ?? null,
          before: state.snapshot,
        },
        targets: state.targets,
        fingerprint: await fingerprint(state.snapshot),
        preview: state.preview,
      });
    }
    return {
      schemaVersion: 1,
      tool: this.tool,
      libraryID,
      params,
      steps,
      warnings:
        this.tool === "add_by_identifier"
          ? [
              "将调用 Zotero translator 的网络服务，可能下载附件；识别出的最终元数据不能提前预测",
              ...(args.titleDuplicates === "skip"
                ? ["标题重复时会把新导入的条目移入回收站"]
                : []),
            ]
          : this.tool === "delete_collection"
            ? [
                "删除集合可能包含子集合；恢复插件不会恢复被删除的集合",
                ...(args.deleteItems ? ["集合中的条目还会移入回收站"] : []),
              ]
            : ["确认后逐项执行；整个批次不承诺原子完成或自动撤销"],
    };
  }

  private async inspect(args: JsonObject): Promise<{
    targets: TargetRef[];
    snapshot: JsonObject;
    preview: JsonObject;
    existingKey?: string | null;
  }> {
    const libraryID = requireLibraryID(args.libraryID);
    requireWritable(libraryID);
    const library = Zotero.Libraries.get(libraryID);
    if (!library) throw new PlusError("LIBRARY_NOT_FOUND", "目标文库不存在");
    if (
      args.tags &&
      args.tags.some((tag: string) => !tag.trim() || tag !== tag.trim())
    ) {
      throw new PlusError("INVALID_TAG", "标签不能为空或带有首尾空白");
    }
    const items = new Map<string, any>();
    const collections = new Map<string, any>();
    const addItem = async (key: string): Promise<any> => {
      requireKeys([key]);
      if (items.has(key)) return items.get(key);
      const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, key);
      if (!item) throw new PlusError("ITEM_NOT_FOUND", "目标条目不存在");
      requireWritable(libraryID, [item]);
      items.set(key, item);
      return item;
    };
    const addCollection = async (key: string): Promise<any> => {
      requireKeys([key], "collectionKeys");
      if (collections.has(key)) return collections.get(key);
      const collection = await Zotero.Collections.getByLibraryAndKeyAsync(
        libraryID,
        key,
      );
      if (!collection || collection.deleted)
        throw new PlusError("COLLECTION_NOT_FOUND", "集合不存在或已删除");
      collections.set(key, collection);
      return collection;
    };
    if (args.itemKey) await addItem(args.itemKey);
    if (args.noteKey) await addItem(args.noteKey);
    for (const property of ["parentKey", "parentItemKey"]) {
      if (args[property] && !(await addItem(args[property])).isRegularItem())
        throw new PlusError("INVALID_PARENT", "目标 parent 必须是普通文献条目");
    }
    if (args.collectionKey) await addCollection(args.collectionKey);
    if (args.parentCollection) await addCollection(args.parentCollection);
    let importFile: JsonObject | undefined;
    let existingKey: string | null | undefined;
    let parsedIdentifier: JsonObject | undefined;
    if (this.tool === "write_metadata") {
      const item = await addItem(args.itemKey);
      if (!item.isRegularItem())
        throw new PlusError(
          "INVALID_ITEM_TYPE",
          "元数据修改只适用于普通文献条目",
        );
      if (!args.fields && !args.creators)
        throw new PlusError("INVALID_ARGUMENT", "缺少 fields 或 creators");
      validateFields(item, args.fields, args.creators);
    } else if (this.tool === "write_note") {
      if (args.action !== "create") {
        if (!args.noteKey || !(await addItem(args.noteKey)).isNote())
          throw new PlusError("INVALID_NOTE", "更新或追加需要有效的 noteKey");
      }
    } else if (this.tool === "write_item") {
      if (args.action === "create") {
        const typeID = Zotero.ItemTypes.getID(args.itemType);
        if (
          !typeID ||
          ["attachment", "note", "annotation"].includes(args.itemType)
        )
          throw new PlusError(
            "INVALID_ITEM_TYPE",
            "创建目标必须是普通文献类型",
          );
        const item = new Zotero.Item(args.itemType);
        item.libraryID = libraryID;
        validateFields(item, args.fields, args.creators);
      }
      if (["create", "reparent"].includes(args.action)) {
        if (args.action === "reparent" && !args.parentKey)
          throw new PlusError("INVALID_PARENT", "reparent 需要 parentKey");
        for (const key of args.attachmentKeys
          ? requireKeys(args.attachmentKeys, "attachmentKeys")
          : []) {
          const item = await addItem(key);
          if (
            !item.isAttachment() &&
            !(args.action === "reparent" && item.isNote())
          )
            throw new PlusError(
              "INVALID_CHILD",
              "attachmentKeys 必须指向附件，reparent 也可用于笔记",
            );
          if (args.action === "create" && item.parentKey)
            throw new PlusError(
              "ALREADY_PARENTED",
              "create 只能接收独立附件，移动已有子项请单独预览 reparent",
            );
          if (item.parentKey) await addItem(item.parentKey);
          for (const collectionID of item.getCollections()) {
            const collection = Zotero.Collections.get(collectionID);
            if (collection) await addCollection(collection.key);
          }
        }
      }
      if (args.action === "import") {
        if (!args.parentKey && !args.parentItemKey)
          throw new PlusError("INVALID_PARENT", "import 需要父文献条目");
        if (!library.filesEditable)
          throw new PlusError("FILES_READ_ONLY", "文库附件不可编辑");
        importFile = await inspectImportFile(args.filePath);
      }
    } else if (
      ["add_items_to_collection", "remove_items_from_collection"].includes(
        this.tool,
      )
    ) {
      for (const key of requireKeys(args.itemKeys)) {
        const item = await addItem(key);
        if (!item.isTopLevelItem())
          throw new PlusError(
            "INVALID_COLLECTION_ITEM",
            "只能直接修改顶层条目的集合归属",
          );
      }
    } else if (this.tool === "delete_collection") {
      const root = await addCollection(args.collectionKey);
      const queue = [root];
      while (queue.length) {
        const collection = queue.shift()!;
        if (collections.size > 1000)
          throw new PlusError(
            "COLLECTION_SCOPE_TOO_LARGE",
            "一次删除不能覆盖超过 1000 个集合",
          );
        for (const child of collection.getChildCollections(false, true)) {
          if (!collections.has(child.key)) {
            await addCollection(child.key);
            queue.push(child);
          }
        }
        for (const item of collection.getChildItems(false, true)) {
          await addItem(item.key);
          if (args.deleteItems && item.isRegularItem()) {
            for (const id of [
              ...item.getAttachments(true),
              ...item.getNotes(true),
            ]) {
              const child = await Zotero.Items.getAsync(id);
              if (child) await addItem(child.key);
            }
          }
        }
      }
    } else if (this.tool === "update_collection") {
      const collection = await addCollection(args.collectionKey);
      if (args.name !== undefined && !args.name.trim())
        throw new PlusError("INVALID_ARGUMENT", "集合名不能为空");
      if (args.parentCollection) {
        const parent = await addCollection(args.parentCollection);
        if (
          parent.id === collection.id ||
          collection.hasDescendent("collection", parent.id)
        )
          throw new PlusError(
            "COLLECTION_CYCLE",
            "不能把集合移入自己或其子集合",
          );
      }
    } else if (this.tool === "create_collection" && !args.name?.trim()) {
      throw new PlusError("INVALID_ARGUMENT", "集合名不能为空");
    } else if (this.tool === "add_by_identifier") {
      const parsed = (Zotero.Utilities as any).extractIdentifiers(
        args.identifier,
      );
      if (parsed.length !== 1)
        throw new PlusError(
          "INVALID_IDENTIFIER",
          "每个输入必须准确对应一个 identifier",
        );
      parsedIdentifier = parsed[0];
      const existing =
        args.skipExisting !== false
          ? await lookupIdentifier(libraryID, parsed[0])
          : null;
      existingKey = existing?.key || null;
      if (existing) await addItem(existing.key);
      if (args.saveAttachments !== false && !library.filesEditable)
        throw new PlusError("FILES_READ_ONLY", "文库不允许保存下载附件");
    }
    const targets: TargetRef[] = [
      ...[...items.keys()].map((key) => ({
        libraryID,
        key,
        kind: "item" as const,
      })),
      ...[...collections.keys()].map((key) => ({
        libraryID,
        key,
        kind: "collection" as const,
      })),
    ];
    if (this.tool === "add_by_identifier")
      targets.push({ libraryID, key: "identifier-import", kind: "library" });
    const itemSnapshots = [...items.values()]
      .map((item) => ({
        key: item.key,
        json: item.toJSON(),
        editable: item.isEditable(),
        children: item.isRegularItem()
          ? [...item.getAttachments(true), ...item.getNotes(true)].sort(
              (a, b) => a - b,
            )
          : [],
      }))
      .sort((a, b) => a.key.localeCompare(b.key));
    const collectionSnapshots = [...collections.values()]
      .map((collection) => ({
        key: collection.key,
        name: collection.name,
        parentKey: collection.parentKey || null,
        // identifier 只授权向集合新增成员；本批上一项的合法新增不应使下一项失效。
        ...(this.tool === "add_by_identifier"
          ? {}
          : {
              items: collection
                .getChildItems(true, true)
                .slice()
                .sort((a: number, b: number) => a - b),
            }),
        children: collection
          .getChildCollections(true, true)
          .slice()
          .sort((a: number, b: number) => a - b),
      }))
      .sort((a, b) => a.key.localeCompare(b.key));
    const snapshot = {
      libraryID,
      editable: library.editable,
      filesEditable: library.filesEditable,
      items: itemSnapshots,
      collections: collectionSnapshots,
      importFile,
      parsedIdentifier,
      existingKey,
    };
    const safeArgs = { ...args };
    delete safeArgs.filePath;
    const changes: JsonObject = {};
    const target = args.itemKey ? items.get(args.itemKey) : null;
    if (this.tool === "write_metadata") {
      const clone = target.clone();
      for (const [field, value] of Object.entries(args.fields || {}))
        clone.setField(field, value);
      if (args.creators) clone.setCreators(args.creators);
      const after = clone.toJSON();
      changes.fields = Object.fromEntries(
        Object.keys(args.fields || {}).map((field) => [
          field,
          { before: target.getField(field), after: after[field] || "" },
        ]),
      );
      if (args.creators)
        changes.creators = {
          before: target.toJSON().creators,
          after: after.creators,
        };
    } else if (this.tool === "write_tag") {
      const before = target.getTags().map((tag: any) => tag.tag);
      const after =
        args.action === "set"
          ? args.tags
          : args.action === "remove"
            ? before.filter((tag: string) => !args.tags.includes(tag))
            : [...before, ...args.tags];
      changes.tags = { before, after: [...new Set(after)] };
    }
    const preview = {
      operation: this.tool,
      parameters: safeArgs,
      changes,
      affectedItems: itemSnapshots.map(({ key, json }) => ({
        key,
        itemType: json.itemType,
        parentKey: json.parentItem || null,
        title: json.title || null,
      })),
      affectedCollections: collectionSnapshots.map(
        ({ key, name, parentKey }) => ({ key, name, parentKey }),
      ),
      ...(importFile
        ? { file: { filename: importFile.filename, size: importFile.size } }
        : {}),
      ...(parsedIdentifier ? { parsedIdentifier, existingKey } : {}),
    };
    return { targets, snapshot, preview, existingKey };
  }

  async check(step: PlanStep): Promise<void> {
    const current = await this.inspect(step.input.args);
    if ((await fingerprint(current.snapshot)) !== step.fingerprint)
      throw new PlusError(
        "STATE_CHANGED",
        "目标、权限或文件状态已改变，请重新预览",
      );
  }

  private uncertain(): StepOutcome {
    return {
      state: "needs_review",
      error: {
        code: "WRITE_OUTCOME_UNKNOWN",
        message: "未能核实完整后置条件；保留目标锁，不能自动重试",
      },
      retrySafe: false,
    };
  }

  private async readItem(
    libraryID: number,
    key: string | undefined,
  ): Promise<any> {
    if (!key) return null;
    const item = await Zotero.Items.getByLibraryAndKeyAsync(libraryID, key);
    if (!item) return null;
    await (item as any).reload(undefined, true);
    return item;
  }

  private async readCollection(
    libraryID: number,
    key: string | undefined,
  ): Promise<any> {
    if (!key) return null;
    const collection = await Zotero.Collections.getByLibraryAndKeyAsync(
      libraryID,
      key,
    );
    if (collection) await (collection as any).reload(undefined, true);
    return collection || null;
  }

  private async reloadTargets(step: PlanStep): Promise<void> {
    for (const target of step.targets) {
      if (target.kind === "item")
        await this.readItem(target.libraryID, target.key);
      if (target.kind === "collection")
        await this.readCollection(target.libraryID, target.key);
    }
  }

  private fieldsMatch(item: any, args: JsonObject): boolean {
    if (!item || item.deleted) return false;
    const clone = item.clone();
    for (const [field, value] of Object.entries(args.fields || {}))
      clone.setField(field, value);
    if (args.creators) clone.setCreators(args.creators);
    const expected = clone.toJSON();
    const actual = item.toJSON();
    return (
      Object.keys(args.fields || {}).every(
        (field) => (actual[field] || "") === (expected[field] || ""),
      ) &&
      (!args.creators ||
        canonicalJSON(actual.creators) === canonicalJSON(expected.creators))
    );
  }

  private async effectsSatisfied(
    step: PlanStep,
    result?: JsonObject,
  ): Promise<boolean> {
    const args = step.input.args;
    const libraryID = args.libraryID;
    if (this.tool === "write_metadata") {
      return this.fieldsMatch(
        await this.readItem(libraryID, args.itemKey),
        args,
      );
    }
    if (this.tool === "write_tag") {
      const item = await this.readItem(libraryID, args.itemKey);
      const before =
        step.input.before.items.find((entry: any) => entry.key === args.itemKey)
          ?.json.tags || [];
      const oldTags = before.map((tag: any) => tag.tag);
      const expected =
        args.action === "set"
          ? args.tags
          : args.action === "remove"
            ? oldTags.filter((tag: string) => !args.tags.includes(tag))
            : [...oldTags, ...args.tags];
      const actual = item?.getTags().map((tag: any) => tag.tag);
      return Boolean(
        item &&
          !item.deleted &&
          canonicalJSON([...new Set(actual)].sort()) ===
            canonicalJSON([...new Set(expected)].sort()),
      );
    }
    if (this.tool === "write_note") {
      // 创建/追加中断后没有可靠关联，不凭正文相似度识别新笔记。
      if (!result?.data?.noteKey || !result.data.verificationHash) return false;
      const item = await this.readItem(libraryID, result.data.noteKey);
      return Boolean(
        item &&
          !item.deleted &&
          item.isNote() &&
          (await fingerprint(item.getNote())) ===
            result.data.verificationHash &&
          (args.action !== "create" ||
            (item.parentKey || null) === (args.parentKey || null)) &&
          (args.tags || []).every((tag: string) => item.hasTag(tag)),
      );
    }
    if (this.tool === "write_item") {
      if (args.action === "import") {
        if (!result?.data?.attachmentKey) return false;
        const item = await this.readItem(libraryID, result.data.attachmentKey);
        if (
          !item ||
          item.deleted ||
          !item.isAttachment() ||
          item.parentKey !== (args.parentItemKey || args.parentKey)
        )
          return false;
        const path = await item.getFilePathAsync();
        return Boolean(
          path &&
            (await IOUtils.computeHexDigest(path, "sha256")) ===
              step.input.before.importFile.sha256,
        );
      }
      const parentKey =
        args.action === "create" ? result?.data?.itemKey : args.parentKey;
      const parent = await this.readItem(libraryID, parentKey);
      if (!parent || parent.deleted || !parent.isRegularItem()) return false;
      if (
        args.action === "create" &&
        (parent.itemType !== args.itemType ||
          !this.fieldsMatch(parent, args) ||
          !(args.tags || []).every((tag: string) => parent.hasTag(tag)))
      )
        return false;
      for (const key of args.attachmentKeys || []) {
        const item = await this.readItem(libraryID, key);
        if (!item || item.deleted || item.parentKey !== parentKey) return false;
        const before = step.input.before.items.find(
          (entry: any) => entry.key === key,
        );
        for (const collectionKey of before?.json.collections || []) {
          const collection = await this.readCollection(
            libraryID,
            collectionKey,
          );
          if (!collection || !collection.hasItem(parent)) return false;
        }
      }
      return true;
    }
    if (this.tool === "add_by_identifier") {
      const data = result?.data;
      if (
        !data?.item?.itemKey ||
        !["exists", "imported", "duplicate_trashed"].includes(data.status)
      )
        return false;
      const item = await this.readItem(libraryID, data.item.itemKey);
      if (
        !item ||
        !item.isRegularItem() ||
        Boolean(item.deleted) !== (data.status === "duplicate_trashed")
      )
        return false;
      if (
        args.collectionKey &&
        data.status !== "duplicate_trashed" &&
        (data.status === "imported" || args.fileExisting)
      ) {
        const collection = await this.readCollection(
          libraryID,
          args.collectionKey,
        );
        if (!collection || !collection.hasItem(item)) return false;
      }
      for (const extra of data.extraItems || []) {
        if (!(await this.readItem(libraryID, extra.itemKey))) return false;
      }
      return true;
    }
    if (
      ["add_items_to_collection", "remove_items_from_collection"].includes(
        this.tool,
      )
    ) {
      const collection = await this.readCollection(
        libraryID,
        args.collectionKey,
      );
      if (!collection) return false;
      for (const key of args.itemKeys) {
        const item = await this.readItem(libraryID, key);
        if (
          !item ||
          item.deleted ||
          collection.hasItem(item) !== (this.tool === "add_items_to_collection")
        )
          return false;
      }
      return true;
    }
    if (["create_collection", "update_collection"].includes(this.tool)) {
      const key =
        this.tool === "create_collection" ? result?.key : args.collectionKey;
      const collection = await this.readCollection(libraryID, key);
      return Boolean(
        collection &&
          (args.name === undefined || collection.name === args.name.trim()) &&
          (args.parentCollection === undefined ||
            (collection.parentKey || "") === args.parentCollection),
      );
    }
    if (this.tool === "delete_collection") {
      for (const target of step.targets.filter(
        (entry) => entry.kind === "collection",
      )) {
        if (await this.readCollection(libraryID, target.key)) return false;
      }
      for (const entry of step.input.before.items) {
        const item = await this.readItem(libraryID, entry.key);
        if (
          !item ||
          (args.deleteItems
            ? !item.deleted
            : Boolean(item.deleted) !== Boolean(entry.json.deleted))
        )
          return false;
      }
      return true;
    }
    return false;
  }

  async execute(step: PlanStep): Promise<StepOutcome> {
    const args = {
      ...step.input.args,
      dryRun: false,
      async: false,
      expectedExistingKey: step.input.expectedExistingKey,
    };
    let result: JsonObject;
    try {
      result = await this.executor(this.tool, args);
      if (
        result?.success === false ||
        result?.error ||
        result?.data?.results?.some((row: any) => row.success === false) ||
        result?.notFound?.length
      ) {
        await this.reloadTargets(step);
        return this.uncertain();
      }
      if (!(await this.effectsSatisfied(step, result))) return this.uncertain();
    } catch {
      await this.reloadTargets(step);
      return this.uncertain();
    }
    if (result.data?.verificationHash) delete result.data.verificationHash;
    if (this.tool === "add_by_identifier" && args.delayMs !== 0) {
      await new Promise((resolve) => setTimeout(resolve, args.delayMs ?? 500));
    }
    return { state: "succeeded", result };
  }

  async reconcile(step: PlanStep): Promise<StepOutcome> {
    try {
      return (await this.effectsSatisfied(step))
        ? {
            state: "externally_satisfied",
            result: { operation: this.tool, attribution: "unknown" },
            retrySafe: false,
          }
        : this.uncertain();
    } catch {
      return this.uncertain();
    }
  }
}
