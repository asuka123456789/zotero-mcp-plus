import { expect } from "chai";
import {
  validateHost,
  validateOrigin,
  validateForwardingHeaders,
  validateDuplicateSensitiveHeaders,
  validateBearerToken,
  validateMcpProtocolVersion,
  constantTimeEqual,
  generateBearerToken,
  parseHttpRequestHeaders,
  verifyHttpRequestSecurity,
  PLUS_PROTOCOL_VERSION,
} from "../../src/modules/httpSecurity.ts";

describe("httpSecurity unit tests", function () {
  const TEST_PORT = 23121;
  const TEST_TOKEN =
    "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";

  describe("Host validation", function () {
    it("accepts loopback IPv4 with exact port", function () {
      expect(validateHost(`127.0.0.1:${TEST_PORT}`, TEST_PORT).valid).to.equal(
        true,
      );
    });

    it("accepts localhost with exact port", function () {
      expect(validateHost(`localhost:${TEST_PORT}`, TEST_PORT).valid).to.equal(
        true,
      );
    });

    it("accepts loopback IPv6 with exact port", function () {
      expect(validateHost(`[::1]:${TEST_PORT}`, TEST_PORT).valid).to.equal(
        true,
      );
    });

    it("rejects missing or empty Host header", function () {
      expect(validateHost(undefined, TEST_PORT).valid).to.equal(false);
      expect(validateHost("", TEST_PORT).valid).to.equal(false);
      expect(validateHost("   ", TEST_PORT).valid).to.equal(false);
    });

    it("rejects non-loopback hosts", function () {
      expect(
        validateHost(`192.168.1.10:${TEST_PORT}`, TEST_PORT).valid,
      ).to.equal(false);
      expect(
        validateHost(`example.com:${TEST_PORT}`, TEST_PORT).valid,
      ).to.equal(false);
      expect(validateHost(`0.0.0.0:${TEST_PORT}`, TEST_PORT).valid).to.equal(
        false,
      );
    });

    it("rejects port mismatch", function () {
      expect(validateHost("127.0.0.1:8080", TEST_PORT).valid).to.equal(false);
      expect(validateHost("localhost:23120", TEST_PORT).valid).to.equal(false);
    });

    it("rejects Host without port", function () {
      expect(validateHost("127.0.0.1", TEST_PORT).valid).to.equal(false);
      expect(validateHost("localhost", TEST_PORT).valid).to.equal(false);
      expect(validateHost("[::1]", TEST_PORT).valid).to.equal(false);
    });
  });

  describe("Origin validation", function () {
    it("accepts requests without Origin header", function () {
      expect(validateOrigin(undefined).valid).to.equal(true);
      expect(validateOrigin("").valid).to.equal(true);
    });

    it("rejects any Origin header (no browser cross-origin calls allowed)", function () {
      expect(validateOrigin("http://localhost:3000").valid).to.equal(false);
      expect(validateOrigin("https://example.com").valid).to.equal(false);
      expect(validateOrigin("null").valid).to.equal(false);
    });
  });

  describe("Forwarding headers validation", function () {
    it("accepts headers without forwarding headers", function () {
      const headers = new Map<string, string[]>([
        ["host", [`127.0.0.1:${TEST_PORT}`]],
        ["authorization", [`Bearer ${TEST_TOKEN}`]],
      ]);
      expect(validateForwardingHeaders(headers).valid).to.equal(true);
    });

    it("rejects X-Forwarded-For, X-Forwarded-Host, and Forwarded", function () {
      for (const forbidden of [
        "x-forwarded-for",
        "x-forwarded-host",
        "x-forwarded-proto",
        "x-forwarded-port",
        "forwarded",
        "x-real-ip",
      ]) {
        const headers = new Map<string, string[]>([[forbidden, ["10.0.0.1"]]]);
        const result = validateForwardingHeaders(headers);
        expect(result.valid, forbidden).to.equal(false);
      }
    });
  });

  describe("Duplicate sensitive headers validation", function () {
    it("accepts single sensitive headers", function () {
      const headers = new Map<string, string[]>([
        ["host", [`127.0.0.1:${TEST_PORT}`]],
        ["authorization", [`Bearer ${TEST_TOKEN}`]],
        ["content-type", ["application/json"]],
        ["mcp-protocol-version", [PLUS_PROTOCOL_VERSION]],
      ]);
      expect(validateDuplicateSensitiveHeaders(headers).valid).to.equal(true);
    });

    it("rejects duplicate sensitive headers", function () {
      for (const sensitive of [
        "host",
        "authorization",
        "origin",
        "content-length",
        "content-type",
        "mcp-protocol-version",
      ]) {
        const headers = new Map<string, string[]>([
          [sensitive, ["val1", "val2"]],
        ]);
        const result = validateDuplicateSensitiveHeaders(headers);
        expect(result.valid, sensitive).to.equal(false);
      }
    });
  });

  describe("Bearer token validation and constant-time compare", function () {
    it("accepts valid Bearer token", function () {
      const auth = `Bearer ${TEST_TOKEN}`;
      const result = validateBearerToken(auth, TEST_TOKEN);
      expect(result.valid).to.equal(true);
      expect(result.statusCode).to.equal(200);
    });

    it("rejects missing Authorization header with 401", function () {
      const result = validateBearerToken(undefined, TEST_TOKEN);
      expect(result.valid).to.equal(false);
      expect(result.statusCode).to.equal(401);
    });

    it("rejects non-Bearer authentication scheme with 401", function () {
      const result = validateBearerToken("Basic dXNlcjpwYXNz", TEST_TOKEN);
      expect(result.valid).to.equal(false);
      expect(result.statusCode).to.equal(401);
    });

    it("rejects empty Bearer token with 401", function () {
      const result = validateBearerToken("Bearer ", TEST_TOKEN);
      expect(result.valid).to.equal(false);
      expect(result.statusCode).to.equal(401);
    });

    it("rejects incorrect Bearer token with 401", function () {
      const wrong =
        "0000000000000000000000000000000000000000000000000000000000000000";
      const result = validateBearerToken(`Bearer ${wrong}`, TEST_TOKEN);
      expect(result.valid).to.equal(false);
      expect(result.statusCode).to.equal(401);
    });

    it("constantTimeEqual accurately tests equality across lengths and contents", function () {
      expect(constantTimeEqual("secret", "secret")).to.equal(true);
      expect(constantTimeEqual("secret", "secrex")).to.equal(false);
      expect(constantTimeEqual("secret", "sec")).to.equal(false);
      expect(constantTimeEqual("", "")).to.equal(true);
    });

    it("generateBearerToken generates 64-char hex token", function () {
      const t1 = generateBearerToken();
      const t2 = generateBearerToken();
      expect(t1).to.match(/^[0-9a-f]{64}$/);
      expect(t2).to.match(/^[0-9a-f]{64}$/);
      expect(t1).to.not.equal(t2);
    });
  });

  describe("MCP-Protocol-Version policy", function () {
    it("accepts matching protocol version header 2025-11-25", function () {
      const result = validateMcpProtocolVersion("2025-11-25", "");
      expect(result.valid).to.equal(true);
    });

    it("rejects unsupported protocol version header", function () {
      const result = validateMcpProtocolVersion("2024-11-05", "");
      expect(result.valid).to.equal(false);
      expect(result.error).to.include("不支持的 MCP-Protocol-Version");
    });

    it("allows missing version header for initialize request", function () {
      const initBody = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25" },
      });
      const result = validateMcpProtocolVersion(undefined, initBody);
      expect(result.valid).to.equal(true);
    });

    it("rejects missing version header for non-initialize request", function () {
      const toolsBody = JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      });
      const result = validateMcpProtocolVersion(undefined, toolsBody);
      expect(result.valid).to.equal(false);
      expect(result.error).to.include("缺少必需的 MCP-Protocol-Version 请求头");
    });
  });

  describe("Full verifyHttpRequestSecurity pipeline", function () {
    it("passes valid initialize request without version header", function () {
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
      });
      const headerText =
        `POST /mcp HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${TEST_PORT}\r\n` +
        `Authorization: Bearer ${TEST_TOKEN}\r\n` +
        `Content-Type: application/json\r\n` +
        `Content-Length: ${body.length}\r\n\r\n`;

      const res = verifyHttpRequestSecurity(
        headerText,
        body,
        TEST_PORT,
        TEST_TOKEN,
      );
      expect(res.valid).to.equal(true);
    });

    it("passes valid tools/call request with 2025-11-25 header", function () {
      const body = JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
      });
      const headerText =
        `POST /mcp HTTP/1.1\r\n` +
        `Host: localhost:${TEST_PORT}\r\n` +
        `Authorization: Bearer ${TEST_TOKEN}\r\n` +
        `MCP-Protocol-Version: 2025-11-25\r\n` +
        `Content-Type: application/json\r\n` +
        `Content-Length: ${body.length}\r\n\r\n`;

      const res = verifyHttpRequestSecurity(
        headerText,
        body,
        TEST_PORT,
        TEST_TOKEN,
      );
      expect(res.valid).to.equal(true);
    });

    it("blocks request with Origin header (403)", function () {
      const body = "{}";
      const headerText =
        `POST /mcp HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${TEST_PORT}\r\n` +
        `Origin: http://localhost:3000\r\n` +
        `Authorization: Bearer ${TEST_TOKEN}\r\n\r\n`;

      const res = verifyHttpRequestSecurity(
        headerText,
        body,
        TEST_PORT,
        TEST_TOKEN,
      );
      expect(res.valid).to.equal(false);
      expect(res.statusCode).to.equal(403);
    });

    it("blocks request with invalid token (401)", function () {
      const body = "{}";
      const headerText =
        `POST /mcp HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${TEST_PORT}\r\n` +
        `Authorization: Bearer wrong-token\r\n\r\n`;

      const res = verifyHttpRequestSecurity(
        headerText,
        body,
        TEST_PORT,
        TEST_TOKEN,
      );
      expect(res.valid).to.equal(false);
      expect(res.statusCode).to.equal(401);
    });

    it("blocks request with duplicate Host header (400)", function () {
      const body = "{}";
      const headerText =
        `POST /mcp HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${TEST_PORT}\r\n` +
        `Host: evil.com:${TEST_PORT}\r\n` +
        `Authorization: Bearer ${TEST_TOKEN}\r\n\r\n`;

      const res = verifyHttpRequestSecurity(
        headerText,
        body,
        TEST_PORT,
        TEST_TOKEN,
      );
      expect(res.valid).to.equal(false);
      expect(res.statusCode).to.equal(400);
      expect(res.error).to.include("重复的敏感请求头: host");
    });

    it("blocks request with X-Forwarded-For header (400)", function () {
      const body = "{}";
      const headerText =
        `POST /mcp HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${TEST_PORT}\r\n` +
        `X-Forwarded-For: 1.2.3.4\r\n` +
        `Authorization: Bearer ${TEST_TOKEN}\r\n\r\n`;

      const res = verifyHttpRequestSecurity(
        headerText,
        body,
        TEST_PORT,
        TEST_TOKEN,
      );
      expect(res.valid).to.equal(false);
      expect(res.statusCode).to.equal(400);
      expect(res.error).to.include("代理转发请求头");
    });
  });
});
