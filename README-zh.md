# Zotero MCP Plus（简体中文）

[主说明 README.md](README.md) 已使用简体中文，包含准确的 8 个新增工具、28 个保留工具、构建安装、客户端配置与回滚说明。

- [工具契约、安全默认及限制](docs/PLUS.md)
- [验证结果、可复现命令与未验证范围](docs/VALIDATION.md)
- [上游与第三方许可](THIRD_PARTY_NOTICES.md)

当前版本 `0.1.0`，验证目标为 Zotero 9.0.6；默认端点为 `http://127.0.0.1:23121/mcp`，必须携带本机生成的 Bearer token。默认禁止文库写入，不复制旧插件密钥。写工具使用同名调用的 `dryRun` 预览与确认流程，不存在单独的 `prepare` 或 `execute` 公开工具。
