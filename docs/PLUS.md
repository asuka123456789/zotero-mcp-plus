# Plus 工具契约与安全边界

版本 `0.1.0`，MCP `2025-11-25`；以运行时 `tools/list` 返回的 schema 为准确参数来源。

## 身份、连接与数据文件

| 项目            | Plus 值                                              |
| --------------- | ---------------------------------------------------- |
| Addon ID        | `{8c2b53b8-6a58-4fc1-b20f-07612fce0a77}`             |
| addonRef / 实例 | `zotero-mcp-plus` / `Zotero.ZoteroMCPPlus`           |
| 偏好前缀        | `extensions.zotero.zotero-mcp-plus`                  |
| 默认端点        | `http://127.0.0.1:23121/mcp`                         |
| 任务账本        | Zotero 数据目录内的 `zotero-mcp-plus-tasks.sqlite`   |
| 向量库          | Zotero 数据目录内的 `zotero-mcp-plus-vectors.sqlite` |
| 语义列 dataKey  | `mcpPlusSemanticStatus`                              |

Zotero 9.0.6 要求 manifest 中有非空 HTTPS `update_url`，省略字段或使用 `data:` 都不能通过安装校验。本地版使用保留域名地址 `https://example.invalid/zotero-mcp-plus/updates.json` 明确占位，不继承上游更新源、不提供在线更新，也不降低宿主更新安全检查。手动检查更新可能报告连接失败，升级须手动安装新 XPI；构建钩子核验身份、版本和该地址。

仅监听回环。HTTP 要求精确匹配本机 Host/端口、拒绝任何 Origin、转发来源头及重复敏感头，并验证随机 256 位 Bearer token。逐字节比较避免按相同前缀提前返回，不把 JavaScript 实现描述为形式化的恒定时间证明。

无 MCP session，不实现 SSE 或标准 MCP Tasks 扩展，也不声明 `tools/list_changed`。GET `/mcp` 返回 405；notification 返回 202 空 body。初始化协商版本，后续请求须带 `MCP-Protocol-Version: 2025-11-25`。非 `/mcp` REST 写入口关闭；`/test/mcp` 不公开。

默认 `write.enabled=false`、`semantic.enabled=false`、`semantic.autoUpdate=false`。认证轮换、关服务、改端口或禁写会停止后续投递并作废未消费确认；重新启用不会自动恢复已暂停的任务。旧插件配置和第三方模型凭据不迁入 Plus。

传输层不记录请求头、请求正文或访问令牌。原生 Zotero 诊断和其他插件不属于该日志边界；对外提供任何诊断材料前仍需脱敏。持久账本本身包含任务参数、必要状态快照和结果，应按私有文库资料保管。

## 八个新增工具

| 工具                          | 主要输入及行为                                                                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `find_standalone_attachments` | 可选 `libraryID`、`collectionKey`、`query/q`、`fulltext`、`fileStatus`、排序和分页；首版仅 PDF，返回 key、状态、可识别性及覆盖信息 |
| `recognize_pdfs`              | `attachmentKeys`（1–500 个）及可选 `libraryID`；原生逐项提交，并发 1                                                               |
| `task_status`                 | `taskID`，可选结果 `limit/offset`；返回计数、逐项结果、原生 in-flight 情况及允许操作；必要时只读对账                               |
| `task_list`                   | 可按 `libraryID/state/tool` 过滤并分页，不返回所有内部快照                                                                         |
| `task_control`                | `taskID` 与 `action: pause/resume/cancel/retry`；停止不需确认，恢复/重试须重新预览确认                                             |
| `find_duplicates`             | 文库/集合范围与 `offset/maxItems`；输出匹配依据、冲突和扫描覆盖，不写库                                                            |
| `merge_items`                 | `groups` 内指定 `masterKey`、`otherKeys`，可选 `fieldSources`、`creatorsSourceKey`；只允许组内字段来源                             |
| `library_health`              | 文库/集合范围、`offset/maxItems`、`includeDuplicates`；只读报告与建议，不修复或下载                                                |

其余 28 个旧工具保留。旧 `search_library(itemType="attachment")` 复用独立附件查询，但保留非 PDF 附件；显式 `includeAttachments:"false"` 排除附件。旧写工具不再省略确认就立即写入；这是有意的安全行为变化。

## 预览、确认与幂等

1. 对写工具省略 `dryRun` 或设置 `true`。预览不修改文库、不下载文件、不调用识别/translator；允许保存 Plus 自己的确认账本。
2. 展示 `items`、变更内容、`warnings`、阻断项与联网行为，取得人类对该批目标的明确同意。
3. 同一个工具、相同业务参数，加 `dryRun:false`、`confirmationToken`、`idempotencyKey` 再提交。
4. 收到 `taskID` 只表示持久入队成功；轮询 `task_status` 判断实际结果。

确认首次消费前 TTL 为 5 分钟，绑定操作、参数和快照。消费、入队、幂等记录与预留处于同一账本事务。同键同参数返回原任务；同键不同参数拒绝；不能换幂等键重复消费 token。已接受的任务不会因预览 TTL 后续到期而中断。

令牌不能证明人类授权，客户端不能自行把预览成功解释为“已获同意”。Bearer token 也不等于用户对某批次的同意。

`add_by_identifier` 确认后总是使用持久队列，返回 `jobID=taskID`，旧的 `add_by_identifier({jobID})` 用于查询新任务。原版已经丢失的纯内存 job 不能恢复；`async` 兼容参数不关闭持久队列。

## 调度、暂停与恢复

任务持久引用使用 `{libraryID, itemKey}`，而不是标题。认领记录 `attemptID/owner/lease`，原生调用前先落盘执行意图。长时间识别与短写分不同执行通道；未知结果保持目标预留。

- `pause/cancel` 只停止未投递项，不调用原生全局 `queue.cancel()`，不保证原生 in-flight 中断。
- 超时或 lease 到期不是重新执行的依据。
- 重启只读对账；未投递项保持暂停，原生结果不明确则 `needs_review`。
- 已被外部操作满足的结果记为 `externally_satisfied`，不记成本任务 `succeeded`。
- 仅能证明安全的失败项才允许经确认重试；不能用新幂等键绕过未知尝试。
- 状态保存失败、账本损坏或不兼容的 schema 版本会停止接受写入，保留文件，不删除重建。
- Plus 不能锁住 Zotero UI 或其他插件。执行前重新核验快照，执行后核验实际持久状态，不承诺跨插件全局互斥或 exactly-once。

任务状态、步骤状态与内部 phase 分开；例如 `native_intent` 是执行阶段，不是公开任务总状态。

## 原生 PDF 识别

调用 `Zotero.RecognizeDocument.canRecognize/recognizeItems` 与原生 `recognize` 进度队列。先监听事件，再提交一个附件；只处理该 numeric item ID 的事件，持久身份仍为 key。

`recognizeItems` 的 Promise 返回不等于该项成功。成功需要确认：原 PDF 仍存在、活跃同库普通 parent、原集合迁移到 parent、原批注仍存在且归属和删除状态未异常变化。原生失败可能已创建未挂接的 parent，因此不能因“附件仍独立”自动重试。

预览披露联网和可能的自动重命名。不会把私有论文交给新的 AI 提供方；使用的是用户本机 Zotero 的原生识别服务。文件状态包括 `available/not_local/missing/unavailable/linked_url`；未下载不等于损坏。

## 原生合并与导入边界

`merge_items` 只合并同库、同类型、可写的普通条目。使用已核实的 `chrome://zotero/content/mergeItems.mjs`，外层不再套 Zotero 主库事务。

首版固定 `preserve_all`：原生合并可能自动去重 PDF/网页附件，所以 **donor 不得持有这些附件（含回收站子项）**；master 可持有。不满足则返回 `ATTACHMENT_PRESERVATION_UNSUPPORTED`，不发执行令牌，也不先搬附件绕过限制。

快照与预留包括会受影响的子项及同库入站关系拥有者。成功需核验字段/creators、集合、标签、笔记、附件和关系，不只看 donor 是否已被 trash。不承诺改写跨库关系。原生失败后重新加载缓存并对账；原生事务不等于整个批次原子，也不等于提供 undo。

本地导入使用 `imports.allowedRoots`（JSON 字符串数组）显式配置授权根；默认拒绝导入。拒绝 UNC、symlink/junction、非法路径、未允许扩展/MIME及大于 100 MiB 的文件，确认绑定内容摘要。对外结果默认不暴露绝对路径。

## 升级与回滚

保留原版 XPI 和连接配置，给 Plus 新增独立入口。升级前先备份真实文库及附件；降级不能重建高版本账本。停用 Plus 并恢复旧客户端入口可回滚连接，但不会撤销已经发生的文库修改。
