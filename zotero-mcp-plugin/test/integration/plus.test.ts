declare const expect: Chai.ExpectStatic;

const PREFIX = "extensions.zotero.zotero-mcp-plus";
const PROTOCOL = "2025-11-25";
const NETWORK_PDF_ENABLED =
  Zotero.Prefs.get(`${PREFIX}.test.networkPDF`, true) === true;
let rpcID = 0;

async function http(
  method: string,
  path: string,
  body?: any,
  authenticated = true,
): Promise<any> {
  const port = Zotero.Prefs.get(`${PREFIX}.mcp.server.port`, true);
  const headers: Record<string, string> = { "MCP-Protocol-Version": PROTOCOL };
  if (authenticated)
    headers.Authorization = `Bearer ${Zotero.Prefs.get(`${PREFIX}.auth.token`, true)}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return Zotero.HTTP.request(method, `http://127.0.0.1:${port}${path}`, {
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    successCodes: [200, 202, 400, 401, 403, 404, 405],
  });
}

async function rpc(method: string, params: any): Promise<any> {
  const response = await http("POST", "/mcp", {
    jsonrpc: "2.0",
    id: ++rpcID,
    method,
    params,
  });
  expect(response.status).to.equal(200);
  const envelope = JSON.parse(response.responseText);
  if (envelope.error) throw new Error(JSON.stringify(envelope.error));
  return envelope.result;
}

async function call(name: string, args: any): Promise<any> {
  const result = await rpc("tools/call", { name, arguments: args });
  return result.structuredContent ?? JSON.parse(result.content[0].text);
}

async function apply(name: string, args: any, timeoutMs = 15000): Promise<any> {
  const preview = await call(name, args);
  if (!preview.confirmationToken)
    throw new Error(`隔离测试预览没有可执行目标: ${JSON.stringify(preview)}`);
  const accepted = await call(name, {
    ...args,
    dryRun: false,
    confirmationToken: preview.confirmationToken,
    idempotencyKey: `fixture-${++rpcID}-${Date.now()}`,
  });
  if (!accepted.taskID) throw new Error(JSON.stringify(accepted));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await call("task_status", { taskID: accepted.taskID });
    if (
      !["queued", "running", "pause_requested", "cancel_requested"].includes(
        status.state,
      )
    )
      return status;
    await Zotero.Promise.delay(40);
  }
  throw new Error("隔离任务未在测试截止时间内结束；不视为原生操作已取消");
}

async function regular(title: string): Promise<any> {
  const item = new Zotero.Item("journalArticle");
  item.setField("title", title);
  await item.saveTx();
  return item;
}

function publicPDF(): string {
  const root = PathUtils.parent(
    PathUtils.parent(PathUtils.parent(Zotero.DataDirectory.dir)),
  );
  return PathUtils.join(root, "test", "fixtures", "public-recognition.pdf");
}

async function importPDF(): Promise<any> {
  return Zotero.Attachments.importFromFile({
    file: publicPDF(),
    libraryID: Zotero.Libraries.userLibraryID,
  });
}

function successful(status: any): any {
  expect(status.state, JSON.stringify(status)).to.equal("completed");
  expect(status.counts.succeeded).to.equal(1);
  return status.items[0].result;
}

describe("Plus 隔离 Zotero 9 原生与真实 HTTP 集成", function () {
  before(function () {
    const dir = Zotero.DataDirectory.dir.replace(/\\/g, "/");
    if (
      !dir.endsWith("/.scaffold/test/data") ||
      Zotero.Prefs.get(`${PREFIX}.test.isolated`, true) !== true
    ) {
      throw new Error("禁止在真实文库运行集成写入测试");
    }
    expect(Zotero.version).to.equal("9.0.6");
  });

  after(async function () {
    if (
      !Zotero.DataDirectory.dir
        .replace(/\\/g, "/")
        .endsWith("/.scaffold/test/data") ||
      Zotero.Prefs.get(`${PREFIX}.test.isolated`, true) !== true
    )
      return;
    const tests = this.test?.parent?.tests || [];
    await IOUtils.writeUTF8(
      PathUtils.join(Zotero.DataDirectory.dir, "plus-integration-result.json"),
      JSON.stringify({
        total: tests.length,
        passed: tests.filter((test) => test.state === "passed").length,
        failed: tests.filter((test) => test.state === "failed").length,
        failures: tests
          .filter((test) => test.state === "failed")
          .map((test) => ({
            title: test.title,
            message: test.err?.message,
            stack: test.err?.stack,
          })),
        consoleErrors: Services.console
          .getMessageArray()
          .map((entry: any) => String(entry.message))
          .filter(
            (message: string) =>
              message.includes("zotero-mcp-plus") ||
              message.includes(".scaffold"),
          ),
      }),
    );
  });

  it("未认证请求被拒绝，GET SSE 与旧 REST 写入口被关闭", async function () {
    expect(
      (
        await http(
          "POST",
          "/mcp",
          { jsonrpc: "2.0", id: 1, method: "ping" },
          false,
        )
      ).status,
    ).to.equal(401);
    expect((await http("GET", "/mcp")).status).to.equal(405);
    expect(
      (await http("POST", "/collections", { name: "不能写入" })).status,
    ).to.equal(405);
    expect((await http("GET", "/test/mcp")).status).to.equal(404);
  });

  it("真实 initialize 与 tools/list 的身份、协议和工具注册表一致", async function () {
    const initialized = await rpc("initialize", {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: "plus-isolated-fixture", version: "1" },
    });
    expect(initialized.serverInfo).to.deep.equal({
      name: "zotero-mcp-plus",
      version: "0.1.0",
    });
    expect(initialized.protocolVersion).to.equal(PROTOCOL);
    expect(initialized.capabilities).to.deep.equal({ tools: {} });
    const { tools } = await rpc("tools/list", {});
    expect(tools).to.have.length(36);
    expect(new Set(tools.map((tool: any) => tool.name)).size).to.equal(36);
    expect(tools.map((tool: any) => tool.name)).to.include.members([
      "recognize_pdfs",
      "merge_items",
      "library_health",
      "write_note",
      "add_by_identifier",
    ]);
    const response = await http("POST", "/mcp", {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(response.status).to.equal(202);
    expect(response.responseText).to.equal("");
  });

  it("独立安装通过原生安全校验，更新地址不继承上游", async function () {
    const { AddonManager } = ChromeUtils.importESModule(
      "resource://gre/modules/AddonManager.sys.mjs",
    );
    const addon = await AddonManager.getAddonByID(
      "{8c2b53b8-6a58-4fc1-b20f-07612fce0a77}",
    );
    expect(addon.version).to.equal("0.1.0");
    expect(addon.isActive).to.equal(true);
    expect(addon.appDisabled).to.equal(false);
    expect(addon.providesUpdatesSecurely).to.equal(true);
    expect(addon.updateURL).to.equal(
      "https://example.invalid/zotero-mcp-plus/updates.json",
    );
    expect(AddonManager.checkUpdateSecurity).to.equal(true);
  });

  it("默认禁写仍可预览；未确认与字符串布尔值不会创建条目", async function () {
    const args = {
      action: "create",
      itemType: "journalArticle",
      fields: { title: "默认预览——中文🙂" },
    };
    const before = (await Zotero.Items.getAll(Zotero.Libraries.userLibraryID))
      .length;
    const preview = await call("write_item", args);
    expect(preview.dryRun, JSON.stringify(preview)).to.equal(true);
    expect(preview.writeEnabled).to.equal(false);
    expect(preview.confirmationToken).to.be.a("string");
    const denied = await call("write_item", {
      ...args,
      dryRun: false,
      confirmationToken: preview.confirmationToken,
      idempotencyKey: "disabled-fixture",
    });
    expect(denied.error.code).to.equal("WRITE_DISABLED");
    const malformed = await call("write_item", { ...args, dryRun: "false" });
    expect(malformed.error.code).to.equal("INVALID_ARGUMENT");
    expect(
      (await Zotero.Items.getAll(Zotero.Libraries.userLibraryID)).length,
    ).to.equal(before);
  });

  it("确认后创建并持久记录任务，幂等重放不创建第二条", async function () {
    Zotero.Prefs.set(`${PREFIX}.write.enabled`, true, true);
    const args = {
      action: "create",
      itemType: "journalArticle",
      fields: { title: "已确认的中文标题🙂" },
    };
    const preview = await call("write_item", args);
    const request = {
      ...args,
      dryRun: false,
      confirmationToken: preview.confirmationToken,
      idempotencyKey: "create-once-fixture",
    };
    const first = await call("write_item", request);
    const replay = await call("write_item", request);
    expect(replay.taskID).to.equal(first.taskID);
    expect(replay.replayed).to.equal(true);
    let status: any;
    for (let n = 0; n < 150; n++) {
      status = await call("task_status", { taskID: first.taskID });
      if (status.state !== "queued" && status.state !== "running") break;
      await Zotero.Promise.delay(40);
    }
    const result = successful(status);
    const item = await Zotero.Items.getByLibraryAndKeyAsync(
      Zotero.Libraries.userLibraryID,
      result.data.itemKey,
    );
    expect(item && item.getField("title")).to.equal(args.fields.title);
    const snapshot = await call("task_list", { tool: "write_item" });
    expect(snapshot.tasks.map((task: any) => task.id)).to.include(first.taskID);
    expect(JSON.stringify(status)).not.to.include(preview.confirmationToken);
  });

  it("标签、元数据、笔记及集合写入保留原能力，并核实实际状态", async function () {
    const item = await regular("兼容写测试");
    successful(
      await apply("write_tag", {
        itemKey: item.key,
        action: "set",
        tags: ["fixture", "中文标签"],
      }),
    );
    expect(item.hasTag("中文标签")).to.equal(true);
    successful(
      await apply("write_metadata", {
        itemKey: item.key,
        fields: { title: "已更新标题" },
        creators: [
          { creatorType: "author", firstName: "Test", lastName: "Fixture" },
        ],
      }),
    );
    expect(item.getField("title")).to.equal("已更新标题");
    const noteResult = successful(
      await apply("write_note", {
        action: "create",
        parentKey: item.key,
        content: "# 测试\n\n只在隔离文库。",
      }),
    );
    const note = await Zotero.Items.getByLibraryAndKeyAsync(
      item.libraryID,
      noteResult.data.noteKey,
    );
    expect(note && note.parentKey).to.equal(item.key);
    successful(
      await apply("write_note", {
        action: "append",
        noteKey: noteResult.data.noteKey,
        content: "追加内容",
      }),
    );
    expect(note && note.getNote()).to.contain("追加内容");
    const collectionResult = successful(
      await apply("create_collection", { name: "隔离集合" }),
    );
    successful(
      await apply("add_items_to_collection", {
        collectionKey: collectionResult.key,
        itemKeys: [item.key],
      }),
    );
    const collection = await Zotero.Collections.getByLibraryAndKeyAsync(
      item.libraryID,
      collectionResult.key,
    );
    expect(collection && collection.hasItem(item)).to.equal(true);
    successful(
      await apply("remove_items_from_collection", {
        collectionKey: collectionResult.key,
        itemKeys: [item.key],
      }),
    );
    expect(collection && collection.hasItem(item)).to.equal(false);
  });

  it("预览后的 UI 修改会使写入失败且不会覆盖外部修改", async function () {
    const item = await regular("预览前");
    const args = { itemKey: item.key, fields: { title: "不能覆盖" } };
    const preview = await call("write_metadata", args);
    item.setField("title", "用户界面新修改");
    await item.saveTx();
    const accepted = await call("write_metadata", {
      ...args,
      dryRun: false,
      confirmationToken: preview.confirmationToken,
      idempotencyKey: "stale-fixture",
    });
    let status: any;
    for (let n = 0; n < 100; n++) {
      status = await call("task_status", { taskID: accepted.taskID });
      if (status.state !== "queued" && status.state !== "running") break;
      await Zotero.Promise.delay(40);
    }
    expect(status.state).to.equal("completed_with_errors");
    expect(status.items[0].error.code).to.equal("STATE_CHANGED");
    expect(item.getField("title")).to.equal("用户界面新修改");
  });

  it("原生合并保留笔记、标签和集合，单独 trash 不等于合并", async function () {
    const master = await regular("合并主条目");
    const donor = await regular("合并字段来源");
    donor.addTag("来自donor");
    await donor.saveTx();
    const note = new Zotero.Item("note");
    note.parentKey = donor.key;
    note.setNote("<p>合并时保留的笔记</p>");
    await note.saveTx();
    const collection = new Zotero.Collection();
    collection.name = "合并来源集合";
    await collection.saveTx();
    donor.addToCollection(collection.id);
    await donor.saveTx();
    const textPath = PathUtils.join(
      Zotero.DataDirectory.dir,
      "merge-donor.txt",
    );
    await IOUtils.writeUTF8(textPath, "普通附件也必须保留");
    const textAttachment = await Zotero.Attachments.importFromFile({
      file: textPath,
      parentItemID: donor.id,
    });
    const masterPDF = await importPDF();
    masterPDF.parentKey = master.key;
    await masterPDF.saveTx();
    const status = await apply("merge_items", {
      groups: [
        {
          masterKey: master.key,
          otherKeys: [donor.key],
          fieldSources: { title: donor.key },
        },
      ],
    });
    successful(status);
    expect(master.getField("title")).to.equal("合并字段来源");
    expect(master.hasTag("来自donor")).to.equal(true);
    expect(master.getCollections()).to.include(collection.id);
    expect(note.parentKey).to.equal(master.key);
    expect(textAttachment.parentKey).to.equal(master.key);
    expect(textAttachment.deleted).to.equal(false);
    expect(masterPDF.parentKey).to.equal(master.key);
    expect(masterPDF.deleted).to.equal(false);
    expect(donor.deleted).to.equal(true);
  });

  it("原生识别能力可探测，非 PDF 与不存在的目标不会被提交", async function () {
    expect(typeof Zotero.RecognizeDocument.canRecognize).to.equal("function");
    expect(typeof Zotero.RecognizeDocument.recognizeItems).to.equal("function");
    const item = await regular("不能当PDF识别");
    const preview = await call("recognize_pdfs", {
      attachmentKeys: [item.key, "ZZZZZZZZ"],
    });
    expect(preview.eligible).to.equal(0);
    expect(preview.confirmationToken).to.equal(undefined);
    const standalone = await call("find_standalone_attachments", { limit: 10 });
    expect(JSON.stringify(standalone)).not.to.include(Zotero.DataDirectory.dir);
  });

  it("新建 parent 和批量 reparent 保留原独立附件的全部集合", async function () {
    const a = await importPDF();
    const b = await importPDF();
    const collection = new Zotero.Collection();
    collection.name = "附件原集合";
    await collection.saveTx();
    a.addToCollection(collection.id);
    b.addToCollection(collection.id);
    await a.saveTx();
    await b.saveTx();
    const created = successful(
      await apply("write_item", {
        action: "create",
        itemType: "journalArticle",
        fields: { title: "附件新父条目" },
        attachmentKeys: [a.key, b.key],
      }),
    );
    const parent = await Zotero.Items.getByLibraryAndKeyAsync(
      a.libraryID,
      created.data.itemKey,
    );
    expect(a.parentKey).to.equal(parent.key);
    expect(b.parentKey).to.equal(parent.key);
    expect(parent.getCollections()).to.include(collection.id);
    const target = await regular("整组移动目的条目");
    successful(
      await apply("write_item", {
        action: "reparent",
        attachmentKeys: [a.key, b.key],
        parentKey: target.key,
      }),
    );
    expect(a.parentKey).to.equal(target.key);
    expect(b.parentKey).to.equal(target.key);
  });

  it("保全策略拒绝带 PDF 的 donor，不 trash 条目或附件", async function () {
    const master = await regular("保全主项");
    const donor = await regular("含PDF的donor");
    const attachment = await importPDF();
    attachment.parentKey = donor.key;
    await attachment.saveTx();
    const preview = await call("merge_items", {
      groups: [{ masterKey: master.key, otherKeys: [donor.key] }],
    });
    expect(preview.eligible, JSON.stringify(preview)).to.equal(0);
    expect(preview.confirmationToken).to.equal(undefined);
    expect(
      preview.items[0].blockers.map((block: any) => block.code),
    ).to.include("ATTACHMENT_PRESERVATION_UNSUPPORTED");
    expect(donor.deleted).to.equal(false);
    expect(attachment.deleted).to.equal(false);
    expect(attachment.parentKey).to.equal(donor.key);
  });

  it("文件导入绑定授权根与复制后内容，旧附件搜索保留 HTML", async function () {
    const parent = await regular("授权导入测试");
    Zotero.Prefs.set(
      `${PREFIX}.imports.allowedRoots`,
      JSON.stringify([PathUtils.parent(publicPDF())]),
      true,
    );
    const args = {
      action: "import",
      parentItemKey: parent.key,
      filePath: publicPDF(),
    };
    const preview = await call("write_item", args);
    expect(preview.confirmationToken, JSON.stringify(preview)).to.be.a(
      "string",
    );
    expect(JSON.stringify(preview)).not.to.include(publicPDF());
    successful(await apply("write_item", args));
    expect(parent.getAttachments()).to.have.length(1);
    const path = PathUtils.join(
      Zotero.DataDirectory.dir,
      "standalone-fixture.html",
    );
    await IOUtils.writeUTF8(
      path,
      "<!doctype html><title>独立网页附件</title><p>本地测试</p>",
    );
    const html = await Zotero.Attachments.importFromFile({
      file: path,
      libraryID: parent.libraryID,
    });
    html.addTag("fixture-html");
    await html.saveTx();
    const found = await call("search_library", {
      itemType: "attachment",
      tag: "fixture-html",
      includeAttachments: "true",
    });
    expect(
      found.items.map((item: any) => item.key),
      JSON.stringify(found),
    ).to.include(html.key);
    const excluded = await call("search_library", {
      itemType: "attachment",
      includeAttachments: "false",
    });
    expect(excluded.items).to.have.length(0);
    const pdfs = await call("find_standalone_attachments", { limit: 100 });
    expect(pdfs.items.map((item: any) => item.key)).not.to.include(html.key);
  });

  it("认证轮换会作废旧确认，切换端口后使用新监听", async function () {
    const item = await regular("安全偏好测试");
    const args = { itemKey: item.key, tags: ["不能写入"], action: "add" };
    const preview = await call("write_tag", args);
    const previousToken = Zotero.Prefs.get(
      `${PREFIX}.auth.token`,
      true,
    ) as string;
    const previousPort = Zotero.Prefs.get(
      `${PREFIX}.mcp.server.port`,
      true,
    ) as number;
    try {
      Zotero.Prefs.set(`${PREFIX}.auth.token`, "a".repeat(64), true);
      await Zotero.Promise.delay(250);
      const rejected = await call("write_tag", {
        ...args,
        dryRun: false,
        confirmationToken: preview.confirmationToken,
        idempotencyKey: "rotated-confirmation",
      });
      expect(["CONFIRMATION_REQUIRED", "CONFIRMATION_EXPIRED"]).to.include(
        rejected.error?.code,
      );
      const oldAuth = await Zotero.HTTP.request(
        "POST",
        `http://127.0.0.1:${previousPort}/mcp`,
        {
          headers: {
            Authorization: `Bearer ${previousToken}`,
            "Content-Type": "application/json",
            "MCP-Protocol-Version": PROTOCOL,
          },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
          successCodes: [401],
        },
      );
      expect(oldAuth.status).to.equal(401);
      Zotero.Prefs.set(`${PREFIX}.mcp.server.port`, 23126, true);
      await Zotero.Promise.delay(250);
      expect(await rpc("ping", {})).to.deep.equal({});
      expect(item.hasTag("不能写入")).to.equal(false);
    } finally {
      Zotero.Prefs.set(`${PREFIX}.auth.token`, previousToken, true);
      Zotero.Prefs.set(`${PREFIX}.mcp.server.port`, previousPort, true);
      await Zotero.Promise.delay(250);
    }
  });

  if (NETWORK_PDF_ENABLED) {
    // 仅在显式允许联网时注册公开 PDF 用例。

    it("公开 CC BY PDF 原生联网识别保留文件、批注和两个集合", async function () {
      this.timeout(180000);
      const attachment = await importPDF();
      const originalHash = await IOUtils.computeHexDigest(
        await attachment.getFilePathAsync(),
        "sha256",
      );
      const collections: any[] = [];
      for (const name of ["识别来源集合一", "识别来源集合二"]) {
        const collection = new Zotero.Collection();
        collection.name = name;
        await collection.saveTx();
        collections.push(collection);
        attachment.addToCollection(collection.id);
      }
      await attachment.saveTx();
      const annotation = new Zotero.Item("annotation");
      annotation.libraryID = attachment.libraryID;
      annotation.parentID = attachment.id;
      annotation.annotationType = "highlight";
      annotation.annotationText = "公开材料上的测试批注";
      annotation.annotationColor = "#ffd400";
      annotation.annotationPageLabel = "1";
      annotation.annotationSortIndex = "00000|000000|00000";
      annotation.annotationPosition = JSON.stringify({
        pageIndex: 0,
        rects: [[10, 10, 100, 30]],
      });
      await annotation.saveTx();
      const result = successful(
        await apply(
          "recognize_pdfs",
          { attachmentKeys: [attachment.key, attachment.key] },
          150000,
        ),
      );
      expect(result.attachmentKey).to.equal(attachment.key);
      const parent = attachment.parentItem;
      expect(parent && parent.isRegularItem()).to.equal(true);
      expect(parent.getField("DOI").toLowerCase()).to.equal(
        "10.1371/journal.pmed.0020124",
      );
      for (const collection of collections)
        expect(parent.getCollections()).to.include(collection.id);
      expect(annotation.parentID).to.equal(attachment.id);
      expect(annotation.deleted).to.equal(false);
      expect(
        await IOUtils.computeHexDigest(
          await attachment.getFilePathAsync(),
          "sha256",
        ),
      ).to.equal(originalHash);
    });
  }

  it("旧 identifier 的 jobID 查询复用持久任务且不重复导入已有条目", async function () {
    const item = await regular("已有 identifier 本地回归");
    item.setField("DOI", "10.5555/12345678");
    await item.saveTx();
    const collection = new Zotero.Collection();
    collection.name = "identifier 目标集合";
    await collection.saveTx();
    const before = (await Zotero.Items.getAll(item.libraryID)).length;
    const args = {
      identifiers: ["10.5555/12345678"],
      collectionKey: collection.key,
      fileExisting: true,
      saveAttachments: false,
      delayMs: 0,
    };
    const preview = await call("add_by_identifier", args);
    expect(preview.confirmationToken, JSON.stringify(preview)).to.be.a(
      "string",
    );
    const accepted = await call("add_by_identifier", {
      ...args,
      dryRun: false,
      confirmationToken: preview.confirmationToken,
      idempotencyKey: "identifier-existing-fixture",
    });
    expect(accepted.jobID).to.equal(accepted.taskID);
    let status: any;
    for (let n = 0; n < 150; n++) {
      status = await call("add_by_identifier", { jobID: accepted.jobID });
      if (!["queued", "running"].includes(status.state)) break;
      await Zotero.Promise.delay(40);
    }
    successful(status);
    expect(status.jobID).to.equal(accepted.taskID);
    expect(item.getCollections()).to.include(collection.id);
    expect((await Zotero.Items.getAll(item.libraryID)).length).to.equal(before);
  });

  it("健康检查只读，预算与任务概况显式返回", async function () {
    const before = (await Zotero.Items.getAll(Zotero.Libraries.userLibraryID))
      .length;
    const health = await call("library_health", {
      maxItems: 2,
      includeDuplicates: true,
    });
    expect(health.error, JSON.stringify(health)).to.equal(undefined);
    expect(
      (await Zotero.Items.getAll(Zotero.Libraries.userLibraryID)).length,
    ).to.equal(before);
    expect(JSON.stringify(health)).not.to.include(Zotero.DataDirectory.dir);
  });
});
