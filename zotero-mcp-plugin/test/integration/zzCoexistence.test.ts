declare const expect: Chai.ExpectStatic;

const PREFIX = "extensions.zotero.zotero-mcp-plus";
const PLUS_ID = "{8c2b53b8-6a58-4fc1-b20f-07612fce0a77}";
let requestID = 0;

async function plusCall(name: string, args: any = {}): Promise<any> {
  const port = Zotero.Prefs.get(`${PREFIX}.mcp.server.port`, true);
  const response = await Zotero.HTTP.request(
    "POST",
    `http://127.0.0.1:${port}/mcp`,
    {
      headers: {
        Authorization: `Bearer ${Zotero.Prefs.get(`${PREFIX}.auth.token`, true)}`,
        "Content-Type": "application/json",
        "MCP-Protocol-Version": "2025-11-25",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++requestID,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    },
  );
  const envelope = JSON.parse(response.responseText);
  if (envelope.error) throw new Error(JSON.stringify(envelope.error));
  return (
    envelope.result.structuredContent ??
    JSON.parse(envelope.result.content[0].text)
  );
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 15000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("隔离插件生命周期等待超时");
    await Zotero.Promise.delay(50);
  }
}

function isolated(): boolean {
  return (
    Zotero.DataDirectory.dir
      .replace(/\\/g, "/")
      .endsWith("/.scaffold/test/data") &&
    Zotero.Prefs.get(`${PREFIX}.test.isolated`, true) === true
  );
}

describe("原版与 Plus 隔离并行及热重载", function () {
  let manager: any;
  let original: any;
  let originalInstance: any;

  before(async function () {
    if (!isolated()) throw new Error("只允许隔离文库安装测试插件");
    const path = Zotero.Prefs.get(`${PREFIX}.test.legacyXPI`, true) as string;
    if (!path) {
      this.skip();
      return;
    }
    manager = ChromeUtils.importESModule(
      "resource://gre/modules/AddonManager.sys.mjs",
    ).AddonManager;
    const nativePath = Zotero.isWin ? path.replace(/\//g, "\\") : path;
    original = await manager.installTemporaryAddon(
      Zotero.File.pathToFile(nativePath),
    );
    expect(original.id).to.equal("zotero-mcp-plugin@autoagent.my");
    expect(original.version).to.equal("1.6.0");
    await until(() => !!(Zotero as any).ZoteroMCP?.data.initialized);
    originalInstance = (Zotero as any).ZoteroMCP;
  });

  after(async function () {
    if (!isolated()) return;
    const tests = this.test?.parent?.tests || [];
    await IOUtils.writeUTF8(
      PathUtils.join(Zotero.DataDirectory.dir, "coexistence-result.json"),
      JSON.stringify({
        total: tests.length,
        passed: tests.filter((test) => test.state === "passed").length,
        failed: tests.filter((test) => test.state === "failed").length,
      }),
    );
    await original?.uninstall();
  });

  it("两个独立实例与端口并存，Plus 写入开关不改变原版", async function () {
    expect((Zotero as any).ZoteroMCPPlus).not.to.equal(originalInstance);
    expect(Zotero.Prefs.get(`${PREFIX}.mcp.server.port`, true)).to.equal(23125);
    expect(
      Zotero.Prefs.get(
        "extensions.zotero.zotero-mcp-plugin.mcp.server.port",
        true,
      ),
    ).to.equal(23127);
    const legacy = await Zotero.HTTP.request(
      "GET",
      "http://127.0.0.1:23127/mcp/status",
    );
    expect(legacy.status).to.equal(200);
    Zotero.Prefs.set(`${PREFIX}.write.enabled`, true, true);
    expect(
      Zotero.Prefs.get(
        "extensions.zotero.zotero-mcp-plugin.write.enabled",
        true,
      ),
    ).to.equal(false);
    const health = await plusCall("library_health", { maxItems: 2 });
    expect(health.error, JSON.stringify(health)).to.equal(undefined);
  });

  it("停用 Plus 清理监听，重新启用后保留任务且不影响原版实例", async function () {
    this.timeout(45000);
    const params = {
      action: "create",
      itemType: "journalArticle",
      fields: { title: "热重载持久任务" },
    };
    const preview = await plusCall("write_item", params);
    const accepted = await plusCall("write_item", {
      ...params,
      dryRun: false,
      confirmationToken: preview.confirmationToken,
      idempotencyKey: "hot-reload-fixture",
    });
    expect(accepted.taskID, JSON.stringify(accepted)).to.be.a("string");
    let status: any;
    for (let n = 0; n < 150; n++) {
      status = await plusCall("task_status", { taskID: accepted.taskID });
      if (status.state !== "queued" && status.state !== "running") break;
      await Zotero.Promise.delay(40);
    }
    expect(status.state, JSON.stringify(status)).to.equal("completed");
    const oldPlus = (Zotero as any).ZoteroMCPPlus;
    const addon = await manager.getAddonByID(PLUS_ID);
    try {
      await addon.disable();
      await until(() => !(Zotero as any).ZoteroMCPPlus);
      expect(oldPlus.data.httpServer.isServerRunning()).to.equal(false);
      expect((Zotero as any).ZoteroMCP).to.equal(originalInstance);
      await addon.enable();
      await until(() => !!(Zotero as any).ZoteroMCPPlus?.data.initialized);
      expect((Zotero as any).ZoteroMCPPlus).not.to.equal(oldPlus);
      const reopened = await plusCall("task_status", {
        taskID: accepted.taskID,
      });
      expect(reopened.state, JSON.stringify(reopened)).to.equal("completed");
      expect(reopened.counts.succeeded).to.equal(1);
      expect(
        (await Zotero.HTTP.request("GET", "http://127.0.0.1:23127/mcp/status"))
          .status,
      ).to.equal(200);
    } finally {
      if (addon.userDisabled) await addon.enable();
    }
  });
});
