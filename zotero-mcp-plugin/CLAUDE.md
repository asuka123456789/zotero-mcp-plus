# Zotero MCP Plus

基于 `cookjohn/zotero-mcp` v1.6.0 的独立派生插件；保留 MIT 许可和上游归属。

- 源码：`src/`；运行资源：`addon/`；契约和验证记录：`../docs/`。
- 身份、版本以 `package.json` 为准；偏好前缀为 `extensions.zotero.zotero-mcp-plus`。
- 构建：`npm run build` → `.scaffold/build/zotero-mcp-plus.xpi`。
- 检查：`npm run lint:check`、`npm run test:unit`、`npm audit --audit-level=moderate`。
- 原生集成：显式设置 `ZOTERO_PLUGIN_ZOTERO_BIN_PATH` 后运行 `npm run test:integration`；仅使用包装器创建的隔离 profile/data。其他可选参数见验证记录。
- 默认禁写、禁语义索引；写工具必须遵守预览、真人确认和幂等流程。不得把令牌当作真人授权。
- 不在真实文库运行写入测试，不直接离线改写 `zotero.sqlite`，不迁入第三方密钥。
- `npm run prepare-release` / `npm run release:init` 仅做本地产物检查；提交、推送及发布须符合当次用户授权，不执行隐式发布脚本。
- 不提供在线自动更新；`example.invalid` HTTPS 地址仅满足 Zotero 安装校验，空 `update*.json` 不发布为更新服务。
- 日志不包含 token、凭据或文献全文；不提交 `.scaffold`、个人配置或真实文库。
