import { defineConfig } from "zotero-plugin-scaffold";
import pkg from "./package.json";
import { readFile, writeFile } from "node:fs/promises";

// Zotero 9 要求非空 HTTPS update_url；保留 .invalid 占位，不提供在线更新。
const DISABLED_UPDATE_URL =
  "https://example.invalid/zotero-mcp-plus/updates.json";

export default defineConfig({
  source: ["src", "addon"],
  dist: ".scaffold/build",
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,

  build: {
    // 由本项目维护 manifest，避免脚手架根据上游 repository 自动注入更新地址。
    makeManifest: { enable: false },
    assets: ["addon/**/*.*"],
    define: {
      ...pkg.config,
      disabledUpdateURL: DISABLED_UPDATE_URL,
      author: pkg.author,
      description: pkg.description,
      buildVersion: pkg.version,
      buildTime: "{{buildTime}}",
    },
    prefs: {
      prefix: pkg.config.prefsPrefix,
    },
    esbuildOptions: [
      {
        entryPoints: ["src/index.ts"],
        define: {
          __env__: `"${process.env.NODE_ENV}"`,
        },
        bundle: true,
        target: "firefox115",
        outfile: `.scaffold/build/addon/content/scripts/${pkg.config.addonRef}.js`,
      },
    ],
  },

  server: {
    startArgs: ["-no-remote"],
    devtools: false,
  },

  test: {
    entries: ["test/integration"],
    watch: false,
    headless: false,
    mocha: { timeout: 30000 },
    prefs: {
      [`${pkg.config.prefsPrefix}.test.isolated`]: true,
      [`${pkg.config.prefsPrefix}.test.networkPDF`]:
        process.env.PLUS_TEST_NETWORK_PDF === "1",
      [`${pkg.config.prefsPrefix}.firstInstallPromptShown`]: true,
      [`${pkg.config.prefsPrefix}.mcp.server.port`]: 23125,
      [`${pkg.config.prefsPrefix}.write.enabled`]: false,
      [`${pkg.config.prefsPrefix}.semantic.enabled`]: false,
      [`${pkg.config.prefsPrefix}.semantic.autoUpdate`]: false,
      "extensions.zotero.sync.autoSync": false,
      "extensions.update.enabled": false,
      [`${pkg.config.prefsPrefix}.test.legacyXPI`]:
        process.env.ZOTERO_PLUS_LEGACY_XPI || "",
      "extensions.zotero.mcp.firstInstallPromptShown": true,
      "extensions.zotero.zotero-mcp-plugin.mcp.server.port": 23127,
      "extensions.zotero.zotero-mcp-plugin.mcp.server.enabled": true,
      "extensions.zotero.zotero-mcp-plugin.mcp.server.allowRemote": false,
      "extensions.zotero.zotero-mcp-plugin.write.enabled": false,
      "extensions.zotero.zotero-mcp-plugin.semantic.enabled": false,
      "extensions.zotero.zotero-mcp-plugin.semantic.autoUpdate": false,
    },
    waitForPlugin: `() => !!Zotero.${pkg.config.addonInstance}?.data.initialized`,
  },

  hooks: {
    "build:makeManifest": async (ctx) => {
      const manifest = JSON.parse(
        await readFile(`${ctx.dist}/addon/manifest.json`, "utf8"),
      );
      const application = manifest.applications?.zotero;
      if (
        application?.id !== pkg.config.addonID ||
        manifest.version !== pkg.version ||
        application.update_url !== DISABLED_UPDATE_URL
      ) {
        throw new Error("Plus manifest 身份、版本或禁用自动更新约束未满足");
      }
    },
    "test:bundleTests": async () => {
      // scaffold 在等待失败时尚未送出错误便退出；仅为本次生成的测试启动器增加本地诊断。
      const path = ".scaffold/test/resource/bootstrap.js";
      const source = await readFile(path, "utf8");
      const anchor =
        "launchTests().catch((error) => {\n    Zotero.debug(error);";
      if (!source.includes(anchor))
        throw new Error("测试启动器结构已变化，请核对诊断适配");
      await writeFile(
        path,
        source.replace(
          anchor,
          `launchTests().catch(async (error) => {
    Zotero.debug(error);
    const dir = Zotero.DataDirectory.dir.replaceAll('\\\\', '/');
    if (dir.endsWith('/.scaffold/test/data') && Zotero.Prefs.get('${pkg.config.prefsPrefix}.test.isolated', true) === true) {
      await Zotero.File.putContentsAsync(dir + '/plus-startup-error.json', JSON.stringify({
        message: String(error),
        pluginExists: !!Zotero.${pkg.config.addonInstance},
        initialized: !!Zotero.${pkg.config.addonInstance}?.data.initialized,
        errors: Services.console.getMessageArray().map(entry => String(entry.message)).filter(message => message.includes('${pkg.config.addonRef}') || message.includes('.scaffold'))
      }));
    }`,
        ),
      );
    },
  },

  // If you need to see a more detailed log, uncomment the following line:
  // logLevel: "trace",
});
