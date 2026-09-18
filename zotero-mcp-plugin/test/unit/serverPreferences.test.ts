import { expect } from "chai";
import type { ServerPreferences } from "../../src/modules/serverPreferences.ts";

const prefix = "extensions.zotero.zotero-mcp-plus";

describe("ServerPreferences 原生偏好观察者契约", function () {
  let prefs: ServerPreferences;
  let values: Map<string, unknown>;
  let observers: Map<
    symbol,
    { key: string; handler: (value: unknown) => void }
  >;
  let previousZotero: unknown;

  beforeEach(async function () {
    previousZotero = (globalThis as any).Zotero;
    values = new Map();
    observers = new Map();
    const globalKey = (name: string, global?: boolean) =>
      global ? name : `extensions.zotero.${name}`;
    (globalThis as any).Zotero = {
      Prefs: {
        get: (name: string, global?: boolean) =>
          values.get(globalKey(name, global)),
        set: (name: string, value: unknown, global?: boolean) => {
          const key = globalKey(name, global);
          const old = values.get(key);
          values.set(key, value);
          if (old !== value) {
            for (const observer of observers.values()) {
              if (observer.key === key) observer.handler(value);
            }
          }
        },
        registerObserver: (
          name: string,
          handler: (value: unknown) => void,
          global?: boolean,
        ) => {
          const id = Symbol();
          observers.set(id, { key: globalKey(name, global), handler });
          return id;
        },
        unregisterObserver: (id: symbol) => observers.delete(id),
      },
    };
    const module = await import("../../src/modules/serverPreferences.ts");
    module.serverPreferences.unregister();
    prefs = new module.ServerPreferences();
  });

  afterEach(function () {
    prefs?.unregister();
    (globalThis as any).Zotero = previousZotero;
  });

  it("完整偏好名使用 global=true，回调通知名称而不是新值", function () {
    const changes: string[] = [];
    prefs.addObserver((name) => {
      changes.push(name);
    });
    Zotero.Prefs.set(`${prefix}.auth.token`, "a".repeat(64), true);
    prefs.setWriteEnabled(true);
    prefs.setPort(23126);
    expect(changes).to.deep.equal([
      `${prefix}.auth.token`,
      `${prefix}.write.enabled`,
      `${prefix}.mcp.server.port`,
    ]);
  });

  it("轮换只通知一次且不复用令牌", function () {
    const before = prefs.getAuthToken();
    const changes: string[] = [];
    prefs.addObserver((name) => {
      changes.push(name);
    });
    const after = prefs.rotateAuthToken();
    expect(after).to.match(/^[a-f0-9]{64}$/);
    expect(after).not.to.equal(before);
    expect(changes).to.deep.equal([`${prefix}.auth.token`]);
  });

  it("无效布尔偏好不能误启用写入或语义自动处理", function () {
    for (const key of [
      "write.enabled",
      "semantic.enabled",
      "semantic.autoUpdate",
      "mcp.server.enabled",
    ])
      values.set(`${prefix}.${key}`, "false");
    expect(prefs.isWriteEnabled()).to.equal(false);
    expect(prefs.isSemanticEnabled()).to.equal(false);
    expect(prefs.isSemanticAutoUpdateEnabled()).to.equal(false);
    expect(prefs.isServerEnabled()).to.equal(false);
  });

  it("拒绝小数端口，注销后不再接收通知", function () {
    expect(() => prefs.setPort(23121.5)).to.throw();
    const changes: string[] = [];
    prefs.addObserver((name) => {
      changes.push(name);
    });
    prefs.unregister();
    Zotero.Prefs.set(`${prefix}.write.enabled`, true, true);
    expect(changes).to.deep.equal([]);
    expect(observers.size).to.equal(0);
  });
});
