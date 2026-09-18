# Zotero MCP Plus 升级说明

Plus `0.1.0` **不提供在线自动更新**，也不使用上游 Zotero MCP 的更新源。

Zotero 9.0.6 要求插件 manifest 包含非空 HTTPS `update_url`。Plus 使用保留域名地址 `https://example.invalid/zotero-mcp-plus/updates.json` 占位，不降低宿主的更新安全检查。手动检查更新可能报告连接失败，这不代表 MCP 服务不可用。

升级时从本项目的 GitHub Releases 下载 XPI，核对发布的 SHA256，在 Zotero“工具 → 插件 → 从文件安装插件”中手动安装。保留原版插件、配置及一致性文库备份。不要将 Plus 的更新地址改为上游地址，也不要将原版 XPI 当作 Plus 升级包。

源码中 `update.json` 和 `update-beta.json` 仅保留空清单，防止遗留工具把上游历史版本当作 Plus 更新；它们不作为 Release 资产发布。

发布辅助命令 `npm run prepare-release` 与 `npm run release:init` 只检查本地产物并输出摘要，不递增版本、不生成在线更新清单、不执行提交或推送。

- [安装与连接](README.md#构建与安装)
- [工具契约及回滚边界](docs/PLUS.md)
- [验证记录](docs/VALIDATION.md)
