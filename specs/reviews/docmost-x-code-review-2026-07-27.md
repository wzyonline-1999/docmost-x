# Docmost-X 全量代码审查与修复复核报告

> 日期：2026-07-27
> 审查分支：`agent/mcp-api-unified`
> 审查基线：`5b643c8d`
> 复核对象：当前未提交工作区
> 审查性质：全量找问题、按多实例推荐方案修复与本地复核；不部署、不提交、不推送

## 1. 结论摘要

本轮没有发现能够直接证明为“越权读取其他知识库”或“任意代码执行”的 P0 问题。原始审查记录了 `27` 项问题；按未来多实例部署作为硬约束完成修复后，当前状态为：

| 状态       | 数量 | 含义                                                       |
| ---------- | ---: | ---------------------------------------------------------- |
| 已解决     |   21 | 代码、测试和本地验证已经闭环                               |
| 已缓解     |    5 | 主要风险已受控，但受跨存储原子性、进程隔离或外部审计限制   |
| 外部待验证 |    1 | 需要匿名化生产快照和生产规模迁移演练，无法仅靠本地新库证明 |
| 合计       |   27 | 每项状态见后文                                             |

当前版本已经具备 RC 候选质量，但在公司级生产发布前仍需完成两项外部动作：

1. 使用匿名化生产快照执行 `ops/deployment/mcp-production-preflight.sql` 和完整迁移演练，记录锁等待、耗时、空间峰值与受影响客户端数。
2. 通过 GitHub Dependency Review 或获准的外部依赖审计确认更新后的 lockfile；本轮没有主动执行会向 npm 发送私有依赖元数据的 `pnpm audit --prod`。

仍需明确保留的工程边界：

1. PostgreSQL 页面元数据与 Yjs 内容无法成为单一数据库事务；当前用强制版本、幂等、补偿和修复记录降低风险。
2. 页面内容进程内事件在持久化向量任务前仍有极窄的崩溃窗口，周期恢复只能最终修复。
3. 附件解析超时不能终止底层 CPU 工作；当前已有文件、页数、归档和时间限制，真正隔离需后续独立解析进程。
4. 覆盖已有对象的附件更新若在对象写入后数据库更新失败，仍可能出现存储内容与元数据短暂不一致。

## 2. 代码来源分层

本报告没有把“相对官方上游的所有差异”都视为缺陷。审查时使用以下四层来源：

| 标签         | 基线/范围                                                                   | 说明                                                      |
| ------------ | --------------------------------------------------------------------------- | --------------------------------------------------------- |
| `官方原生`   | `refs/review/upstream-v0.95.0` / `4132dd597c956a27423607d008708c0e214690da` | Docmost v0.95.0 官方代码                                  |
| `社区化基线` | `55878a21`                                                                  | 移除商业模块后的社区版基线和 OSS 空实现                   |
| `早期二开`   | 以 `325d55ba` 为核心                                                        | MCP、权限、向量、历史版本、附件等第一阶段能力             |
| `近期新增`   | `325d55ba..5b643c8d`                                                        | 客户端归属、有效权限、目录范围搜索、MCP/API 统一和近期 UI |

当前分支相对官方基线共有 `655` 个文件变化、`38161` 行新增、`44184` 行删除。大量删除来自商业模块社区化，不应当单独判定为功能回归。

## 3. 验证矩阵

| 验证项                  | 结果       | 说明                                                                     |
| ----------------------- | ---------- | ------------------------------------------------------------------------ |
| 最终多实例定向测试      | 通过       | `3` 个 suite，`17` 个测试                                                |
| MCP SDK 兼容测试        | 通过       | 真实 SDK、真实回环 HTTP 监听                                             |
| 前端 Vitest             | 通过       | `16` 个文件，`113` 个测试                                                |
| 服务端完整 Jest         | 通过       | `65` 个 suite，`620` 个测试                                              |
| 扩展质量测试            | 通过       | `35` 个 suite，`415` 个测试                                              |
| 多实例安全与协调覆盖率  | 通过       | 行 `94.07%`，分支 `84.83%`                                               |
| MCP 外部边界与持久任务  | 通过       | 行 `76.09%`，分支 `73.88%`                                               |
| Web 搜索覆盖率          | 通过       | 行 `75.41%`，分支 `71.19%`                                               |
| 附件生命周期覆盖率      | 通过       | 行 `55.18%`，分支 `71.95%`                                               |
| 服务端 TypeScript       | 通过       | `tsc --noEmit`                                                           |
| 客户端 TypeScript       | 通过       | `tsc --noEmit`                                                           |
| 精确 CI ESLint          | 通过       | 服务端与客户端目标路径                                                   |
| 生产构建                | 通过       | 三个项目完全无缓存构建                                                   |
| 前端 bundle 预算        | 通过       | 初始 JS `390.7 KiB gzip`；初始 CSS `34.5 KiB gzip`                       |
| 最大异步 JS 预算        | 通过       | `718.8 KiB gzip`                                                         |
| 数据库迁移演练          | 通过       | `latest -> down x8 -> latest`，基础数据保留                              |
| 数据库结构复核          | 通过       | `30` 个索引、`23` 个约束、暴露角色授权为 `0`、过滤 HNSW 顺序正确         |
| CycloneDX SBOM          | 通过       | `1,210` 个生产组件                                                       |
| Workflow YAML 解析      | 通过       | 两条 MCP workflow 均可解析                                               |
| 跟踪/未跟踪文件密钥扫描 | 通过       | 未发现 API Key、私钥或生成的 MCP Token                                   |
| `git diff --check`      | 通过       | 未发现空白符错误                                                         |
| 精确 CI Prettier        | 通过       | workflow 目标范围                                                        |
| 外部生产依赖审计        | 待外部确认 | 已升级已知受影响版本；GitHub Dependency Review 已配置，本地 audit 未发网 |

补充说明：

- 最初 SDK 测试失败是沙箱禁止本地 `listen` 导致的 `EPERM`；允许回环监听后通过，不属于产品缺陷。
- 迁移演练使用临时 PostgreSQL/pgvector，不能替代真实旧版本大数据量升级演练。
- `pgvector/pgvector:pg18` 仍为浮动 tag。Docker Hub manifest 查询超时，本机可见 digest 为 ARM64，不能错误固定到 AMD64 GitHub Actions。
- 当前验证未执行真实高并发、多副本长时间 soak 或故障注入。

### 3.1 修复状态总览

| 编号 | 当前状态   | 复核结论                                                                |
| ---- | ---------- | ----------------------------------------------------------------------- |
| F-01 | 已缓解     | 已升级已知脆弱依赖并加入 Dependency Review/SBOM；外部 audit 待确认      |
| F-02 | 已解决     | 批量上限、受控并发和 Redis 分布式限流已落地                             |
| F-03 | 已解决     | MCP/API 共用 AJV 运行时 Schema 校验                                     |
| F-04 | 已缓解     | 写入强制幂等与乐观版本；跨 PostgreSQL/Yjs 仍不能真正原子                |
| F-05 | 已解决     | 上传失败补偿删除并重新抛错；新增孤儿清理兜底                            |
| F-06 | 已解决     | Token 使用时间节流，限流顺序与多副本语义已修正                          |
| F-07 | 已解决     | JSON-RPC/MCP 边界校验与真实 SDK 兼容测试已补齐                          |
| F-08 | 已解决     | 写操作强制幂等，加入续租、恢复与人工修复管理                            |
| F-09 | 已解决     | 父子向量任务持久化，父任务按子任务最终状态聚合                          |
| F-10 | 已缓解     | 周期任务恢复和数据库触发资格重算已加入；事件落库前仍有窄崩溃窗口        |
| F-11 | 已解决     | 向量、任务、审计和幂等数据保留策略已加入                                |
| F-12 | 已解决     | 搜索状态、长度/速率保护和附件来源元数据已补齐                           |
| F-13 | 已解决     | MCP 与 Vector Search 开关已拆分                                         |
| F-14 | 已解决     | 数值配置范围和组合约束启动时 fail-fast                                  |
| F-15 | 已缓解     | 索引租约/恢复及文件边界已加入；解析 CPU 真隔离仍待独立进程              |
| F-16 | 已解决     | 附件删除状态机与幂等 not-found 语义已实现                               |
| F-17 | 已解决     | OSS 能力探测恢复附件搜索入口                                            |
| F-18 | 已解决     | 数据库 CHECK/复合完整性约束及发布前预检查已加入                         |
| F-19 | 已解决     | 仅信任明确代理并覆盖不可信转发头                                        |
| F-20 | 已解决     | Token 哈希支持 current/previous secret 平滑轮换                         |
| F-21 | 已解决     | CI 路径、前端测试、扩展覆盖率和格式门禁已补齐                           |
| F-22 | 已缓解     | RC 依赖质量 workflow、Action/运行镜像已固定；pgvector digest 待外部确认 |
| F-23 | 已解决     | 全局指标使用 Redis 多副本快照，查询、保留和 Grafana 聚合已调整          |
| F-24 | 已解决     | 大工作区名称按 ID 批量解析，不依赖固定第一页                            |
| F-25 | 已解决     | 搜索筛选同步外部空间变化并修复大空间名称解析                            |
| F-26 | 已解决     | 路由懒加载、废弃配置清理和 gzip bundle 预算已加入                       |
| F-27 | 外部待验证 | 本地历史链路演练和预检查已加强；仍需生产快照验证锁与耗时                |

## 4. P1 问题

### F-01 生产依赖存在 11 个高危安全公告

- **复核状态**：已缓解。已知受影响版本已升级，CI 已加入 Dependency Review 和 SBOM；完整外部审计仍待确认。
- **来源**：混合，主要来自官方依赖基线和当前 `pnpm-lock.yaml`
- **位置**：`pnpm-lock.yaml`；命令 `pnpm audit --prod --audit-level high`
- **触发条件**：对应依赖路径可被外部请求、恶意 URL、HTTP/2、轮询连接或特殊输入触达。
- **影响**：可能导致路由保护绕过、连接耗尽、算法复杂度 DoS、代理继承错误或主机解析混淆。部分前端公告需要结合实际使用模式确认可达性，但服务端 Fastify、Engine.IO 和路由器路径属于优先核查对象。
- **证据**：
  - `@fastify/static@9.1.3`：`GHSA-83w8-p2f5-377r`，路径遍历导致 route guard bypass。
  - `find-my-way@9.6.0`：`GHSA-c96f-x56v-gq3h`，HTTP/2 DDoS。
  - `engine.io@6.6.2`：`GHSA-r635-g3xr-vw7x`，Polling Transport 连接耗尽。
  - `fast-uri@3.1.2`：`GHSA-v2hh-gcrm-f6hx`、`GHSA-4c8g-83qw-93j6`。
  - `axios@1.16.0`：`GHSA-gcfj-64vw-6mp9`。
  - `brace-expansion@5.0.6`：`GHSA-3jxr-9vmj-r5cp`、`GHSA-mh99-v99m-4gvg`。
  - `immutable@4.3.8`：`GHSA-v56q-mh7h-f735`、`GHSA-xvcm-6775-5m9r`。
  - `react-router@7.18.0`：`GHSA-qwww-vcr4-c8h2`。
- **测试空白**：当前 CI 没有依赖审计、SBOM、公告例外清单或可达性分析。
- **建议方向**：先升级直接依赖和 lockfile；对暂时无法升级的传递依赖建立带截止时间的例外清单，并对服务端高危路径做可达性验证和回归测试。

### F-02 单个 Token 可通过无限批处理放大数据库并发

- **复核状态**：已解决。批量数量、总成本、并发度和 Redis 分布式限流均已落地。
- **来源**：早期二开
- **位置**：
  - `apps/server/src/core/mcp/mcp.controller.ts:42-59`
  - `apps/server/src/core/mcp/mcp.controller.ts:178-186`
  - `apps/server/src/core/mcp/services/mcp-rate-limit.service.ts:12-46`
- **触发条件**：持有一个有效 MCP Token，向 `/mcp` 发送包含大量条目的 JSON-RPC batch。
- **影响**：服务会用 `Promise.all` 同时处理全部条目；每个条目先查 Token、更新 `lastUsedAt`，之后才执行进程内限流。即使绝大多数条目最终被限流，数据库鉴权和写入成本已经发生。多副本部署时每个副本还有独立限流桶，实际限额按副本数放大。
- **证据**：批数组没有数量或请求体条目上限；`body.map(...handleRequest)` 直接并发；限流桶是进程内 `Map`。
- **测试空白**：没有超大 batch、并发 batch、多副本限流一致性或数据库负载测试。
- **建议方向**：限制 batch 数量和总请求体；使用受控并发；把限流前置到数据库触碰之前；生产环境使用 Redis/网关级分布式限流。

### F-03 对外 JSON Schema 与实际运行时校验不一致

- **复核状态**：已解决。MCP 与 Developer API 现在执行同一套 AJV Schema 和边界约束。
- **来源**：早期二开与近期 MCP/API 统一代码
- **位置**：
  - `apps/server/src/core/mcp/services/mcp-tool.service.ts:138-563`
  - `apps/server/src/core/mcp/services/mcp-tool.service.ts:566-760`
  - `apps/server/src/core/mcp/services/mcp-tool.service.ts:3126-3210`
  - `apps/server/src/core/mcp/developer-api.controller.ts:164-197`
- **触发条件**：调用方传入额外字段、非法 UUID、超长 `idempotencyKey`、超长 `spaceIds` 数组或超出 Schema 范围的数值。
- **影响**：
  - `additionalProperties: false` 只被声明，没有在运行时执行。
  - 多数 UUID 仅检查为非空字符串，非法值会进入 PostgreSQL UUID 比较并可能变成 500。
  - limit 超界时被静默 clamp，而不是按已声明 Schema 拒绝，客户端难以发现配置错误。
  - `spaceIds` 没有元素数量上限，可放大权限查询和 SQL `IN`。
  - Developer API 只限制 Header 中的幂等键；请求体直接提供的 `idempotencyKey` 可绕过 200 字符上限。
  - 幂等键落在唯一索引中，极长字符串可能引起索引行过大或存储放大。
- **证据**：`callTool` 把 `arguments` 交给手写的 `requireString`、`optionalStringArray`、`getNamedLimit`；没有 AJV 或同等 Schema 校验器。
- **测试空白**：没有 Schema 与运行时行为一致性测试、随机输入测试、非法 UUID 测试、超长幂等键和超大数组测试。
- **建议方向**：编译并执行同一份 JSON Schema；所有入口统一复用校验器；为 UUID、字符串、数组、Base64、幂等键和对象字段数设置明确上限。

### F-04 页面元数据与 Yjs 内容写入非原子，且仍允许盲写

- **复核状态**：已缓解。写操作已强制幂等键和期望版本，并加入补偿/修复记录；跨 PostgreSQL/Yjs 的单事务原子性仍不可实现。
- **来源**：官方页面写链路与早期二开写工具的混合问题
- **位置**：
  - `apps/server/src/core/page/services/page.service.ts:250-333`
  - `apps/server/src/core/mcp/services/mcp-tool.service.ts:1210-1285`
  - `apps/server/src/core/mcp/services/mcp-tool.service.ts:1300-1390`
- **触发条件**：页面元数据更新成功后，Yjs 内容持久化失败、并发修改发生，或 MCP 调用未提供 `expectedUpdatedAt`。
- **影响**：
  - 元数据和内容跨两套持久化过程，失败时依靠补偿更新；补偿自身也可能因并发冲突失败，最终返回“需要修复”。
  - `update_page` 的 `expectedUpdatedAt` 是可选项，`append_page` 完全没有期望版本，存在覆盖并发编辑的可能。
  - 历史快照在乐观锁校验之前创建；最终写冲突时可能留下并未真正对应一次成功修改的历史记录。
- **证据**：`pageService.update` 先更新 page 行，再写内容，catch 中再做条件回滚；MCP 在调用更新前先 `capturePageSnapshot`。
- **测试空白**：缺少真实 PostgreSQL + Yjs 持久化故障注入、补偿失败、并发 append、快照与失败写一致性测试。
- **建议方向**：要求 MCP 更新和追加默认携带版本；用操作记录/事务外盒协调两类持久化；把快照与成功提交绑定，或为失败快照建立明确清理状态。

### F-05 官方附件上传会吞掉落库错误并遗留存储对象

- **复核状态**：已解决。创建上传路径会补偿删除对象并重新抛错，且有孤儿清理兜底。
- **来源**：官方原生，已与上游 v0.95.0 对照；MCP 新增的 `uploadBufferFile` 路径反而做了补偿删除
- **位置**：`apps/server/src/core/attachment/services/attachment.service.ts:109-143`
- **触发条件**：对象存储上传成功后，附件数据库插入、更新或后续索引排队发生异常。
- **影响**：异常只被记录，方法返回可能为 `null`；注释声称删除已上传文件，但实际没有调用删除。客户端可能看到模糊失败，存储中则留下没有数据库记录的孤儿对象。
- **证据**：catch 只有 `this.logger.error(err)`，随后直接 `return attachment`。
- **测试空白**：没有原生 multipart 上传在数据库故障、队列故障和存储清理失败下的集成测试。
- **建议方向**：原生路径与 MCP buffer 路径统一为“落库失败即删除对象并重新抛错”；增加孤儿对象周期扫描作为最终兜底。

## 5. P2 问题

### F-06 每次鉴权都写 Token 热行，且发生在限流之前

- **复核状态**：已解决。使用时间更新已节流，限流和鉴权顺序按成本与多副本语义调整。
- **来源**：早期二开
- **位置**：
  - `apps/server/src/core/mcp/services/mcp-token.service.ts:105-174`
  - `apps/server/src/core/mcp/mcp.controller.ts:178-186`
- **触发条件**：任何有效 Token 请求，包括随后会被限流的请求。
- **影响**：每次请求都更新 `lastUsedAt` 和 `updatedAt`，形成单 Token 热行和 WAL/复制放大；被限流的请求也会显示为“最近成功使用”；touch 失败被吞掉，界面时间还可能失真。
- **证据**：`authenticateToken` 在返回前无条件 `touchLastUsed`，controller 随后才 `assertWithinLimit`。
- **测试空白**：没有高 QPS Token、数据库锁等待、WAL 增量或限流时间语义测试。
- **建议方向**：先限流；把 last-used 更新做成按分钟节流的异步合并写，必要时单独记录 `lastAttemptAt` 与 `lastSuccessAt`。

### F-07 JSON-RPC/MCP 协议边界不完整

- **复核状态**：已解决。请求、通知、batch、错误状态和 SDK 兼容矩阵已补齐。
- **来源**：早期二开
- **位置**：`apps/server/src/core/mcp/mcp.controller.ts:42-239`
- **触发条件**：空 batch、缺少 `jsonrpc`、非法 `id` 类型、未知 notification、认证失败或协议版本不一致。
- **影响**：
  - 缺少 `jsonrpc` 仍被接受。
  - `id` 的运行时类型未校验。
  - 空 batch 返回 `202` 且无 body，而 JSON-RPC 应返回 invalid request。
  - 未支持的 notification 会被 catch 成带 `id: null` 的错误响应，notification 本不应收到响应。
  - 鉴权和限流错误被统一包装成 HTTP 200，代理和调用方难以使用正常的 401/403/429 语义。
  - `initialize` 不协商客户端版本，并硬编码服务版本 `0.1.0`。
- **测试空白**：SDK 测试只覆盖基础成功路径，没有完整 JSON-RPC 2.0 和 MCP Streamable HTTP 兼容矩阵。
- **建议方向**：按 JSON-RPC 2.0 和当前 MCP 规范建立协议层 DTO/验证器；区分传输层错误和工具执行错误；补协议一致性测试集。

### F-08 幂等保护可选，长任务租约可能过期并永久卡在修复态

- **复核状态**：已解决。变更操作强制幂等，执行中续租，并提供恢复、查询和人工修复管理。
- **来源**：早期二开
- **位置**：
  - `apps/server/src/core/mcp/services/mcp-idempotency.service.ts:62-68`
  - `apps/server/src/core/mcp/services/mcp-idempotency.service.ts:184-224`
  - `apps/server/src/core/mcp/services/mcp-idempotency.service.ts:473-512`
- **触发条件**：调用方不传幂等键；一次写操作超过固定五分钟租约；进程在已产生副作用后崩溃；自动 reconcile 失败。
- **影响**：
  - 不传 key 时所有幂等和恢复能力直接绕过。
  - 执行期间没有 heartbeat，正常长任务也可能被维护任务标记为 `needs_reconciliation`。
  - `needs_reconciliation` 和 `repair_required` 不会过期，也没有完整管理入口；清理只删除 completed 或已软删记录。
  - 长期运行后可能堆积无法自动消除的记录和重复执行冲突。
- **测试空白**：没有租约跨越、原执行仍在运行时被接管、多副本争抢、永久修复态运维流程测试。
- **建议方向**：对变更类 API 默认要求幂等键；执行中续租；建立可查询、重试、确认和清理的管理状态机。

### F-09 向量批任务在子任务完成前就报告成功

- **复核状态**：已解决。父子任务关系已持久化，父任务按子任务最终结果聚合并可恢复。
- **来源**：早期二开
- **位置**：
  - `apps/server/src/core/mcp/services/mcp-vector-index.service.ts:677-799`
  - `apps/server/src/core/mcp/services/mcp-vector-index.service.ts:1215-1273`
- **触发条件**：空间或工作区批量重建索引。
- **影响**：
  - 父任务的 `succeeded` 只表示子任务已排队，不代表页面已完成向量化。
  - `stats.pageJobIds` 保存全部子 UUID，空间越大 JSON 行越大，更新和读取成本持续增长。
  - 取消操作依赖父任务已经持久化的 ID 列表；排队与取消并发时可能漏掉刚创建的子任务。
- **测试空白**：没有超大空间、子任务失败聚合、排队中取消、父子最终状态一致性测试。
- **建议方向**：拆分 `queued_children` 与 `completed` 状态；用父 ID 外键查询子任务，不在 JSON 中保存完整数组；取消按 parentJobId 原子更新。

### F-10 向量事件与队列恢复不是完全持久化链路

- **复核状态**：已缓解。已加入周期任务恢复和数据库触发的资格重算；事件产生到持久任务落库之间仍存在极窄崩溃窗口。
- **来源**：早期二开与近期权限代码
- **位置**：
  - `apps/server/src/core/mcp/services/mcp-vector-index.listener.ts:45-75`
  - `apps/server/src/core/mcp/services/mcp-vector-index.service.ts:1275-1300`
  - `apps/server/src/core/mcp/services/mcp-admin.service.ts:1019-1044`
- **触发条件**：进程在事件发出后崩溃、BullMQ 暂时不可用、原生成员/页面 ACL 变化、用户被停用，或权限变更后的 reconcile 失败。
- **影响**：
  - EventEmitter 是进程内事件，enqueue 失败只记日志，事件本身会丢失。
  - 已落库但 BullMQ 入队失败的任务主要依赖进程启动恢复，长期不重启时可能一直滞留。
  - 原生成员和 ACL 变化没有完整触发向量资格重算，历史 chunk 可能继续存在或新内容没有索引。
  - MCP 管理端 reconcile 异常被记录后吞掉，权限 API 仍返回成功。
- **测试空白**：没有 Redis 故障恢复、进程崩溃窗口、原生 ACL/用户状态变化到 chunk 可见性的端到端测试。
- **建议方向**：使用事务外盒或可重放事件；增加周期 queue sweeper；把所有 ACL/成员生命周期事件接入统一 eligibility reconciler。

### F-11 旧模型向量和历史运维数据没有保留策略

- **复核状态**：已解决。向量、任务、审计和幂等记录均有可配置保留及清理任务。
- **来源**：早期二开
- **位置**：`apps/server/src/core/mcp/services/mcp-vector-index.service.ts:939-949,1072-1154`
- **触发条件**：切换 `EMBEDDING_MODEL`、长期重建索引、任务持续运行、页面频繁变化。
- **影响**：读写只针对当前模型；旧模型 chunk 不再被查询，但仍占用向量存储和索引空间。审计日志、索引任务和软删除 chunk 也没有统一保留策略，数据库会持续膨胀。
- **证据**：查询和软删除均带当前 `embeddingModel` 条件；未找到旧模型清理或任务/审计归档任务。
- **测试空白**：没有模型切换、长期容量增长、清理与回滚演练。
- **建议方向**：引入模型版本清单和 active/retired 生命周期；按时间和状态清理 chunk、任务、审计与幂等记录，并暴露容量指标。

### F-12 原生智能搜索“可用”状态失真，资源保护不足

- **复核状态**：已解决。可用状态、查询长度、分布式成本限流和附件来源元数据已补齐。
- **来源**：早期向量能力与近期目录搜索
- **位置**：
  - `apps/server/src/core/search/search.service.ts:249-344`
  - `apps/server/src/core/search/search.service.ts:346-550`
  - `apps/server/src/core/search/dto/search.dto.ts:14-18`
  - `apps/server/src/core/search/search.controller.ts:75-99`
- **触发条件**：环境开关已开但索引尚未就绪；发送很长查询；高频调用 semantic/hybrid；命中附件文本 chunk。
- **影响**：
  - `semanticAvailable` 只反映配置开关，不反映当前模型是否有可用 chunk、队列是否健康或 provider 是否可用。
  - Web 搜索 query 没有最大长度，semantic 每次都产生外部 embedding 调用，controller 没有对应成本限流。
  - 原生搜索结果从 chunk 映射回 page 时丢失附件来源元数据，用户无法判断命中的是正文还是某个附件。
- **测试空白**：没有“开关开启但零索引”、provider 降级、超长 query、成本限流和附件来源展示测试。
- **建议方向**：把 enabled、ready、degraded 分开；统一查询长度和速率限制；在结果中保留 `sourceType/attachmentId/fileName`。

### F-13 原生向量搜索被错误绑定到 MCP 总开关

- **复核状态**：已解决。MCP、Vector Search 和相关后台任务已按职责拆分开关。
- **来源**：早期二开
- **位置**：`apps/server/src/integrations/environment/environment.service.ts:334-340`
- **触发条件**：希望关闭外部 MCP 接口，但继续使用网页端智能搜索。
- **影响**：`MCP_ENABLED=false` 会让 `isVectorSearchEnabled()` 一并返回 false，网页搜索和自动索引也被关闭。两个产品能力无法独立运维或缩小暴露面。
- **测试空白**：没有 MCP 关闭、网页向量搜索开启的配置矩阵测试。
- **建议方向**：拆分 `MCP_ENABLED`、`VECTOR_SEARCH_ENABLED` 和自动索引开关；只让 MCP controller 依赖 MCP 开关。

### F-14 数值环境变量只有“是数字”校验，没有可运行范围

- **复核状态**：已解决。数值配置增加上下限与组合约束，非法配置在启动时失败。
- **来源**：早期二开
- **位置**：
  - `apps/server/src/integrations/environment/environment.validation.ts:121-226`
  - `apps/server/src/integrations/environment/environment.service.ts:300-415`
- **触发条件**：配置为 `0`、极大值、负数形式或不可解析但能绕过字符串校验的值。
- **影响**：
  - `VECTOR_CHUNK_MAX_CHARS=0` 会在后续逻辑中退化为近似单字符 chunk，可能创建海量向量。
  - 极大 batch、timeout、retry 和候选数会拖垮 worker 或 provider。
  - `MCP_READ_AUDIT_SAMPLE_RATE` 只做 `IsString`；非数字变成 `NaN`，比较语义可能意外退化为几乎全量审计。
- **测试空白**：没有启动配置边界表、非法组合或资源上限测试。
- **建议方向**：在启动时用整数/浮点 DTO 加 `Min/Max` 和交叉字段约束；解析后再次做 fail-fast 校验。

### F-15 附件内容索引失败可能永久漏索引，复杂文件解析缺少资源隔离

- **复核状态**：已缓解。加入持久状态、租约、周期恢复、超时及归档/页数限制；超时不能强制终止同进程 CPU 工作。
- **来源**：早期二开
- **位置**：
  - `apps/server/src/core/attachment/services/attachment.service.ts:179-209`
  - `apps/server/src/core/attachment/services/attachment-content-index.service.ts:14-106`
- **触发条件**：索引队列短暂失败；上传 25 MiB 内但高度压缩或结构复杂的 PDF/DOCX。
- **影响**：
  - MCP 上传成功后，`queueContentIndex` 失败只告警，没有周期扫描重新发现 `textContent` 尚未提取的附件。
  - PDF/DOCX 会先完整读入内存并完整解析，之后才截断到 50 万字符；压缩炸弹或复杂文档可能造成高 CPU/内存占用。
- **测试空白**：没有队列中断后补偿扫描、压缩比、解析超时、worker 内存上限或恶意文档样本。
- **建议方向**：附件索引使用独立受限 worker、超时和内存/页数限制；增加未索引附件 reconciler 和明确失败状态。

### F-16 附件删除顺序可留下不可恢复的半完成状态

- **复核状态**：已解决。删除使用可恢复状态机，对象不存在按幂等成功处理。
- **来源**：官方附件模型与早期二开删除接口的混合问题
- **位置**：
  - `apps/server/src/core/attachment/services/attachment.service.ts:213-224`
  - `apps/server/src/integrations/storage/drivers/azure.driver.ts:167-174`
- **触发条件**：对象存储删除成功后数据库删除失败；随后重试，且驱动对“对象不存在”抛错。
- **影响**：数据库仍显示附件，但对象已经不存在；重试可能在存储删除处重复失败，无法推进数据库清理。
- **测试空白**：没有“存储成功、DB 失败、再次重试”的跨驱动集成测试。
- **建议方向**：先将数据库标记为 deleting，再幂等删除对象，最后完成记录删除；所有存储驱动把 not-found 视为成功。

### F-17 社区版功能空实现导致附件搜索在前端永远隐藏

- **复核状态**：已解决。社区版按服务能力启用已实现功能，并有真实 hook 测试。
- **来源**：社区化基线与二开能力集成冲突
- **位置**：
  - `apps/client/src/oss/hooks/use-feature.ts:1-3`
  - `apps/client/src/features/search/components/search-spotlight-filters.tsx:57-60,103-109`
  - `apps/client/src/features/search/hooks/use-unified-search.ts:34-38`
- **触发条件**：社区版运行任何页面搜索。
- **影响**：`useHasFeature` 永远返回 false，因此 `Feature.ATTACHMENT_INDEXING` 选项一直禁用；后端已经实现的附件提取和向量索引无法从原生 UI 使用。
- **测试空白**：测试通过 mock feature 值覆盖分支，没有验证 OSS 真实 feature provider。
- **建议方向**：社区版使用服务器能力探测或公开配置，不再把已开源实现的附件索引硬编码为商业功能 false。

### F-18 客户端归属完整性主要依赖服务代码，数据库约束不足

- **复核状态**：已解决。数据库约束、迁移检查和发布前只读预检查均已加入。
- **来源**：近期新增
- **位置**：
  - `apps/server/src/database/migrations/20260725T100000-mcp-client-ownership.ts:3-47`
  - `apps/server/src/database/migrations/20260726T120000-mcp-client-ownership-hardening.ts:3-30`
- **触发条件**：未来新代码、脚本、人工 SQL 或迁移绕过服务层，写入不一致的 scope/owner/actor；历史数据进入 hardening 迁移。
- **影响**：
  - 数据库只检查 scope 枚举，没有约束 personal 必须有 owner、personal actor 必须等于 owner、workspace owner 必须为空。
  - 权限、chunk、job 表中重复保存 workspace/client/space/page ID，但没有足够复合外键保证它们属于同一工作区。
  - hardening 会把修复过 actor 的 active personal client 直接禁用；这是安全的 fail-closed 行为，但发布时会产生用户可见失效。
- **测试空白**：没有绕过 service 的约束测试、生产历史数据预扫描或迁移影响统计。
- **建议方向**：增加数据库 CHECK/复合外键；发布前运行只读预检查，列出会被禁用的客户端并准备通知和重新发 Token 流程。

### F-19 无条件信任代理使审计 IP 可被伪造

- **复核状态**：已解决。应用使用显式代理 allowlist，Nginx 示例覆盖不可信转发头。
- **来源**：官方原生
- **位置**：
  - `apps/server/src/main.ts:18-28`
  - `ops/deployment/nginx/docmost-mcp.conf.example:32-35,46-48,52-56`
- **触发条件**：应用只经过当前示例 Nginx，外部请求自行携带 `X-Forwarded-For`。
- **影响**：Fastify `trustProxy: true` 信任整个转发链，Nginx 又使用 `$proxy_add_x_forwarded_for` 保留客户端自带 XFF。MCP 审计日志中的来源 IP 可被伪造，影响追责和异常检测。当前没有证据表明该 IP 参与授权，因此主要是审计完整性风险。
- **测试空白**：没有带伪造 XFF 的反向代理集成测试。
- **建议方向**：应用只信任明确代理地址/跳数；边缘代理覆盖而不是追加不可信 XFF，或先清洗再写入标准头。

### F-20 Token 哈希密钥无法平滑轮换

- **复核状态**：已解决。验证支持 current/previous secret 重叠窗口及渐进轮换。
- **来源**：早期二开
- **位置**：`apps/server/src/core/mcp/services/mcp-token.service.ts:43-62,105-123`
- **触发条件**：轮换 `MCP_TOKEN_HASH_SECRET`。
- **影响**：数据库只保存 HMAC 结果，切换 Secret 后所有现有客户端立即无法匹配；没有 previous-secret 重叠期、版本字段或重新哈希机制。
- **测试空白**：没有 Secret 轮换演练和多版本验证测试。
- **建议方向**：保存 hash key version；验证时允许 current + previous，逐步重新签发或迁移后再移除旧密钥。

### F-21 CI 路径、前端测试和覆盖率门禁存在明显盲区

- **复核状态**：已解决。路径、前端测试、扩展覆盖率、格式和门禁自检均已补齐。
- **来源**：早期二开与近期新增
- **位置**：
  - `.github/workflows/mcp-quality.yml:3-23,75-141`
  - `apps/server/test/mcp-coverage-gate.ts:5-15,36-74`
- **触发条件**：只修改搜索、附件、20260725/26 归属迁移或相关前端测试；关键 controller/tool/vector 代码覆盖率下降。
- **影响**：
  - workflow 路径不包含 `apps/client/src/features/search/**`、`apps/server/src/core/search/**`、附件路径和 20260725/26 migration。
  - CI 没有执行 `pnpm --filter client test`。
  - 覆盖率门禁只统计 7 个 service，controller、tool execution、admin、vector jobs、attachments、metrics 均不受阈值保护。
  - 当前 Prettier 已确认失败：
    - `apps/server/src/core/mcp/developer-api.controller.spec.ts`，已被 workflow 包含，会直接让质量门禁失败。
    - `apps/client/src/features/search/components/share-search-spotlight.tsx`，未被 workflow 覆盖。
    - `apps/client/src/features/search/constants.ts`，未被 workflow 覆盖。
- **测试空白**：门禁自身没有触发范围测试，也没有检查关键文件是否被 coverage summary 纳入。
- **建议方向**：按能力而非历史日期列路径；运行完整 client test；扩大覆盖率目标文件；增加 workflow/path lint。

### F-22 RC 镜像可以绕过质量门禁，构建输入也未完全固定

- **复核状态**：已缓解。RC 已依赖可复用质量流程，Action 和可移植运行镜像已固定；pgvector 多架构 digest 仍待外部 registry 确认。
- **来源**：二开运维代码
- **位置**：
  - `.github/workflows/mcp-rc-image.yml:1-68`
  - `Dockerfile:1-4`
  - `ops/deployment/compose.mcp.yml:29-43`
- **触发条件**：直接打 RC tag 或手工执行镜像 workflow；上游镜像 tag 内容发生变化。
- **影响**：
  - RC workflow 不运行测试，也不依赖 `mcp-quality` 成功，就能发布 prerelease artifact。
  - job 拥有仓库级 `contents: write`，权限范围大于构建阶段所需。
  - `node:22-slim`、`redis:8-alpine`、`pgvector/pgvector:pg18` 都是浮动 tag，同一提交在不同时间可能得到不同镜像内容。
  - GitHub Actions 只固定 major tag，没有固定 commit SHA。
- **测试空白**：没有产物 provenance、SBOM、镜像漏洞扫描或“质量门禁成功后才发布”的集成验证。
- **建议方向**：RC workflow 依赖可复用 quality job；最小化 permissions；固定镜像 digest 和 Action SHA；生成 SBOM、签名和漏洞报告。

### F-23 指标刷新和 Grafana 查询在多副本/长期运行下会失真并放大数据库负载

- **复核状态**：已解决。全局指标由 Redis 窗口快照协调，保留策略、查询和 dashboard 聚合已调整。
- **来源**：早期二开
- **位置**：
  - `apps/server/src/core/mcp/services/mcp-metrics.service.ts:138-176`
  - `ops/monitoring/grafana/docmost-mcp-dashboard.json:57,114`
- **触发条件**：多应用副本、任务和幂等表长期增长、Prometheus 同时抓取所有副本。
- **影响**：
  - 每个副本每 15 秒都对全局 job/idempotency 表分组扫描。
  - Prometheus counter 是进程本地值，而 DB gauge 是每个副本重复输出的同一全局值。
  - Grafana 对 gauge 使用原始表达式，没有按 instance 去重或聚合，图表会重复计数。
  - 缺少 job 保留策略后，周期查询成本持续上升。
- **测试空白**：没有多副本指标语义、百万任务行查询计划和 dashboard 聚合测试。
- **建议方向**：全局 gauge 由单独 exporter/leader 计算；为统计查询建立合适索引或汇总表；Grafana 明确按 instance 聚合；落实数据保留。

## 6. P3 问题

### F-24 大工作区中客户端持有者和权限对象名称可能显示错误

- **复核状态**：已解决。按实际 ID 批量解析名称，不再依赖固定首页数据。
- **来源**：近期新增
- **位置**：
  - `apps/client/src/features/mcp/components/mcp-client-list.tsx:73-87`
  - `apps/client/src/features/mcp/components/mcp-permissions.tsx:166-179`
- **触发条件**：工作区成员超过 100，目标用户不在第一页。
- **影响**：界面只能用 fallback ID/未知名称展示，管理员容易误判 Token 持有者或分配对象。
- **测试空白**：没有超过 100 成员的分页/名称解析测试。
- **建议方向**：按所需 userId 批量取人，或建立分页累积/服务端 join，不使用固定首页作为名称字典。

### F-25 搜索筛选状态不会随外部 `spaceId` 变化同步

- **复核状态**：已解决。筛选状态会同步外部空间变化，名称解析支持大空间集合。
- **来源**：近期新增
- **位置**：`apps/client/src/features/search/components/search-spotlight-filters.tsx:49-101`
- **触发条件**：组件未卸载，但父组件传入新的 `spaceId`；空间数超过 100。
- **影响**：`useState(spaceId)` 只在首次渲染执行，后续 prop 变化仍保留旧空间；名称查找只加载前 100 个空间，也可能显示空标题。
- **测试空白**：没有 rerender 改 prop 和大空间分页测试。
- **建议方向**：明确受控/非受控模式；监听 prop 并重置目录范围；按 ID 获取当前空间名称。

### F-26 前端构建存在废弃配置和较大首屏包

- **复核状态**：已解决。设置页和重模块已懒加载，废弃配置已移除，并加入 gzip 预算。
- **来源**：官方前端债务与当前依赖组合
- **位置**：`apps/client/vite.config.ts:38-51`
- **触发条件**：生产构建和首次加载前端。
- **影响**：构建警告 `advancedChunks` 已废弃；多个 chunk 超过 500 KiB，主 bundle 约 `3.0 MB` minified、`914 KiB` gzip，会影响弱网首屏和浏览器解析时间。
- **测试空白**：没有 bundle budget、Lighthouse/Web Vitals 门禁或真实弱网性能回归。
- **建议方向**：更新 Rolldown/Vite 分包配置；按编辑器、图表、设置页和 Excalidraw 做路由级懒加载；设置 gzip/brotli 预算。

### F-27 迁移测试只证明“新库可回滚”，未覆盖真实历史数据升级

- **复核状态**：外部待验证。本地多阶段回滚/升级、结构断言和预检查 SQL 已补齐；生产规模锁与耗时仍需匿名化快照证明。
- **来源**：二开测试体系
- **位置**：`.github/workflows/mcp-quality.yml:137-151` 及 `apps/server/test/mcp-migrations.ts`
- **触发条件**：生产库包含旧 MCP 客户端、不一致 actor/owner、海量 chunk/job/audit 数据时升级。
- **影响**：当前演练无法评估大表锁时长、索引构建时间、坏数据修复数量、磁盘峰值和回滚窗口。特别是 ownership hardening 会禁用部分 active 客户端。
- **测试空白**：缺少匿名化生产规模 fixture、旧版本跨多阶段升级和迁移耗时预算。
- **建议方向**：建立接近生产分布的迁移 fixture；上线前运行只读预检查 SQL 和 `EXPLAIN`；记录锁、耗时、空间和受影响 Token 数。

## 7. 已确认表现良好的部分

以下能力经过代码和测试交叉验证，本轮没有发现需要阻止继续使用的问题：

1. **目录范围搜索主链路完整**：网页 keyword/semantic/hybrid 和 MCP 搜索都能携带目录范围。
2. **目录边界有硬限制**：`PageTreeScopeService` 校验 root UUID，并把单次目录解析限制为 `10,000` 页。
3. **目录权限不是只看 MCP 配置**：范围解析还会结合当前 Docmost 用户、空间和页面可读权限过滤。
4. **个人客户端隔离基本正确**：普通管理员不能查看或操作其他用户的 personal client。
5. **工作区客户端边界清晰**：创建和管理 workspace client 仍由 workspace owner 控制。
6. **权限计算采用有效权限**：MCP grant 不会绕过当前执行用户在 Docmost 中的实际权限。
7. **批量权限写入使用事务**：未发现部分权限行成功、部分失败后仍提交的路径。
8. **MCP/API Token 统一已接通**：同一 Token 可进入统一 tool service，避免两套权限实现漂移。
9. **写操作具备审计和恢复基础设施**：虽然仍有上述生命周期问题，但已有幂等记录、checkpoint、审计 warning 和 reconcile 框架。
10. **代码库未发现已提交密钥**：本轮 tracked-file 扫描没有命中 API Key、私钥或生成的 MCP Token。

## 8. 修复完成情况与发布顺序

原建议的三个阶段均已在当前工作区实现：

### 阶段 A：发布阻断项

1. 依赖升级、批处理保护、分布式限流和 AJV 运行时校验已完成。
2. 页面写操作强制幂等与乐观版本，附件上传补偿已完成。
3. 精确 CI Prettier、Lint、TypeScript、前后端测试和真实 SDK 测试均通过。

### 阶段 B：数据一致性与可恢复性

1. 幂等 heartbeat/修复管理、向量父子任务、周期恢复和资格重算已完成。
2. 附件索引租约、恢复扫描、删除状态机和输入资源边界已完成。
3. 数据库约束、迁移结构断言和生产预检查 SQL 已完成。

### 阶段 C：运维与工程质量

1. MCP/Vector 开关、保留策略、多副本指标快照和 Grafana 聚合已完成。
2. CI 路径、覆盖率分组、RC 质量依赖、SBOM 和固定 Action 已完成。
3. 大工作区名称解析、搜索状态同步、路由懒加载和 bundle 预算已完成。

建议发布顺序：

1. 先在隔离数据库上使用匿名化生产快照执行预检查和迁移演练。
2. 通过 GitHub Dependency Review 或批准的私有审计完成依赖复核。
3. 部署至少两个应用副本，确认共享 PostgreSQL、Redis 和对象存储配置一致。
4. 执行 MCP/API、网页搜索、附件和后台恢复 smoke test。
5. 观察指标、Redis 锁续租、队列积压和数据库锁等待后再扩大流量。

## 9. 审查边界

本报告是代码、自动化测试、临时 PostgreSQL 迁移演练和依赖公告的组合审查，不等于以下工作：

- 未对香港 VPS 或公司测试环境进行部署变更。
- 未使用真实生产数据库做升级演练。
- 未执行真实高并发、故障注入、长时间 soak 或多副本压测。
- 未向 npm 或其他外部审计服务发送私有依赖元数据；完整公告复核依赖 CI Dependency Review。
- 未取得可移植的 `pgvector/pgvector:pg18` 多架构 digest。
- 已修改并格式化当前工作区，但未提交、推送或部署。
