/**
 * Zotero MCP Plus - HTTP 安全校验模块
 *
 * 负责 HTTP 请求的主机名、端口、来源 (Origin)、转发伪装、敏感重复头、
 * Bearer 访问令牌认证以及 MCP 协议版本协商与严格校验。
 */

import { PLUS_PROTOCOL_VERSION } from "./plusTypes.ts";

export { PLUS_PROTOCOL_VERSION };

/** 允许绑定的本地回环 Host 主机名列表 */
export const ALLOWED_LOOPBACK_HOSTS = new Set([
  "127.0.0.1",
  "localhost",
  "[::1]",
]);

/** 敏感请求头集合，严禁在同一请求中重复出现 */
export const SENSITIVE_HEADERS = new Set([
  "host",
  "authorization",
  "origin",
  "content-length",
  "content-type",
  "mcp-protocol-version",
]);

/** 禁止的代理转发头（防御转发伪装） */
export const FORWARDING_HEADERS = new Set([
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "forwarded",
  "x-real-ip",
]);

/**
 * 解析原始 HTTP 请求头文本为结构化数据
 */
export interface ParsedHttpRequest {
  rawRequestLine: string;
  method: string;
  urlPath: string;
  httpVersion: string;
  headers: Map<string, string[]>;
}

export function parseHttpRequestHeaders(headerText: string): ParsedHttpRequest {
  const lines = headerText.split(/\r?\n/);
  const rawRequestLine = lines[0] || "";
  const requestParts = rawRequestLine.trim().split(/\s+/);

  const method = requestParts[0] || "";
  const urlPath = requestParts[1] || "";
  const httpVersion = requestParts[2] || "";

  const headers = new Map<string, string[]>();
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const name = line.substring(0, colonIdx).trim().toLowerCase();
    const value = line.substring(colonIdx + 1).trim();
    const list = headers.get(name) || [];
    list.push(value);
    headers.set(name, list);
  }

  return {
    rawRequestLine,
    method,
    urlPath,
    httpVersion,
    headers,
  };
}

/**
 * 安全时间常数比较，防止时序侧信道攻击
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = new TextEncoder().encode(a);
  const bufB = new TextEncoder().encode(b);
  let diff = bufA.length ^ bufB.length;
  for (let i = 0; i < bufA.length; i++) {
    diff |= bufA[i] ^ (bufB[i % bufB.length] || 0);
  }
  return diff === 0;
}

/**
 * 生成安全的随机 32 字节 Bearer 访问令牌（64 位十六进制）
 */
export function generateBearerToken(): string {
  const cryptoObj =
    globalThis.crypto ??
    (typeof Zotero !== "undefined"
      ? Zotero.getMainWindow()?.crypto
      : undefined);
  if (!cryptoObj?.getRandomValues) {
    throw new Error(
      "当前运行环境缺少安全的随机数生成接口 (crypto.getRandomValues)",
    );
  }
  const bytes = new Uint8Array(32);
  cryptoObj.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 校验 Host 请求头（只允许 127.0.0.1/localhost/[::1] 且必须匹配当前实际监听端口）
 */
export function validateHost(
  hostHeader: string | undefined,
  expectedPort: number,
): { valid: boolean; error?: string } {
  if (!hostHeader || !hostHeader.trim()) {
    return { valid: false, error: "缺少必需的 Host 请求头" };
  }

  const host = hostHeader.trim();
  let hostname = "";
  let portStr = "";

  if (host.startsWith("[")) {
    const closeIdx = host.indexOf("]");
    if (closeIdx === -1) {
      return { valid: false, error: "Host 请求头 IPv6 格式非法" };
    }
    hostname = host.substring(0, closeIdx + 1);
    const rest = host.substring(closeIdx + 1);
    if (rest.startsWith(":")) {
      portStr = rest.substring(1);
    } else if (rest.length > 0) {
      return { valid: false, error: "Host 请求头格式非法" };
    }
  } else {
    const colonIdx = host.indexOf(":");
    if (colonIdx !== -1) {
      hostname = host.substring(0, colonIdx);
      portStr = host.substring(colonIdx + 1);
    } else {
      hostname = host;
    }
  }

  if (!ALLOWED_LOOPBACK_HOSTS.has(hostname.toLowerCase())) {
    return {
      valid: false,
      error: `非法的 Host 主机名: ${hostname}，仅允许 127.0.0.1、localhost 或 [::1]`,
    };
  }

  if (!portStr) {
    return {
      valid: false,
      error: `Host 请求头必须明确携带当前实际监听端口 :${expectedPort}`,
    };
  }

  const parsedPort = parseInt(portStr, 10);
  if (isNaN(parsedPort) || parsedPort !== expectedPort) {
    return {
      valid: false,
      error: `Host 端口不匹配: 期望 ${expectedPort}，实际收到 ${portStr}`,
    };
  }

  return { valid: true };
}

/**
 * 校验 Origin 请求头（无浏览器调用需求，拒绝所有 Origin 跨域请求）
 */
export function validateOrigin(originHeader: string | undefined): {
  valid: boolean;
  error?: string;
} {
  if (originHeader !== undefined && originHeader.trim().length > 0) {
    return {
      valid: false,
      error: "安全策略限制：拒绝所有带有 Origin 的浏览器跨域请求",
    };
  }
  return { valid: true };
}

/**
 * 校验是否存在转发头伪装（防御外部反向代理伪装）
 */
export function validateForwardingHeaders(headers: Map<string, string[]>): {
  valid: boolean;
  error?: string;
} {
  for (const name of FORWARDING_HEADERS) {
    if (headers.has(name)) {
      return { valid: false, error: `检测到禁止的代理转发请求头: ${name}` };
    }
  }
  return { valid: true };
}

/**
 * 校验敏感请求头是否存在重复定义
 */
export function validateDuplicateSensitiveHeaders(
  headers: Map<string, string[]>,
): { valid: boolean; error?: string } {
  for (const name of SENSITIVE_HEADERS) {
    const values = headers.get(name);
    if (values && values.length > 1) {
      return { valid: false, error: `检测到重复的敏感请求头: ${name}` };
    }
  }
  return { valid: true };
}

/**
 * 校验 Bearer 访问令牌认证
 */
export function validateBearerToken(
  authHeader: string | undefined,
  expectedToken: string,
): { valid: boolean; statusCode: number; error?: string } {
  if (!authHeader || !authHeader.trim()) {
    return {
      valid: false,
      statusCode: 401,
      error: "缺少 Authorization 请求头",
    };
  }

  const trimmed = authHeader.trim();
  if (!trimmed.toLowerCase().startsWith("bearer ")) {
    return {
      valid: false,
      statusCode: 401,
      error: "Authorization 格式错误，必须为 Bearer <token>",
    };
  }

  const token = trimmed.substring(7).trim();
  if (!token) {
    return { valid: false, statusCode: 401, error: "Bearer 令牌不能为空" };
  }

  if (!expectedToken || !constantTimeEqual(token, expectedToken)) {
    return { valid: false, statusCode: 401, error: "Bearer 令牌无效或已过期" };
  }

  return { valid: true, statusCode: 200 };
}

/**
 * 判断请求是否为 MCP initialize 初始化调用
 */
export function isInitializeRequest(body: string): boolean {
  if (!body || !body.trim()) return false;
  try {
    const parsed = JSON.parse(body);
    return Boolean(
      parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        parsed.method === "initialize",
    );
  } catch {
    return false;
  }
}

/**
 * 校验 MCP 协议版本 (MCP-Protocol-Version)
 *
 * 策略说明：
 * 1. 若客户端显式携带 MCP-Protocol-Version，则必须严格等于 "2025-11-25"，否则拒绝；
 * 2. 若客户端未携带 MCP-Protocol-Version：
 *    - 若为 initialize 请求，按规范允许缺省，响应中协商并返回 2025-11-25；
 *    - 若为后续其他 MCP 请求（非 initialize），必须携带协议版本头，缺失则予以拒绝 (400)。
 */
export function validateMcpProtocolVersion(
  versionHeader: string | undefined,
  body: string,
): { valid: boolean; error?: string } {
  if (versionHeader !== undefined && versionHeader.trim().length > 0) {
    const v = versionHeader.trim();
    if (v !== PLUS_PROTOCOL_VERSION) {
      return {
        valid: false,
        error: `不支持的 MCP-Protocol-Version: ${v}，当前仅支持 ${PLUS_PROTOCOL_VERSION}`,
      };
    }
    return { valid: true };
  }

  // 缺失协议版本头时：仅在 initialize 请求时允许按规范协商
  if (isInitializeRequest(body)) {
    return { valid: true };
  }

  return {
    valid: false,
    error: `缺少必需的 MCP-Protocol-Version 请求头 (支持版本: ${PLUS_PROTOCOL_VERSION})`,
  };
}

/**
 * 综合安全校验结果
 */
export interface HttpSecurityVerificationResult {
  valid: boolean;
  statusCode?: number;
  statusText?: string;
  error?: string;
  parsed?: ParsedHttpRequest;
}

/**
 * 执行完整的 HTTP 请求安全校验管道
 */
export function verifyHttpRequestSecurity(
  headerText: string,
  body: string,
  expectedPort: number,
  expectedToken: string,
): HttpSecurityVerificationResult {
  const parsed = parseHttpRequestHeaders(headerText);

  // 1. 请求行基础格式检查
  if (!parsed.rawRequestLine || !parsed.rawRequestLine.includes("HTTP/")) {
    return {
      valid: false,
      statusCode: 400,
      statusText: "Bad Request",
      error: "请求格式无效",
      parsed,
    };
  }

  // 2. 敏感头重复检查
  const duplicateCheck = validateDuplicateSensitiveHeaders(parsed.headers);
  if (!duplicateCheck.valid) {
    return {
      valid: false,
      statusCode: 400,
      statusText: "Bad Request",
      error: duplicateCheck.error,
      parsed,
    };
  }

  // 3. 代理转发头伪装检查
  const forwardingCheck = validateForwardingHeaders(parsed.headers);
  if (!forwardingCheck.valid) {
    return {
      valid: false,
      statusCode: 400,
      statusText: "Bad Request",
      error: forwardingCheck.error,
      parsed,
    };
  }

  // 4. Host 头检查 (仅允许 127.0.0.1/localhost/[::1] 且带实际端口)
  const hostValues = parsed.headers.get("host");
  const hostHeader = hostValues ? hostValues[0] : undefined;
  const hostCheck = validateHost(hostHeader, expectedPort);
  if (!hostCheck.valid) {
    return {
      valid: false,
      statusCode: 400,
      statusText: "Bad Request",
      error: hostCheck.error,
      parsed,
    };
  }

  // 5. Origin 检查 (拒绝所有带 Origin 的请求)
  const originValues = parsed.headers.get("origin");
  const originHeader = originValues ? originValues[0] : undefined;
  const originCheck = validateOrigin(originHeader);
  if (!originCheck.valid) {
    return {
      valid: false,
      statusCode: 403,
      statusText: "Forbidden",
      error: originCheck.error,
      parsed,
    };
  }

  // 6. Bearer Token 身份认证检查
  const authValues = parsed.headers.get("authorization");
  const authHeader = authValues ? authValues[0] : undefined;
  const authCheck = validateBearerToken(authHeader, expectedToken);
  if (!authCheck.valid) {
    return {
      valid: false,
      statusCode: authCheck.statusCode,
      statusText: "Unauthorized",
      error: authCheck.error,
      parsed,
    };
  }

  // 7. MCP 端点协议版本检查
  const urlPath = parsed.urlPath.split("?")[0];
  if (urlPath === "/mcp") {
    const versionValues = parsed.headers.get("mcp-protocol-version");
    const versionHeader = versionValues ? versionValues[0] : undefined;
    const versionCheck = validateMcpProtocolVersion(versionHeader, body);
    if (!versionCheck.valid) {
      return {
        valid: false,
        statusCode: 400,
        statusText: "Bad Request",
        error: versionCheck.error,
        parsed,
      };
    }
  }

  return { valid: true, parsed };
}
