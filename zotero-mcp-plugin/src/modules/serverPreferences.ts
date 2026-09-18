/**
 * Zotero MCP Plus - 服务器偏好设置管理
 *
 * 管理端口 (默认 23121)、服务启闭、文库写入开关 (默认关闭)、
 * 语义搜索开关 (默认关闭) 及安全随机 Bearer 认证令牌的持久化与轮换。
 */

import { generateBearerToken } from "./httpSecurity.ts";

declare let ztoolkit: ZToolkit;

export const PREFS_PREFIX = "extensions.zotero.zotero-mcp-plus";
export const PREF_PORT = `${PREFS_PREFIX}.mcp.server.port`;
export const PREF_ENABLED = `${PREFS_PREFIX}.mcp.server.enabled`;
export const PREF_WRITE_ENABLED = `${PREFS_PREFIX}.write.enabled`;
export const PREF_SEMANTIC_ENABLED = `${PREFS_PREFIX}.semantic.enabled`;
export const PREF_SEMANTIC_AUTO_UPDATE = `${PREFS_PREFIX}.semantic.autoUpdate`;
export const PREF_AUTH_TOKEN = `${PREFS_PREFIX}.auth.token`;

export const DEFAULT_PORT = 23121;
export const DEFAULT_ENABLED = true;
export const DEFAULT_WRITE_ENABLED = false;
export const DEFAULT_SEMANTIC_ENABLED = false;
export const DEFAULT_SEMANTIC_AUTO_UPDATE = false;

export type PreferenceObserver = (name: string) => void;

export class ServerPreferences {
  private observers: PreferenceObserver[] = [];
  private observerIDs: symbol[] = [];

  constructor() {
    this.initializeDefaults();
    this.register();
  }

  /**
   * 初始化默认偏好设置（绝不复制旧插件或用户历史的配置与密钥）
   */
  private initializeDefaults(): void {
    try {
      // 端口初始化
      const currentPort = Zotero.Prefs.get(PREF_PORT, true);
      if (
        currentPort === undefined ||
        currentPort === null ||
        isNaN(Number(currentPort))
      ) {
        Zotero.Prefs.set(PREF_PORT, DEFAULT_PORT, true);
      }

      // 服务器启用状态初始化 (默认开启)
      const currentEnabled = Zotero.Prefs.get(PREF_ENABLED, true);
      if (currentEnabled === undefined || currentEnabled === null) {
        Zotero.Prefs.set(PREF_ENABLED, DEFAULT_ENABLED, true);
      }

      // 写入开关初始化 (默认安全只读 false)
      const currentWrite = Zotero.Prefs.get(PREF_WRITE_ENABLED, true);
      if (currentWrite === undefined || currentWrite === null) {
        Zotero.Prefs.set(PREF_WRITE_ENABLED, DEFAULT_WRITE_ENABLED, true);
      }

      // 语义搜索开关初始化 (默认 false)
      const currentSemantic = Zotero.Prefs.get(PREF_SEMANTIC_ENABLED, true);
      if (currentSemantic === undefined || currentSemantic === null) {
        Zotero.Prefs.set(PREF_SEMANTIC_ENABLED, DEFAULT_SEMANTIC_ENABLED, true);
      }

      // 语义自动更新开关初始化 (默认 false)
      const currentAutoUpdate = Zotero.Prefs.get(
        PREF_SEMANTIC_AUTO_UPDATE,
        true,
      );
      if (currentAutoUpdate === undefined || currentAutoUpdate === null) {
        Zotero.Prefs.set(
          PREF_SEMANTIC_AUTO_UPDATE,
          DEFAULT_SEMANTIC_AUTO_UPDATE,
          true,
        );
      }

      // Bearer Token 初始化：若尚未生成，则安全随机生成并保存
      this.ensureAuthToken();
    } catch (e) {
      if (typeof ztoolkit !== "undefined") {
        ztoolkit.log(`[ServerPreferences] 初始化默认设置异常: ${e}`, "warn");
      }
    }
  }

  /**
   * 确保存在有效的私有 Bearer Token
   */
  public ensureAuthToken(): string {
    let token = Zotero.Prefs.get(PREF_AUTH_TOKEN, true) as string | undefined;
    if (!token || typeof token !== "string" || token.trim().length === 0) {
      token = generateBearerToken();
      Zotero.Prefs.set(PREF_AUTH_TOKEN, token, true);
      if (typeof ztoolkit !== "undefined") {
        ztoolkit.log("[ServerPreferences] 已生成初始 Bearer 访问令牌");
      }
    }
    return token.trim();
  }

  /**
   * 获取当前有效 Bearer Token
   */
  public getAuthToken(): string {
    return this.ensureAuthToken();
  }

  /**
   * 轮换 Bearer Token 并发出偏好变更通知
   */
  public rotateAuthToken(): string {
    const newToken = generateBearerToken();
    Zotero.Prefs.set(PREF_AUTH_TOKEN, newToken, true);
    if (typeof ztoolkit !== "undefined") {
      ztoolkit.log("[ServerPreferences] Bearer 访问令牌已完成轮换");
    }
    return newToken;
  }

  /**
   * 获取监听端口
   */
  public getPort(): number {
    try {
      const port = Zotero.Prefs.get(PREF_PORT, true);
      if (port === undefined || port === null || isNaN(Number(port))) {
        return DEFAULT_PORT;
      }
      const num = Number(port);
      if (!Number.isInteger(num) || num < 1024 || num > 65535) {
        return DEFAULT_PORT;
      }
      return num;
    } catch {
      return DEFAULT_PORT;
    }
  }

  public setPort(port: number): void {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      throw new Error(`端口号必须在 1024 和 65535 之间: ${port}`);
    }
    Zotero.Prefs.set(PREF_PORT, port, true);
  }

  /**
   * 服务器是否启用
   */
  public isServerEnabled(): boolean {
    try {
      const enabled = Zotero.Prefs.get(PREF_ENABLED, true);
      if (enabled === undefined || enabled === null) {
        return DEFAULT_ENABLED;
      }
      return enabled === true;
    } catch {
      return DEFAULT_ENABLED;
    }
  }

  public setServerEnabled(enabled: boolean): void {
    Zotero.Prefs.set(PREF_ENABLED, Boolean(enabled), true);
  }

  /**
   * 文库写入开关是否启用 (统一写入安全策略)
   */
  public isWriteEnabled(): boolean {
    try {
      const val = Zotero.Prefs.get(PREF_WRITE_ENABLED, true);
      return val === true;
    } catch {
      return false;
    }
  }

  public setWriteEnabled(enabled: boolean): void {
    Zotero.Prefs.set(PREF_WRITE_ENABLED, Boolean(enabled), true);
  }

  /**
   * 语义搜索开关
   */
  public isSemanticEnabled(): boolean {
    try {
      const val = Zotero.Prefs.get(PREF_SEMANTIC_ENABLED, true);
      return val === true;
    } catch {
      return false;
    }
  }

  public setSemanticEnabled(enabled: boolean): void {
    Zotero.Prefs.set(PREF_SEMANTIC_ENABLED, Boolean(enabled), true);
  }

  /**
   * 语义自动更新开关
   */
  public isSemanticAutoUpdateEnabled(): boolean {
    try {
      const val = Zotero.Prefs.get(PREF_SEMANTIC_AUTO_UPDATE, true);
      return val === true;
    } catch {
      return false;
    }
  }

  public setSemanticAutoUpdateEnabled(enabled: boolean): void {
    Zotero.Prefs.set(PREF_SEMANTIC_AUTO_UPDATE, Boolean(enabled), true);
  }

  public addObserver(observer: PreferenceObserver): void {
    this.observers.push(observer);
  }

  public removeObserver(observer: PreferenceObserver): void {
    const index = this.observers.indexOf(observer);
    if (index > -1) {
      this.observers.splice(index, 1);
    }
  }

  private notifyObservers(name: string): void {
    for (const observer of this.observers) {
      try {
        observer(name);
      } catch (e) {
        if (typeof ztoolkit !== "undefined") {
          ztoolkit.log(
            `[ServerPreferences] Observer 回调执行失败: ${e}`,
            "warn",
          );
        }
      }
    }
  }

  private register(): void {
    try {
      const watched = [
        PREF_ENABLED,
        PREF_AUTH_TOKEN,
        PREF_WRITE_ENABLED,
        PREF_PORT,
      ];
      for (const prefKey of watched) {
        const obsID = Zotero.Prefs.registerObserver(
          prefKey,
          () => this.notifyObservers(prefKey),
          true,
        );
        if (obsID) {
          this.observerIDs.push(obsID);
        }
      }
    } catch (error) {
      if (typeof ztoolkit !== "undefined") {
        ztoolkit.log(
          `[ServerPreferences] 偏好观察者注册失败: ${error}`,
          "warn",
        );
      }
    }
  }

  public unregister(): void {
    for (const obsID of this.observerIDs) {
      try {
        Zotero.Prefs.unregisterObserver(obsID);
      } catch {
        // 忽略注销异常
      }
    }
    this.observerIDs = [];
    this.observers = [];
  }
}

export const serverPreferences = new ServerPreferences();
