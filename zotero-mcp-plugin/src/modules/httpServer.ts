import { StreamableMCPServer } from "./streamableMCPServer";
import { serverPreferences } from "./serverPreferences";
import {
  readHttpRequest,
  getByteLength,
  type ByteReader,
} from "./httpRequestReader";
import {
  verifyHttpRequestSecurity,
  PLUS_PROTOCOL_VERSION,
} from "./httpSecurity";

declare let ztoolkit: ZToolkit;

/**
 * 使用 UTF-8 编码将字符串写入 Gecko 输出流
 */
function writeStringToStream(output: any, str: string): void {
  const converterStream = Cc[
    "@mozilla.org/intl/converter-output-stream;1"
  ].createInstance(Ci.nsIConverterOutputStream);
  (converterStream as any).init(output, "UTF-8", 0, 0);
  converterStream.writeString(str);
  converterStream.flush();
}

export class HttpServer {
  public static testServer() {
    Zotero.debug("[HttpServer] Static testServer method called.");
  }

  private serverSocket: any;
  private isRunning: boolean = false;
  private mcpServer: StreamableMCPServer | null = null;
  private port: number = 23121;
  // 跟踪活动连接以便安全退出时关闭
  private activeTransports: Set<any> = new Set();

  public isServerRunning(): boolean {
    return this.isRunning;
  }

  public start(port: number) {
    if (this.isRunning) {
      ztoolkit.log("[HttpServer] 服务器已在运行，跳过重复启动");
      return;
    }

    if (!port || isNaN(port) || port < 1024 || port > 65535) {
      const errorMsg = `[HttpServer] 非法端口号: ${port}。端口号必须在 1024 到 65535 之间。`;
      ztoolkit.log(errorMsg, "error");
      throw new Error(errorMsg);
    }

    try {
      this.port = port;
      ztoolkit.log(
        `[HttpServer] 正在回环地址 127.0.0.1:${port} 启动 HTTP 服务...`,
      );

      this.serverSocket = Cc[
        "@mozilla.org/network/server-socket;1"
      ].createInstance(Ci.nsIServerSocket);

      // 固定仅允许回环 loopbackOnly = true (只监听 127.0.0.1)
      this.serverSocket.init(port, true, -1);
      this.serverSocket.asyncListen(this.listener);
      this.isRunning = true;

      ztoolkit.log(`[HttpServer] 成功在 127.0.0.1:${port} 启动 HTTP 服务`);

      // 初始化集成 MCP 服务
      this.initializeMCPServer();
    } catch (e) {
      const errorMsg = `[HttpServer] 启动 HTTP 服务失败 (端口 ${port}): ${e}`;
      ztoolkit.log(errorMsg, "error");
      this.stop();
      throw new Error(errorMsg);
    }
  }

  private initializeMCPServer(): void {
    try {
      this.mcpServer = new StreamableMCPServer();
      ztoolkit.log("[HttpServer] 集成 MCP 服务器实例已初始化");
    } catch (error) {
      ztoolkit.log(`[HttpServer] 初始化 MCP 服务失败: ${error}`, "error");
    }
  }

  public stop() {
    ztoolkit.log(`[HttpServer] 正在停止服务 (当前运行状态: ${this.isRunning})`);

    if (!this.isRunning || !this.serverSocket) {
      return;
    }

    // 关闭所有活动传输连接
    for (const transport of this.activeTransports) {
      try {
        transport.close(0);
      } catch {
        // 忽略单个连接关闭异常
      }
    }
    this.activeTransports.clear();

    // 关闭服务端 Socket
    try {
      this.serverSocket.close();
      this.isRunning = false;
      ztoolkit.log("[HttpServer] 服务端 Socket 已成功关闭");
    } catch (e) {
      ztoolkit.log(`[HttpServer] 关闭服务端 Socket 异常: ${e}`, "error");
      this.isRunning = false;
    }

    this.cleanupMCPServer();
    ztoolkit.log("[HttpServer] HTTP 服务已完全停止");
  }

  private cleanupMCPServer(): void {
    if (this.mcpServer) {
      this.mcpServer = null;
      ztoolkit.log("[HttpServer] MCP 服务资源已释放");
    }
  }

  /**
   * 构造标准 HTTP 响应头
   */
  private buildHttpHeaders(
    result: {
      status: number;
      statusText: string;
      headers?: Record<string, string>;
    },
    bodyByteLength: number,
  ): string {
    const status = result.status || 200;
    const statusText = result.statusText || "OK";
    const contentType =
      result.headers?.["Content-Type"] || "application/json; charset=utf-8";

    let headers =
      `HTTP/1.1 ${status} ${statusText}\r\n` +
      `Content-Type: ${contentType}\r\n` +
      `MCP-Protocol-Version: ${PLUS_PROTOCOL_VERSION}\r\n` +
      `Connection: close\r\n` +
      `Content-Length: ${bodyByteLength}\r\n`;

    if (result.headers) {
      for (const [key, value] of Object.entries(result.headers)) {
        const lower = key.toLowerCase();
        if (
          lower !== "content-type" &&
          lower !== "content-length" &&
          lower !== "connection" &&
          lower !== "mcp-protocol-version"
        ) {
          headers += `${key}: ${value}\r\n`;
        }
      }
    }

    headers += "\r\n";
    return headers;
  }

  private listener = {
    onSocketAccepted: async (_socket: any, transport: any) => {
      let input: any = null;
      let output: any = null;
      let binaryStream: any = null;

      this.activeTransports.add(transport);

      try {
        input = transport.openInputStream(0, 0, 0);
        output = transport.openOutputStream(0, 0, 0);

        binaryStream = Cc["@mozilla.org/binaryinputstream;1"].createInstance(
          Ci.nsIBinaryInputStream,
        );
        binaryStream.setInputStream(input);

        const reader: ByteReader = {
          available: () => input.available(),
          readBytes: (count: number) =>
            Uint8Array.from(binaryStream.readByteArray(count)),
        };

        const read = await readHttpRequest(reader, {
          maxRequestSize: 1024 * 1024,
        });

        const headerText = read.headerText;
        const contentLength = read.contentLength;
        const totalBytesRead = read.totalBytesRead;

        // 空连接探针处理
        if (totalBytesRead === 0 && headerText.length === 0) {
          return;
        }

        // 请求正文截断检查
        if (!read.complete && read.incompleteReason === "body-truncated") {
          ztoolkit.log(
            "[HttpServer] 请求正文未完整接收，返回 400 Bad Request",
            "warn",
          );
          const errorBody = JSON.stringify({
            error: "Incomplete request body",
          });
          const byteLen = getByteLength(errorBody);
          const head = this.buildHttpHeaders(
            { status: 400, statusText: "Bad Request" },
            byteLen,
          );
          output.write(head, head.length);
          writeStringToStream(output, errorBody);
          output.flush();
          return;
        }

        // 安全与认证统一校验管道
        const requestBody = read.body || "";
        const sec = verifyHttpRequestSecurity(
          headerText,
          requestBody,
          this.port,
          serverPreferences.getAuthToken(),
        );

        if (!sec.valid) {
          ztoolkit.log(
            `[HttpServer] 安全校验拦截: ${sec.statusCode} - ${sec.error}`,
            "warn",
          );
          const status = sec.statusCode || 400;
          const statusText = sec.statusText || "Bad Request";
          const errorBody = JSON.stringify({ error: sec.error });
          const byteLen = getByteLength(errorBody);
          const extraHeaders: Record<string, string> = {};
          if (status === 401) {
            extraHeaders["WWW-Authenticate"] = 'Bearer error="invalid_token"';
          }
          const headersStr = this.buildHttpHeaders(
            { status, statusText, headers: extraHeaders },
            byteLen,
          );
          output.write(headersStr, headersStr.length);
          writeStringToStream(output, errorBody);
          output.flush();
          return;
        }

        const method = sec.parsed!.method;
        const fullUrlPath = sec.parsed!.urlPath;
        const path = fullUrlPath.split("?")[0];

        let result: {
          status: number;
          statusText: string;
          headers?: Record<string, string>;
          body?: string;
        };

        if (path === "/mcp") {
          if (method === "POST") {
            if (this.mcpServer) {
              result = await this.mcpServer.handleMCPRequest(requestBody);
            } else {
              result = {
                status: 503,
                statusText: "Service Unavailable",
                headers: { "Content-Type": "application/json; charset=utf-8" },
                body: JSON.stringify({ error: "MCP 服务器尚未就绪" }),
              };
            }
          } else if (method === "GET") {
            // GET /mcp 明确返回 405
            result = {
              status: 405,
              statusText: "Method Not Allowed",
              headers: {
                "Content-Type": "application/json; charset=utf-8",
                Allow: "POST",
              },
              body: JSON.stringify({
                error: "Method Not Allowed. /mcp 端点仅支持 POST 方法",
              }),
            };
          } else {
            result = {
              status: 405,
              statusText: "Method Not Allowed",
              headers: {
                "Content-Type": "application/json; charset=utf-8",
                Allow: "POST",
              },
              body: JSON.stringify({
                error: `Method ${method} Not Allowed. 仅支持 POST 方法`,
              }),
            };
          }
        } else if (
          method === "POST" ||
          method === "PUT" ||
          method === "PATCH" ||
          method === "DELETE"
        ) {
          // 彻底阻断任何通过旧 REST 路线 (如 /collections, /items 等) 绕过 Plus dryRun/confirmation 的写操作
          result = {
            status: 405,
            statusText: "Method Not Allowed",
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              Allow: "GET",
            },
            body: JSON.stringify({
              error: `Method ${method} Not Allowed. 任何直接 REST 写操作均已被禁用。所有文库变更必须通过 /mcp 经由 Plus 逐次确认机制 (dryRun/confirmation) 执行。`,
            }),
          };
        } else if (path === "/mcp/status") {
          if (method !== "GET") {
            result = {
              status: 405,
              statusText: "Method Not Allowed",
              headers: { Allow: "GET" },
              body: JSON.stringify({ error: "仅支持 GET 方法" }),
            };
          } else if (this.mcpServer) {
            result = {
              status: 200,
              statusText: "OK",
              headers: { "Content-Type": "application/json; charset=utf-8" },
              body: JSON.stringify(this.mcpServer.getStatus()),
            };
          } else {
            result = {
              status: 503,
              statusText: "Service Unavailable",
              headers: { "Content-Type": "application/json; charset=utf-8" },
              body: JSON.stringify({ error: "MCP 服务未启用", enabled: false }),
            };
          }
        } else if (
          path === "/mcp/capabilities" ||
          path === "/capabilities" ||
          path === "/help"
        ) {
          result = {
            status: 200,
            statusText: "OK",
            headers: { "Content-Type": "application/json; charset=utf-8" },
            body: JSON.stringify(this.getCapabilities()),
          };
        } else if (path === "/ping") {
          const pingBody = "pong";
          const pingBytes = getByteLength(pingBody);
          const pingHeaders = this.buildHttpHeaders(
            {
              status: 200,
              statusText: "OK",
              headers: { "Content-Type": "text/plain; charset=utf-8" },
            },
            pingBytes,
          );
          output.write(pingHeaders, pingHeaders.length);
          writeStringToStream(output, pingBody);
          output.flush();
          return;
        } else {
          result = {
            status: 404,
            statusText: "Not Found",
            headers: { "Content-Type": "application/json; charset=utf-8" },
            body: JSON.stringify({ error: "Not Found" }),
          };
        }

        const responseBody = result.body || "";
        const byteLength = getByteLength(responseBody);
        const finalHeaders = this.buildHttpHeaders(result, byteLength);

        // 仅记录方法、路径、状态码和字节长度，绝不记录 header/body/token/文献全文
        ztoolkit.log(
          `[HttpServer] ${method} ${path} -> ${result.status} (${byteLength} bytes)`,
        );

        output.write(finalHeaders, finalHeaders.length);
        if (byteLength > 0) {
          writeStringToStream(output, responseBody);
        }

        try {
          output.flush();
        } catch {
          // 部分流不支持 flush，忽略
        }
      } catch (e) {
        const error = e instanceof Error ? e : new Error(String(e));
        ztoolkit.log(`[HttpServer] 请求处理异常: ${error.message}`, "error");

        try {
          if (!output) {
            output = transport.openOutputStream(0, 0, 0);
          }
          const errBody = JSON.stringify({ error: "Internal Server Error" });
          const errBytes = getByteLength(errBody);
          const errHeaders = this.buildHttpHeaders(
            { status: 500, statusText: "Internal Server Error" },
            errBytes,
          );
          output.write(errHeaders, errHeaders.length);
          writeStringToStream(output, errBody);
        } catch {
          // 忽略二次异常
        }
      } finally {
        this.activeTransports.delete(transport);

        try {
          if (output) output.close();
        } catch {
          // 忽略关闭异常
        }

        try {
          if (input) input.close();
        } catch {
          // 忽略关闭异常
        }
      }
    },
    onStopListening: (_socket: any, status: any) => {
      ztoolkit.log(`[HttpServer] Socket 停止监听，状态: ${status}`);
      this.isRunning = false;
    },
  };

  /**
   * 动态获取能力信息 (基于 getStatus 和 listTools，不硬编码庞大静态文档)
   */
  private getCapabilities() {
    const status = this.mcpServer
      ? this.mcpServer.getStatus()
      : { enabled: false };
    const tools =
      this.mcpServer && typeof (this.mcpServer as any).listTools === "function"
        ? (this.mcpServer as any).listTools()
        : (status as any).availableTools || [];

    return {
      serverInfo: {
        name: "Zotero MCP Plus",
        version: "0.1.0",
        protocolVersion: PLUS_PROTOCOL_VERSION,
        endpoint: "/mcp",
      },
      status,
      tools,
      timestamp: new Date().toISOString(),
    };
  }
}

export const httpServer = new HttpServer();
