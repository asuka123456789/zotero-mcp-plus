# Zotero MCP Plus 验证记录

验证日期：2026-09-18。版本：`0.1.0`。本文记录实际结果，不把单元 fixture、原生集成与主文库只读检查混为一谈。

## 环境与结果

- Windows 11，Zotero **9.0.6**（BuildID `20260707151128`）。
- Node.js `24.12.0`，npm `11.6.2`。
- 原版并行测试使用 Zotero MCP `1.6.0`；Plus 使用独立身份、偏好、端口和数据库。

| 检查                    | 实际结果         | 范围                                                                                                        |
| ----------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------- |
| Node 单元测试           | **220 项通过**   | HTTP 45、确认/账本/调度/注册表 72、旧写适配 16、重复/健康 34、识别/独立附件 49、偏好 4；分类数字不重复相加  |
| Zotero 隔离集成         | **25 项通过**    | 原生与 HTTP 16、sidecar 重开恢复 3、原写入串行与通知 4、原版并行及 Plus 停启 2；包含安装兼容和更新地址边界  |
| TypeScript              | **通过**         | `tsc --noEmit`，按项目 tsconfig 检查源码                                                                    |
| 依赖审计                | **0 个已知漏洞** | `npm audit --audit-level=moderate`，包含开发依赖；不代表没有未知漏洞                                        |
| 全仓格式与 ESLint       | **通过**         | `npm run lint:check`；已消除 Mocha 间距与 Prettier 的冲突                                                   |
| 生产 XPI 构建与内容检查 | **通过**         | 独立 ID、默认禁写/禁语义、许可一致、不继承上游更新源；未包含测试 fixture、数据库、已知私有路径或固定 Bearer |
| 主 profile 并行只读安装 | **通过**         | 持久安装与初始化、36 工具发现、受限只读健康检查；原插件、两个旧入口和翻译设置保留，未执行真实文库写入测试   |

## 可重复执行

在 `zotero-mcp-plugin/` 内运行：

```bash
npm ci --ignore-scripts
npm run lint:check
npm run test:unit
npm run build
npm audit --audit-level=moderate
```

隔离集成测试（Git Bash 示例，替换本机可执行文件路径）：

```bash
ZOTERO_PLUGIN_ZOTERO_BIN_PATH='/path/to/zotero.exe' npm run test:integration
```

包含安装兼容与更新地址检查的完整 25 项组合，还须显式启用公开 PDF 联网识别，并指定原版 `1.6.0` XPI：

```bash
PLUS_TEST_NETWORK_PDF=1 \
ZOTERO_PLUS_LEGACY_XPI='/path/to/original-zotero-mcp-1.6.0.xpi' \
ZOTERO_PLUGIN_ZOTERO_BIN_PATH='/path/to/zotero.exe' \
npm run test:integration
```

未设置 `PLUS_TEST_NETWORK_PDF=1` 时不注册联网用例；未提供原版 XPI 时跳过并行用例，因此不能声称运行了完整 25 项。生产构建与集成测试共享 `.scaffold/build`，不要并行执行。

CI 定义见 `.github/workflows/plus-ci.yml`：Node 24、锁定依赖安装、lint、单测、构建和审计；不创建 release、不推送产物。远端结果见 [GitHub Actions](https://github.com/asuka123456789/zotero-mcp-plus/actions/workflows/plus-ci.yml)。该 CI 不运行 Zotero GUI；原生联网和并行验证在本机隔离实例中另行运行。

## 隔离及报告校验

- 启动入口是 `scripts/test-isolated.mjs`，必须显式指定 Zotero 可执行文件。
- Profile 为 `.scaffold/test/profile`，数据目录为 `.scaffold/test/data`，二者不是嵌套的 `profile/data`。
- 使用独立 marker，拒绝未知非空目录及 symlink/junction，不猜测或复用主 profile。
- 使用 `-no-remote` 与 `MOZ_NO_REMOTE=1`；禁用同步、自动更新、默认写入及语义自动索引。
- 测试还校验数据目录后缀和隔离偏好；写测试仅在通过双重检查后开启隔离实例的写入。
- 退出码 0 不足以通过：包装器核对数据目录内 `plus-integration-result.json`、`recovery-result.json`、`upstream-writes-result.json`，以及启用并行测试时的 `coexistence-result.json`。报告必须有足够用例且全部通过。
- 不强杀主 Zotero、不修改真实 `zotero.sqlite` 或主库 schema。真实文库的整理须另外核对一致性备份、生成预览并确认批次。

## 已验证的关键行为

- 36 个工具及 MCP `2025-11-25` 初始化、通知、真实 HTTP 调用；未认证、非法来源、非法参数及关闭的 REST 写入口不能绕过确认策略。
- 禁写仍允许预览；确认后写入实际落库；幂等重放不重复创建。并发首次接受、令牌过期/复用、参数冲突及响应丢失由单测覆盖。
- 原生 `mozIStorageRow` 非可枚举代理适配；完整偏好名观察者；令牌轮换作废确认，切换端口后启用新监听。
- 元数据、标签、笔记、集合、附件 parent 创建/reparent、本地授权文件导入及 HTML 旧搜索；执行后重新加载并核验持久状态。
- `add_by_identifier` 的已有 DOI 路径、显式 `fileExisting:true` 集合归档及旧 `jobID` 查询；未重复导入已有条目。未在本轮真实调用远程 translator 导入新的 identifier。
- 原生合并保留所选字段、标签、集合、笔记、TXT donor 附件和 PDF master 附件；donor 带 PDF 时在预览阶段阻断。
- 公开 CC BY PDF 真实联网识别后，父文献 DOI、两个集合、原批注归属及文件 SHA256 均核验通过。来源、许可和摘要见 `test/fixtures/README.md`；测试文件不进入 XPI。
- sidecar 关闭重开后只读对账：未知 `native_intent` 保留预留并进入 `needs_review`；已发生但未 checkpoint 的外部结果记为 `externally_satisfied`；pending/cancel 不自动重新投递。
- 隔离实例中原版与 Plus 同时响应；Plus 禁用后停止自身监听，重新启用后保留持久任务，原版实例及写入偏好不受影响。

## 主 profile 只读安装验收

已使用原生 AddonManager 持久安装，不是临时开发插件。安装的 XPI 与测试后生产包摘要一致，Plus 已初始化并在 `127.0.0.1:23121` 响应。

- `write.enabled`、`semantic.enabled`、`semantic.autoUpdate` 均为 `false`；没有迁入旧模型配置。
- 实际 HTTP `initialize`、36 工具的 `tools/list` 及 `library_health` 通过。健康检查预算为 20 个条目、关闭重复候选扫描，不将其解释为全库检查。
- 原版 XPI 摘要和已有插件启停/版本状态保持不变；原两个客户端入口仍各返回 28 个工具。新增独立 `zotero-plus` 配置，其他客户端配置保持不变，并先保存本地备份。
- 安装前后文库条目身份、类型、修改时间、版本及回收站成员摘要一致；翻译插件用户偏好摘要一致。未对主库运行写入测试，也未声称逐个校验全部真实附件内容。
- 当前客户端会话需重新加载 MCP 才能发现新增入口；HTTP 验收不等同于所有第三方客户端均已验证。

本轮手动分发产物：`zotero-mcp-plus-0.1.0.xpi`（构建原名 `zotero-mcp-plus.xpi`），273825 bytes。SHA256：

```text
a60b12838c9fd21efaac2436b16af9db4cffc77485c52aaecaa4d50cf96cba33
```

构建时间参与包内容，重新构建的 SHA256 可能不同；以上摘要仅对应本轮已安装及待分发的产物。

## 未验证范围与限制

- 尚未验证其他操作系统或其他 Zotero 版本，不将 7–10 全系列列为已支持。
- 恢复集成测试是 sidecar 关闭重开及 checkpoint 窗口模拟，**不是实际断电或 OS 强杀测试**；原生创建 parent 后挂接前的复杂故障主要由 fixture 覆盖。
- 受保护/无 OCR PDF、各类离线网络异常和所有原生队列交互未逐一进行真实端到端验证。原生识别成功率不能由一个公开样例推断。
- 未全面验证继承的所有语义模型 Provider、所有第三方 MCP 客户端和远程 translator；不会因此复制旧模型密钥或启用语义功能。
- 未做大规模长期容量/性能测试，账本目前不自动清理历史。账本包含私有参数与状态快照，诊断或备份对外分享前仍须脱敏。
- 不承诺跨插件全局互斥、两库原子提交、exactly-once 或通用 undo。未知结果保守停止而不是自动重试。
- 源码和手动安装包的发布状态以本项目 GitHub 仓库及 Releases 为准；不提供在线自动更新。本轮没有执行真实文库批量整理。
