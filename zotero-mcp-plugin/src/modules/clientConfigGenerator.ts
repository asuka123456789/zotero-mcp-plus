/**
 * Zotero MCP Plus - 客户端配置生成器
 *
 * 为各大 AI 客户端生成携带 Bearer 认证 Token 与标准回环端点的 MCP 配置与指南。
 */

import { getString } from "../utils/locale";
import { serverPreferences } from "./serverPreferences";
import { PLUS_PROTOCOL_VERSION } from "./httpSecurity";

declare let ztoolkit: ZToolkit;

export interface ClientConfig {
  name: string;
  displayName: string;
  description: string;
  configTemplate: (port: number, serverName?: string, token?: string) => any;
  renderConfig?: (port: number, serverName?: string, token?: string) => string;
  configLanguage?: string;
  getInstructions?: (
    port?: number,
    serverName?: string,
    token?: string,
  ) => string[];
}

export class ClientConfigGenerator {
  public static readonly DEFAULT_SERVER_NAME = "zotero-plus";
  public static readonly DEFAULT_PORT = 23121;

  private static readonly CLIENT_CONFIGS: ClientConfig[] = [
    {
      name: "claude-code",
      displayName: "Claude Code",
      description: "Anthropic's Claude Code CLI 工具",
      configTemplate: (
        port: number,
        serverName = ClientConfigGenerator.DEFAULT_SERVER_NAME,
        token?: string,
      ) => {
        const authToken = token || serverPreferences.getAuthToken();
        return {
          type: "http",
          url: `http://127.0.0.1:${port}/mcp`,
          headers: {
            Authorization: `Bearer ${authToken}`,
          },
        };
      },
      renderConfig: (
        port: number,
        serverName = ClientConfigGenerator.DEFAULT_SERVER_NAME,
        token?: string,
      ) => {
        const authToken = token || serverPreferences.getAuthToken();
        return `claude mcp add --transport http --header "Authorization: Bearer ${authToken}" ${serverName} http://127.0.0.1:${port}/mcp`;
      },
      configLanguage: "bash",
      getInstructions: (
        port = ClientConfigGenerator.DEFAULT_PORT,
        serverName = ClientConfigGenerator.DEFAULT_SERVER_NAME,
        token?: string,
      ) => {
        const authToken = token || serverPreferences.getAuthToken();
        return [
          "══════════════════════════════════════════════════════════",
          "  Claude Code MCP 配置指南",
          "══════════════════════════════════════════════════════════",
          "",
          "▶ 添加服务器（复制上方命令执行即可）",
          "──────────────────────────────────────────────────────────",
          `   claude mcp add --transport http --header "Authorization: Bearer ${authToken}" ${serverName} http://127.0.0.1:${port}/mcp`,
          "",
          "   如需全局可用（所有项目）:",
          `   claude mcp add --transport http --scope user --header "Authorization: Bearer ${authToken}" ${serverName} http://127.0.0.1:${port}/mcp`,
          "",
          "▶ 管理命令",
          "──────────────────────────────────────────────────────────",
          "   查看已添加:   claude mcp list",
          `   查看详情:     claude mcp get ${serverName}`,
          `   移除服务器:   claude mcp remove ${serverName}`,
          "   检查状态:     /mcp (在 Claude Code 会话中)",
          "",
          "▶ 作用域说明",
          "──────────────────────────────────────────────────────────",
          "   --scope local    仅当前项目（默认）",
          "   --scope project  通过 .mcp.json 共享给项目成员",
          "   --scope user     所有项目全局可用",
          "",
          "▶ 前提条件",
          "──────────────────────────────────────────────────────────",
          "   ✓ Zotero 必须正在运行且 MCP Plus 插件服务已启用",
          "   ✓ 请求已自动包含 Bearer Token 认证",
          "   ✓ 保存后通过 /mcp 重新加载连接；未发现新入口时重启会话",
          "",
          "══════════════════════════════════════════════════════════",
        ];
      },
    },
    {
      name: "codex",
      displayName: "Codex CLI",
      description: "OpenAI Codex 命令行界面",
      configTemplate: (
        port: number,
        serverName = ClientConfigGenerator.DEFAULT_SERVER_NAME,
        token?: string,
      ) => {
        const authToken = token || serverPreferences.getAuthToken();
        return {
          mcp_servers: {
            [serverName]: {
              type: "http",
              url: `http://127.0.0.1:${port}/mcp`,
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${authToken}`,
              },
            },
          },
        };
      },
      renderConfig: (
        port: number,
        serverName = ClientConfigGenerator.DEFAULT_SERVER_NAME,
        token?: string,
      ) => {
        const authToken = token || serverPreferences.getAuthToken();
        const safeServerName =
          ClientConfigGenerator.escapeTomlBasicString(serverName);
        return `[mcp_servers."${safeServerName}"]
type = "http"
url = "http://127.0.0.1:${port}/mcp"

[mcp_servers."${safeServerName}".headers]
"Content-Type" = "application/json"
"Authorization" = "Bearer ${authToken}"`;
      },
      configLanguage: "toml",
      getInstructions: (
        port = ClientConfigGenerator.DEFAULT_PORT,
        serverName = ClientConfigGenerator.DEFAULT_SERVER_NAME,
        token?: string,
      ) => {
        const authToken = token || serverPreferences.getAuthToken();
        return [
          "══════════════════════════════════════════════════════════",
          "  Codex CLI MCP 配置指南",
          "══════════════════════════════════════════════════════════",
          "",
          "▶ 方法 1：CLI 命令",
          "──────────────────────────────────────────────────────────",
          `   codex mcp add ${serverName} http://127.0.0.1:${port}/mcp -t http -H "Authorization: Bearer ${authToken}"`,
          "",
          "▶ 方法 2：TOML 配置文件",
          "──────────────────────────────────────────────────────────",
          "   1. 打开 ~/.codex/config.toml",
          "   2. 将生成的 TOML 片段追加至 [mcp_servers] 节",
          "   3. 保存后重启 Codex 会话",
          "",
          "══════════════════════════════════════════════════════════",
        ];
      },
    },
    {
      name: "claude-desktop",
      displayName: "Claude Desktop",
      description: "Anthropic Claude 桌面客户端",
      configTemplate: (
        port: number,
        serverName = ClientConfigGenerator.DEFAULT_SERVER_NAME,
        token?: string,
      ) => {
        const authToken = token || serverPreferences.getAuthToken();
        return {
          mcpServers: {
            [serverName]: {
              command: "npx",
              args: [
                "mcp-remote",
                `http://127.0.0.1:${port}/mcp`,
                "--header",
                `Authorization: Bearer ${authToken}`,
              ],
              env: {},
            },
          },
        };
      },
      getInstructions: () =>
        getString("claude-desktop-instructions")
          .split("\n")
          .filter((s) => s.trim()),
    },
    {
      name: "cline-vscode",
      displayName: "Cline (VS Code)",
      description: "Cline VS Code 插件",
      configTemplate: (
        port: number,
        serverName = ClientConfigGenerator.DEFAULT_SERVER_NAME,
        token?: string,
      ) => {
        const authToken = token || serverPreferences.getAuthToken();
        return {
          mcpServers: {
            [serverName]: {
              command: "npx",
              args: [
                "mcp-remote",
                `http://127.0.0.1:${port}/mcp`,
                "--header",
                `Authorization: Bearer ${authToken}`,
              ],
              env: {},
              alwaysAllow: ["*"],
              disabled: false,
            },
          },
        };
      },
      getInstructions: () =>
        getString("cline-vscode-instructions")
          .split("\n")
          .filter((s) => s.trim()),
    },
    {
      name: "continue-dev",
      displayName: "Continue.dev",
      description: "Continue 编码助手",
      configTemplate: (
        port: number,
        serverName = ClientConfigGenerator.DEFAULT_SERVER_NAME,
        token?: string,
      ) => {
        const authToken = token || serverPreferences.getAuthToken();
        return {
          experimental: {
            modelContextProtocolServers: [
              {
                name: serverName,
                transport: {
                  type: "stdio",
                  command: "npx",
                  args: [
                    "mcp-remote",
                    `http://127.0.0.1:${port}/mcp`,
                    "--header",
                    `Authorization: Bearer ${authToken}`,
                  ],
                },
              },
            ],
          },
        };
      },
      getInstructions: () =>
        getString("continue-dev-instructions")
          .split("\n")
          .filter((s) => s.trim()),
    },
    {
      name: "cursor",
      displayName: "Cursor",
      description: "Cursor AI 编辑器",
      configTemplate: (
        port: number,
        serverName = ClientConfigGenerator.DEFAULT_SERVER_NAME,
        token?: string,
      ) => {
        const authToken = token || serverPreferences.getAuthToken();
        return {
          mcpServers: {
            [serverName]: {
              command: "npx",
              args: [
                "mcp-remote",
                `http://127.0.0.1:${port}/mcp`,
                "--header",
                `Authorization: Bearer ${authToken}`,
              ],
              env: {},
            },
          },
        };
      },
      getInstructions: () =>
        getString("cursor-instructions")
          .split("\n")
          .filter((s) => s.trim()),
    },
    {
      name: "cherry-studio",
      displayName: "Cherry Studio",
      description: "Cherry Studio 桌面应用",
      configTemplate: (
        port: number,
        serverName = ClientConfigGenerator.DEFAULT_SERVER_NAME,
        token?: string,
      ) => {
        const authToken = token || serverPreferences.getAuthToken();
        return {
          mcpServers: {
            [serverName]: {
              type: "streamableHttp",
              url: `http://127.0.0.1:${port}/mcp`,
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${authToken}`,
              },
            },
          },
        };
      },
      getInstructions: () =>
        getString("cherry-studio-instructions")
          .split("\n")
          .filter((s) => s.trim()),
    },
    {
      name: "gemini-cli",
      displayName: "Gemini CLI",
      description: "Google Gemini 命令行界面",
      configTemplate: (
        port: number,
        serverName = ClientConfigGenerator.DEFAULT_SERVER_NAME,
        token?: string,
      ) => {
        const authToken = token || serverPreferences.getAuthToken();
        return {
          mcpServers: {
            [serverName]: {
              httpUrl: `http://127.0.0.1:${port}/mcp`,
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${authToken}`,
              },
              timeout: 60000,
              trust: true,
            },
          },
        };
      },
      getInstructions: () =>
        getString("gemini-cli-instructions")
          .split("\n")
          .filter((s) => s.trim()),
    },
    {
      name: "chatbox",
      displayName: "Chatbox",
      description: "Chatbox 客户端",
      configTemplate: (
        port: number,
        serverName = ClientConfigGenerator.DEFAULT_SERVER_NAME,
        token?: string,
      ) => {
        const authToken = token || serverPreferences.getAuthToken();
        return {
          mcpServers: {
            [serverName]: {
              url: `http://127.0.0.1:${port}/mcp`,
              headers: {
                Authorization: `Bearer ${authToken}`,
              },
            },
          },
        };
      },
      getInstructions: () =>
        getString("chatbox-instructions")
          .split("\n")
          .filter((s) => s.trim()),
    },
    {
      name: "workbuddy",
      displayName: "WorkBuddy",
      description: "WorkBuddy 桌面助手",
      configTemplate: (
        port: number,
        serverName = ClientConfigGenerator.DEFAULT_SERVER_NAME,
        token?: string,
      ) => {
        const authToken = token || serverPreferences.getAuthToken();
        return {
          mcpServers: {
            [serverName]: {
              command: "npx",
              args: [
                "mcp-remote",
                `http://127.0.0.1:${port}/mcp`,
                "--header",
                `Authorization: Bearer ${authToken}`,
              ],
              env: {},
            },
          },
        };
      },
      getInstructions: () =>
        getString("workbuddy-instructions")
          .split("\n")
          .filter((s) => s.trim()),
    },
    {
      name: "trae-ai",
      displayName: "Trae AI",
      description: "Trae 编程助手",
      configTemplate: (
        port: number,
        serverName = ClientConfigGenerator.DEFAULT_SERVER_NAME,
        token?: string,
      ) => {
        const authToken = token || serverPreferences.getAuthToken();
        return {
          mcpServers: {
            [serverName]: {
              command: "npx",
              args: [
                "mcp-remote",
                `http://127.0.0.1:${port}/mcp`,
                "--header",
                `Authorization: Bearer ${authToken}`,
              ],
              env: {},
            },
          },
        };
      },
      getInstructions: () =>
        getString("trae-ai-instructions")
          .split("\n")
          .filter((s) => s.trim()),
    },
    {
      name: "qwen-code",
      displayName: "Qwen Code",
      description: "千问代码助手 CLI",
      configTemplate: (
        port: number,
        serverName = ClientConfigGenerator.DEFAULT_SERVER_NAME,
        token?: string,
      ) => {
        const authToken = token || serverPreferences.getAuthToken();
        return {
          mcpServers: {
            [serverName]: {
              command: "npx",
              args: [
                "mcp-remote",
                `http://127.0.0.1:${port}/mcp`,
                "--header",
                `Authorization: Bearer ${authToken}`,
              ],
              env: {},
            },
          },
        };
      },
      getInstructions: (
        port = ClientConfigGenerator.DEFAULT_PORT,
        serverName = ClientConfigGenerator.DEFAULT_SERVER_NAME,
        token?: string,
      ) => {
        const authToken = token || serverPreferences.getAuthToken();
        return [
          "1. 使用 Qwen Code 的 mcp add 命令:",
          `   qwen mcp add ${serverName} http://127.0.0.1:${port}/mcp -t http -H "Authorization: Bearer ${authToken}"`,
          "",
          "2. 验证服务器添加状态:",
          "   qwen mcp list",
          "",
          "3. 检查 Zotero 正在运行且 MCP Plus 插件已启用",
        ];
      },
    },
    {
      name: "custom-http",
      displayName: "自定义 HTTP 客户端",
      description: "标准 Streamable HTTP MCP 客户端配置",
      configTemplate: (
        port: number,
        serverName = ClientConfigGenerator.DEFAULT_SERVER_NAME,
        token?: string,
      ) => {
        const authToken = token || serverPreferences.getAuthToken();
        return {
          name: serverName,
          description:
            "Zotero MCP Plus - Research management and citation tools",
          transport: {
            type: "http",
            endpoint: `http://127.0.0.1:${port}/mcp`,
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${authToken}`,
              "MCP-Protocol-Version": PLUS_PROTOCOL_VERSION,
            },
          },
          capabilities: {
            tools: true,
            resources: false,
            prompts: false,
          },
          connectionTest: `curl -X POST http://127.0.0.1:${port}/mcp -H "Content-Type: application/json" -H "Authorization: Bearer ${authToken}" -H "MCP-Protocol-Version: ${PLUS_PROTOCOL_VERSION}" -d '{"jsonrpc":"2.0","id":1,"method":"ping","params":{}}'`,
        };
      },
      getInstructions: () =>
        getString("custom-http-instructions")
          .split("\n")
          .filter((s) => s.trim()),
    },
  ];

  static getAvailableClients(): ClientConfig[] {
    return this.CLIENT_CONFIGS;
  }

  static generateConfig(
    clientName: string,
    port: number,
    serverName?: string,
    token?: string,
  ): string {
    const client = this.CLIENT_CONFIGS.find((c) => c.name === clientName);
    if (!client) {
      throw new Error(`不支持的客户端类型: ${clientName}`);
    }

    const effectiveName = serverName || this.DEFAULT_SERVER_NAME;
    const effectiveToken = token || serverPreferences.getAuthToken();

    if (client.renderConfig) {
      return client.renderConfig(port, effectiveName, effectiveToken);
    }

    const config = client.configTemplate(port, effectiveName, effectiveToken);
    return JSON.stringify(config, null, 2);
  }

  static getInstructions(
    clientName: string,
    port?: number,
    serverName?: string,
    token?: string,
  ): string[] {
    const client = this.CLIENT_CONFIGS.find((c) => c.name === clientName);
    const effectiveName = serverName || this.DEFAULT_SERVER_NAME;
    const effectiveToken = token || serverPreferences.getAuthToken();
    return client?.getInstructions?.(port, effectiveName, effectiveToken) || [];
  }

  static generateFullGuide(
    clientName: string,
    port: number,
    serverName?: string,
    token?: string,
  ): string {
    const client = this.CLIENT_CONFIGS.find((c) => c.name === clientName);
    if (!client) {
      throw new Error(`不支持的客户端类型: ${clientName}`);
    }

    const effectiveName = serverName || this.DEFAULT_SERVER_NAME;
    const effectiveToken = token || serverPreferences.getAuthToken();
    const config = this.generateConfig(
      clientName,
      port,
      effectiveName,
      effectiveToken,
    );
    const instructions = this.getInstructions(
      clientName,
      port,
      effectiveName,
      effectiveToken,
    );
    const codeLanguage = client.configLanguage || "json";

    return `# ${client.displayName} MCP 配置指南

## 服务器信息
- **服务名称**: ${effectiveName}
- **监听端口**: ${port}
- **HTTP 端点**: http://127.0.0.1:${port}/mcp
- **协议版本**: ${PLUS_PROTOCOL_VERSION}
- **安全认证**: Bearer Token (已嵌入下方配置)

## 配置片段
\`\`\`${codeLanguage}
${config}
\`\`\`

## 配置步骤
${instructions.join("\n")}

## 故障排除
1. 确保 Zotero 正在运行且 MCP Plus 插件处于启用状态
2. 确保请求携带了正确的 Authorization: Bearer <token> 请求头
3. 确保客户端向 127.0.0.1:${port}/mcp 发起 POST 请求
4. 若轮换了 Token，需在客户端中同步更新配置
`;
  }

  private static escapeTomlBasicString(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  static async copyToClipboard(text: string): Promise<boolean> {
    try {
      if (
        typeof Zotero !== "undefined" &&
        Zotero.Utilities &&
        Zotero.Utilities.Internal &&
        Zotero.Utilities.Internal.copyTextToClipboard
      ) {
        Zotero.Utilities.Internal.copyTextToClipboard(text);
        return true;
      }

      const globalNav = (globalThis as any).navigator;
      if (globalNav && globalNav.clipboard) {
        await globalNav.clipboard.writeText(text);
        return true;
      }

      if (typeof ztoolkit !== "undefined" && ztoolkit.getGlobal) {
        const globalWindow = ztoolkit.getGlobal("window");
        if (globalWindow && globalWindow.document) {
          const textArea = globalWindow.document.createElement("textarea");
          textArea.value = text;
          textArea.style.position = "fixed";
          textArea.style.left = "-999999px";
          textArea.style.top = "-999999px";
          globalWindow.document.body.appendChild(textArea);
          textArea.focus();
          textArea.select();
          const result = globalWindow.document.execCommand("copy");
          globalWindow.document.body.removeChild(textArea);
          return result;
        }
      }

      return false;
    } catch (error) {
      if (typeof ztoolkit !== "undefined") {
        ztoolkit.log(
          `[ClientConfigGenerator] 复制到剪贴板失败: ${error}`,
          "error",
        );
      }
      return false;
    }
  }
}
