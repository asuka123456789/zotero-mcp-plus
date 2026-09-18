# Zotero MCP Plus

为 Zotero MCP 增加原生 PDF 识别、持久任务队列、安全重复项治理和文库健康检查。**这是 Zotero MCP 扩展，不是 AI Butler，也不内置新的模型提供方。**

版本 `0.1.0`。基于 [cookjohn/zotero-mcp](https://github.com/cookjohn/zotero-mcp) 的 `v1.6.0`，固定基线 commit：`e87f266b45cf26f8756cfa7e0e9d30ebc03b792b`。保留 MIT 许可与上游归属。

当前验证平台为 **Windows 11 / Zotero 9.0.6**。不宣称已支持所有 Zotero 7–10 版本。具体测试结果与未验证范围见 [验证记录](docs/VALIDATION.md)。手动安装包以本项目的 [GitHub Releases](https://github.com/asuka123456789/zotero-mcp-plus/releases) 为准，**不提供在线自动更新**。

## 能力

保留 28 个旧工具（包括旧写工具），新增以下 8 个工具：

| 工具                          | 用途                                                       |
| ----------------------------- | ---------------------------------------------------------- |
| `find_standalone_attachments` | 分页查找独立 PDF，报告本地文件状态及可识别性               |
| `recognize_pdfs`              | 调用 Zotero 原生识别，逐项记录结果，默认只预览             |
| `task_status`                 | 查询任务及逐项结果，对未知结果进行只读核验                 |
| `task_list`                   | 分页查询持久任务                                           |
| `task_control`                | 暂停、取消，以及重新预览确认后的恢复或安全重试             |
| `find_duplicates`             | 查找候选、显示匹配依据和标识符冲突，不自动合并             |
| `merge_items`                 | 对满足保全限制的同库、同类型条目执行原生合并               |
| `library_health`              | 只读检查独立 PDF、文件状态、元数据缺项、重复候选及任务情况 |

### 默认安全边界

- 独立插件 ID：`{8c2b53b8-6a58-4fc1-b20f-07612fce0a77}`，实例 `Zotero.ZoteroMCPPlus`。
- 独立偏好：`extensions.zotero.zotero-mcp-plus`。
- 默认端点：`http://127.0.0.1:23121/mcp`；仅监听回环，必须提供随机 Bearer token。
- 文库写入、语义索引与自动索引均默认关闭。不复制原插件的 API key 或模型配置。
- 独立账本 `zotero-mcp-plus-tasks.sqlite`，独立向量库 `zotero-mcp-plus-vectors.sqlite`。不修改 Zotero 主库 schema。
- 原版插件及默认 `23120` 端口可保留，不覆盖旧 XPI，也不自动移除旧客户端配置。
- Zotero 9.0.6 要求非空 HTTPS `update_url`；本地版使用保留域名 `example.invalid` 明确占位，不连接上游更新源，也不提供在线更新。升级须手动安装新 XPI。
- 采用 MCP `2025-11-25` 的无 session、JSON-only Streamable HTTP。不提供 SSE；GET `/mcp` 返回 405，通知返回 202 空响应。

## 写入流程

预览与执行使用**同一个工具名**，不存在 `prepare`、`execute` 或 `reconcile` 这类独立公开工具。

1. 调用写工具，省略 `dryRun` 或设为 `true`。
2. 展示返回的目标、差异、阻断项和警告，取得用户对该批操作的明确确认。
3. 使用完全相同的业务参数再次调用，增加 `dryRun:false`、`confirmationToken` 和唯一 `idempotencyKey`。
4. 通过 `task_status({taskID})` 查询结果，不能把“已入队”当作“已完成”。

例如，预览 `recognize_pdfs({libraryID:1, attachmentKeys:["ABCDEFGH"]})`；**只有确认后**才补充执行参数。确认令牌有效期为首次消费前 5 分钟。重复提交相同幂等键和参数会返回原任务，不会重复创建任务。

令牌只绑定预览与请求，不能证明操作者是人类。客户端仍须履行上述确认流程。禁写时可以预览，但不能接受新执行请求。

### 重要限制

- 原生识别可能联网并自动重命名附件；预览不能预测识别出的 DOI、标题或成功率。
- 暂停或取消只阻止后续投递，不能保证已经进入原生队列的操作停止。
- 重启后只对账，不自动重跑未知尝试。`needs_review` 保留目标预留；仅能确认外部状态已满足时记为 `externally_satisfied`，不冒认本任务执行成功。
- 首版合并固定为 `preserve_all`：donor 不得持有 PDF 或网页附件（包括回收站子项），否则不给执行令牌；这些附件可以位于 master。其他附件、字段、笔记、标签、集合和关系也需通过前后状态核验。
- 不提供通用 undo，不物理删除 PDF，不自动清空回收站。插件回滚不会撤销已完成的文库修改。
- 文件导入仅允许本地明确授权的目录；默认没有授权目录，拒绝 UNC、符号链接及路径逃逸。

## 构建与安装

使用 **Node.js 24**，在 `zotero-mcp-plugin/` 中执行：

```bash
npm ci --ignore-scripts
npm run test:unit
npm run build
```

本地 XPI 位于 `.scaffold/build/`。在 Zotero 的“工具 → 插件”中选择“从文件安装插件”，选择 Plus 的 XPI；不要覆盖原插件文件。首次安装保持禁写，先完成只读连接检查。

在 Plus 设置中复制 Bearer token，并新增独立客户端项：

```json
{
  "mcpServers": {
    "zotero-plus": {
      "type": "http",
      "url": "http://127.0.0.1:23121/mcp",
      "headers": {
        "Authorization": "Bearer <从本机 Plus 设置复制的令牌>"
      }
    }
  }
}
```

上述为 Claude Code 格式。不同 MCP 客户端的配置字段可能不同；不要把真实 token 提交到仓库、公开截图或聊天记录中。连接配置保存后需要让客户端重新加载 MCP。

## 验证、升级与回滚

- [工具契约和安全边界](docs/PLUS.md)
- [测试命令、验证结果与已知限制](docs/VALIDATION.md)
- [第三方许可](THIRD_PARTY_NOTICES.md)

集成测试使用独立 `.scaffold/test/profile` 与 `.scaffold/test/data`，不使用真实文库。公开 PDF 联网识别需显式设置 `PLUS_TEST_NETWORK_PDF=1`。

升级前保留旧 XPI、客户端配置及一致性文库备份。回滚时停用 Plus，将客户端恢复到原版入口；保留 Plus 账本以便核查历史。高版本账本不能由低版本插件静默重建。

本项目独立发布源码和 XPI，保留上游归属。发布辅助脚本只做本地检查，不隐式提交或推送。实际处理真实文库前，仍须核对一致性备份并取得该批操作确认。
