# 🌐 CION NMS — 网络管理系统

企业级生产标准的**网络管理系统（NMS）**：前后端彻底分离、按业务域模块化组织（每个功能域都有独立的 routes / models / frontend / audit）。覆盖 **IPAM 地址管理、设备台账 + SNMP 采集、分布式探针（mTLS Agent）、探测结果分析、用户权限体系**五大领域，自带 NOC 运行总览看板。

> 探测任务的**执行方**（真正跑 ping/mtr/SNMP 的 Agent 程序）是独立项目（NMS_Agent 仓库），不在本仓库内。本仓库的 Server 负责 Agent 的注册引导、任务调度、结果存储与展示，并通过 Releases 功能向 Agent 分发二进制更新。

---

## 🏗️ 架构总览

| 层 | 技术栈 |
|----|--------|
| 后端 | Go 1.26 · Gin · GORM · MySQL/MariaDB · gosnmp · gosmi（MIB 解析）· 纯标准库 PKI（ECDSA P-256）· 纯标准库日志轮转 |
| 前端 | React 19 · TypeScript · Vite · Ant Design 6 · @ant-design/charts |
| CI | GitHub Actions：打 `v*` tag 自动构建前后端并发布 Release |

后端**单进程同时监听三个端口**：

| 端口（默认） | 配置项 | TLS 模式 | 用途 |
|------|--------|----------|------|
| `8080` | `server.port` | 普通 HTTP（由 Nginx 反代为 HTTPS） | 浏览器前端全部 JWT API |
| `8443` | `agent_pki.enroll_port` | 单向 HTTPS（`tls.NoClientCert`） | Agent 首次注册：`POST /agents/enroll`、`GET /agents/ca-cert` |
| `8444` | `agent_pki.sync_port` | 双向 mTLS（`tls.RequireAndVerifyClientCert`） | `/agent-sync/*`：任务拉取 / 结果上报 / 证书续期 / 二进制下载 |

Go 的 `tls.Config.ClientAuth` 按监听器全局生效，无法在同一端口内按路径区分是否要求客户端证书，因此 enroll 与 sync 必须分开监听。**这两个端口必须让 Agent 直连**（防火墙放行），不能经过 Nginx 反代——mTLS 校验在本进程内完成。enroll/sync 监听地址留空主机部分（`:8443`），双栈系统上同时接受 IPv4/IPv6 连接，纯 IPv4 环境自动回退。

---

## 🗺️ 功能地图（按导航菜单）

前端导航即功能索引——**一个菜单一个功能域，页面内 Tab 即子功能**：

```text
📊 总览            /dashboard          NOC 运行看板（登录首页）
🏗️ 基础设施
   ├─ 设备         /devices            设备列表 · 站点(PoP) · 角色 · 厂商 · MIB 库 · 审计日志
   └─ IPAM        /ipam               根前缀 · 子网树 · 分组 · 类型 · VRF · 审计日志
📡 监控
   ├─ Agent 管理   /agents   [admin]   Agent 列表 · 分组 · 探测任务 · 注册码/CA · 版本发布
   └─ 探测结果      /probe-results      Ping · TCPing · HTTPCheck · MTR · MeshPing 矩阵
⚙️ 管理            [admin]
   ├─ 用户         /system/users       账号生命周期 · 强制下线 · 会话统计
   ├─ 用户组        /system/groups      模块级权限分配
   └─ 安全设置      /system/settings    防护配置 · 锁定列表 · 系统审计日志
```

---

### 📊 总览（Dashboard · `/dashboard`）

登录后的默认落地页，NOC 运行总览。数据源为聚合端点 `GET /api/v1/overview?range=1h|24h|7d`（任何已登录用户可访问），30 秒轮询 + 请求序号守卫（乱序响应直接丢弃）：

- **KPI 卡**：设备/Agent/探测量/失败率，mono 大数字 + sparkline，含与上一等长窗口的环比
- **探测量时序**：服务端按时间桶聚合（1H=5min 桶 / 24H=1h 桶 / 7D=6h 桶），Go 侧补齐空桶
- **设备状态**：管理状态环图 + **运行状态分面**（up / down / **proxy down**——探针失联的设备单列，不淹没在 unknown 里）
- **分组健康度**：各 Agent 分组的在线率（Top 6）
- **活跃告警**：窗口内最新失败探测 + 离线 Agent 派生
- `@ant-design/charts`（G2）较重，本路由 `React.lazy` 懒加载，不拖累登录与其他页面

---

### 🖥️ 基础设施 › 设备（Devices · `/devices`）

设备台账 + SNMP 采集监控。物理结构三层：**Site（站点）→ PoP（机房节点）→ Device（设备）**。写操作需 `devices:write` 权限（MIB 上传/删除与审计清理仅管理员）。

#### Tab 1 · 设备列表

- **CRUD**：Hostname 全局唯一；管理地址 IPv4/IPv6 **至少一项**、各自全局唯一（存 SQL NULL 而非空串以兼容唯一索引）；关联 Site/PoP/Role/Vendor 字典；服务端分页 + 多条件过滤（状态/运行状态/采集模式/站点/关键字）
- **状态双字段模型**：
  - **管理状态** `status`（用户设置）：`active` / `maintenance` / `planned`——生命周期意图，SNMP 永不改写（`offline` 为遗留值，UI 显示"已停用"）
  - **运行状态** `oper_status`（机器写入）：`up` / `down` / `unknown`——只由采集链路驱动，`oper_reason` 记录原因；planned/停用设备不采集，maintenance 照常采集（真相不丢，前端叠加维护标识）
- **SNMP 采集**（逐台开启，v1 / v2c / **v3 USM** 全支持）：
  - **双模式**：**Direct**（Server 内置轮询器：worker pool + 到期扫描 + 在途去重）或 **Agent Proxy**（表单指派探针代理，适合管理网段仅探针可达的场景）。代理任务不进 `agent_tasks` 表——从 devices 表即时合成下发（虚拟 TaskID = 2³⁰ + device_id），结果回传时服务端校验设备归属防越权伪造。两种模式最终汇聚到同一落库路径 `applySNMPResult`
  - **快/慢两档**：每周期只 GET `sysUpTime`（最小报文，兼做存活判定），每 `inventory_every_n` 次附带完整 RFC 1213 system 组；`sysUpTime` 回退触发重启检测（写 `reboot_detected` 审计）
  - **看门狗**：后台每分钟扫描设备自身 `last_poll_at`，停滞超 `max(3×采集间隔, 300s)` → `unknown`（agent 模式原因 `agent_down`，前端展示 **Proxy Down**）；探针被吊销/删除立即归位——防止探针断电后设备状态永远停在最后一次结论
  - **凭证安全**：community / v3 口令一律 `json:"-"` 永不出现在任何 API 响应（前端以 `*_set` 派生标志感知，编辑留空 = 不修改）；配置 `snmp.credentials_key` 后 AES-256-GCM 静态加密落库，启动时自动加密存量明文，支持双口令轮换
- **SNMP 详情 Drawer**（点主机名打开）：system 组全量 + 采集来源/延迟/最近错误 + sysObjectID 翻译名；Direct 模式提供**立即测试**（同步采集一次并落库）
  - **自定义标量 OID**（每台 ≤16 条，与 system 组同一 GET 报文）：`gauge` 存瞬时原值 / `counter` 入库时换算每秒速率（负差值 = 回绕/重置跳点，RRDtool 同语义）；数值型自动进指标时序，Drawer 内趋势图（1h～90d 时间桶聚合 avg/min/max），配置 `snmp.metric_rollups` 后启用降采样归档，长窗口曲线不断档；名称留空自动用 MIB 翻译命名
  - **接口表采集**（表单开关）：每周期 WALK `ifTable`/`ifXTable` 维护接口维表——名称/别名/速率上限/admin-oper 状态/实时流量（HC 64 位计数器优先，服务端换算 bit/s）/累计错误；消失接口自动清理，单设备上限 512；按接口历史趋势不入库（关键端口用自定义 OID + counter 变通）

#### Tab 2 · 站点（内嵌 PoP 管理）

Site CRUD + 每站点的 PoP 子表管理（PoP 名在 Site 内唯一；PoP 迁站在事务内级联更新所属设备）。删站点须先清空其 PoP。

#### Tab 3 / 4 · 角色 / 厂商

设备分类字典 CRUD。删除时关联设备外键置 NULL，不阻断。

#### Tab 5 · MIB 库

- admin 上传（≤2 MiB，轻量 SMI 校验 + SHA256 + 模块名唯一），登录用户可查看/下载；文件按 `<模块名>.mib` 落盘
- **gosmi 翻译引擎**：启动与每次上传/删除后全量重建；单模块解析失败不影响其他模块（常见原因是 IMPORTS 依赖未上传，补传后自动转好，解析状态列表可见）
- **12 个标准基础模块已内置**（SNMPv2-SMI/TC/CONF/MIB、IF-MIB、RFC1213 等，go:embed 编译进二进制，首次启动 seed，管理员删除后不复活）——厂商 MIB 几乎都依赖它们，上传即可解析
- 用途：`GET /devices/mibs/translate?oid=` 数字 OID → 可读名（最长前缀匹配）；Drawer 中 sysObjectID 自动翻译（如 `CISCO-PRODUCTS-MIB::cisco7206VXR`）；自定义 OID 自动命名

#### Tab 6 · 审计日志

Devices 域全部写操作留痕（含 SNMP 配置变更、立即测试、重启检测），分页查询；按天数清理仅管理员。

---

### 🌐 基础设施 › IPAM（`/ipam`）

IPv4/IPv6 双栈地址规划。写操作需 `ipam:write` 权限。页头 StatTile 展示根前缀/VRF/分组/类型计数。

#### Tab 1 · 根前缀

根 CIDR CRUD（严格校验：必须是网络地址本身）。删除在同一事务 + `FOR UPDATE` 行锁内级联清理全部子网。

#### Tab 2 · 子网树

- `GET /root-prefixes/:id/tree` 渲染 L1 → L2 两级层级树，含利用率视图
- **拆分（Split）**：把一个前缀按 2ⁿ 等分为子网；**合并（Merge）**：相邻兄弟子网合并回父级（2ⁿ 校验 + Re-parenting）。L1/L2 子网**禁止单独删除**，只能通过 Split/Merge 重组——保证树永远无洞、无重叠
- 纯算法层（`core/ipam_calc.go`）与 HTTP 层分离

#### Tab 3 / 4 / 5 · 分组 / 类型 / VRF

业务字典 CRUD（VRF 含 RD 字段），供根前缀与子网打标。

#### Tab 6 · 审计日志

IPAM 域操作留痕；清理仅管理员。

---

### 📡 监控 › Agent 管理（`/agents` · 仅管理员）

分布式探针体系：内置 CA + mTLS 自动引导注册、中心化任务调度、OTA 升级。

#### Tab 1 · Agent 列表

- 列表（分页/搜索/分组过滤）+ 健康汇总卡（total/online/offline/revoked）
- 编辑：hostname、分组、**Source IP Override**（覆盖自动追踪的连接地址，支持 `ipv4 / ipv6` 双栈格式——作为 MeshPing 互测目标与探测源绑定）
- **作废证书（Revoke）**：立即断连但保留历史数据；**删除**为硬删除（`?purge=true` 连带清探测记录，并解绑其名下设备的 SNMP 采集）
- **心跳机制**：Agent 周期调用 `GET /agent-sync/tasks` 拉任务，该调用本身即心跳——mTLS 中间件顺手刷新 `LastSeenAt`/连接 IP（`X-Agent-IPv4/IPv6` 头上报双栈地址，`X-Agent-Version/OS/Arch` 上报档案）；失联超 5 分钟由后台扫描（每分钟）翻转为 offline

#### Tab 2 · 分组

逻辑分组（如 HKG / SIN / LAX），同时是 **meshping/meshmtr 的互测边界**。删除分组时组内 Agent/任务的 `group_id` 置 NULL。

#### Tab 3 · 探测任务（Probe Config）

- **8 种类型**：`ping` · `tcpping` · `httpcheck` · `dnscheck` · `traceroute` · `mtr` · `meshping` · `meshmtr`；POST 支持多类型一次批量创建（共享同一份 Target 列表，校验按所选类型的并集放行）
- **三级 Scope**：Global（全部 Agent）/ Group（指定分组）/ Agent（指定单台）
- **Target 格式**：每行一个字面 IP **或域名**；`tcpping`/`httpcheck` 可附加 `:port`（IPv6 用 `[addr]:port`；省略时 Agent 侧有默认值）；`httpcheck` 亦支持完整 `http(s)://` URL；`dnscheck` 填待解析域名
- **meshping / meshmtr**：Target 由 Server 动态解析——同组（或全局）存活 Agent 的 IP 实时组装下发，配置时填写的 Target 被忽略。peer IP 优先级：`source_ip_override` → 自动追踪的 `connection_ipv4/v6` → 旧版 `connection_ip` 兜底
- **每任务可选项**：
  - `address_family`——域名 Target 的解析族：`auto`（默认）/ `v4` / `v6` / `both`（两族各测一次，结果以 ` (v4)`/` (v6)` 后缀分为两条独立序列）。字面 IP 不受影响。注意：切换 both 会更换序列键（旧序列停止增长）；Agent 缺某族出网能力时该族持续 failed 是可见的诊断信号；traceroute 在 both 下两族串行（最坏约 3 分钟/目标），建议 interval ≥ 300s
  - `skip_tls_verify`——仅 `httpcheck`：探测裸 IP（证书 SAN 只签域名）或自签证书设备时开启

#### Tab 4 · 注册码 + CA 管理

- **一次性注册码**：可设有效期、预设分组；明文仅生成时显示一次，DB 只存 SHA-256 哈希（与 Refresh Token 同模式）
- **注册流程**：Agent 调 `POST /agents/enroll`（单向 HTTPS）携带注册码 + hostname → 后端**原子条件 UPDATE** 认领注册码（杜绝并发重复消费）+ 来源 IP 滑动窗口防爆破（10 分钟 10 次失败 → 锁 15 分钟）→ 分配全局唯一 `AgentID`（如 `AGT-3F2A9B7C`）→ 内置 CA 签发客户端证书（CN=AgentID，默认 1 年）连同 CA 公钥返回。此后所有 `/agent-sync/*` 调用凭证书做 mTLS，证书 CN 即身份，服务端额外比对序列号与吊销状态
- **证书续期**：Agent 用仍有效的证书调 `POST /agent-sync/renew-cert` 直接换发（语义同 Refresh Token 旋转）
- **CA 轮换**：「轮换 CA」生成新 CA 用于后续签发，旧 CA 公钥保留过渡期仍被信任；全部 Agent 续期完毕后「终结轮换」停止信任旧 CA。**两个操作均只落盘，需重启服务进程生效**（避免对正被并发 TLS 握手读取的信任池做无锁热切换）

#### Tab 5 · 版本发布（OTA Releases）

1. 上传各 OS/Arch 的 Agent 二进制（流式写盘 + 同步计算 SHA256，不占内存；主引擎 `MaxMultipartMemory` 128 MiB）
2. 「激活」某版本——同 OS+Arch 互斥，自动取消其他激活记录
3. 匹配 OS/Arch 且版本不同的 Agent 在下次任务同步响应中收到 `update` 字段
4. Agent 经 mTLS 从 `GET /agent-sync/binary/:id` 下载、校验 SHA256、自替换并重启
5. 前端轮询 `/agent-releases/:id/progress` 实时查看各 Agent 更新进度

---

### 📈 监控 › 探测结果（Probe Results · `/probe-results`）

所有登录用户可见（只读）；清理操作仅管理员（页头「清理」按钮：按天数全量清理）。

#### Tab 1–4 · Ping / TCPing / HTTPCheck / MTR

- 每类型独立 Tab：**最新快照**（每 (Agent, Target) 一行）与**历史分页**双视图，支持 agent/关键字/成败/时间区间过滤
- 路径类结果（mtr）行内可展开**逐跳详情**（丢包/延迟/ASN 标注）
- 每行提供**延迟趋势**入口（LatencyTrendModal）：1 小时～1 年/自定义区间，avg/min/max/丢包；数据源在**原始点与归档层间自动选择**（能覆盖起点的最细数据源），聚合到 ≤500 个显示点

#### Tab 5 · MeshPing 矩阵

- NxN 延迟热力矩阵（v4/v6 独立单元格），按分组/关键字过滤
- 单元格菜单可下钻：对应 (源, 目标) 的 **MTR 逐跳详情**（meshmtr 结果）或**延迟趋势图**
- 已知取舍：矩阵按各 Agent *当前* IP 反查历史结果归属，IP 变化瞬间个别历史单元格可能短暂错位

#### 数据保留（分层归档，Cacti RRA 风格）

- 原始点（`probe_results`，粒度=任务 Interval）默认保留 30 天；路径类大 JSON（mtr/meshmtr/traceroute）可独立设更短保留
- 配置 `audit.probe_rollups` 后启用**降采样归档**：后台每小时把原始点聚合到各粒度桶（如 5min/30min/2h/1d），存 `lat_sum/lat_cnt` 而非均值（跨层重聚合无失真），序列身份归一化到 `probe_series` 维表 + 复合主键聚簇零二级索引；`GET_LOCK` 保证多实例互斥、幂等 upsert
- 推荐配置下可实现「5 分钟粒度 6 个月 → 1 天粒度 10 年」的长期趋势，存储紧凑度对标 RRD

#### IP→ASN 标注（可选，`asndb.enabled`）

基于 [gaissmai/bart](https://github.com/gaissmai/bart) 前缀树最长匹配；数据源 CAIDA RouteViews（v4/v6 前缀表）+ RIPE NCC（AS 名称），每日定时自动下载并**无锁热重载**（atomic pointer swap）。MTR 弹窗为每一跳标注 ASN 与 ISP 名称；管理员可手动触发下载/重载。

---

### 👥 管理 › 用户（`/system/users` · 仅管理员）

- 用户 CRUD：创建/重置密码支持**一键生成强随机密码**；重置后强制改密
- **账号停用/启用**：停用即吊销全部 Refresh Token（历史数据保留；停用提示只在密码校验通过后返回，防用户名枚举）
- **会话管理**：点击列表中的会话数打开**会话列表**（每会话的客户端 IP / User-Agent / 登录与到期时间，Token 旋转时同步更新），可**吊销单个会话**；「强制下线」则一键吊销全部 Refresh Token
- 列表展示启用状态、**活跃会话数**、最后登录时间
- **管理保护**：不能删除/停用/降权最后一个启用状态的管理员；不能删除/停用自己、不能改自己的组

### 🔐 管理 › 用户组（`/system/groups` · 仅管理员）

模块级权限模型——组的 `permissions` 为权限值数组（白名单校验），JWT 签发时固化进 `perms` 声明（组权限变更在下次 Token 刷新时生效）。前端按权限隐藏写入口（`useCan`），后端路由中间件强制校验（`RequirePerm`，双重门禁）：

| 权限值 | 授予的能力 |
|--------|-----------|
| （无，只读基线） | 所有登录用户：查看 Dashboard / IPAM / Devices / Probe Results / 各审计日志 |
| `ipam:write` | IPAM 全部写操作（根前缀 CRUD、拆分/合并、字典维护） |
| `devices:write` | Devices 全部写操作（设备/站点/PoP/角色/厂商 CRUD，含 SNMP 配置与立即测试） |
| `admin` | 超级管理员：隐含全部权限 + 用户/组管理、Agent 体系、MIB 库写、安全设置、各类数据清理 |

不能删除唯一管理员组（组权限按解析结果校验，非字符串比较）。

### 🛡️ 管理 › 安全设置（`/system/settings` · 仅管理员）

#### Tab 1 · 防护配置

- **登录防爆破**：同一「用户名+IP」滑动窗口内失败达阈值即临时锁定（默认 5 分钟 5 次 → 锁 15 分钟，可调可关）；用户不存在与密码错误同样计数，防用户名枚举。计数在内存——单实例部署下足够，重启即清零不会误锁
- **会话策略**：全局最大会话时长上限（签发 Token 时钳制用户自定义值）

#### Tab 2 · 锁定列表

当前被锁定的「用户名+IP」组合，支持搜索与单条/批量手动解锁。

#### Tab 3 · 系统审计日志

用户/用户组/安全设置/会话管理的全部敏感操作留痕（含自助改密、手动解锁、强制下线），支持查询与按天数清理。

---

### 🔑 全局能力（不在菜单内）

- **认证**：JWT Access Token 有效期用户自定义（1–720h，默认 24h，受全局上限钳制）+ Refresh Token（默认 7 天，**旋转式**——每次刷新旧 Token 即作废，只存哈希）；前端到期前 5 分钟静默换新
- **首次登录强制改密**：默认账号 `admin/admin` 登录后（及管理员重置密码后），JWT 声明 + 中间件双重拦截，改密前只放行 `me`/`change-password`
- **登录页**：双栏布局，预登录即可切换主题/语言
- **个人资料**（右上角头像菜单）：改密、会话时长设置、主题（亮/暗/跟随系统）与语言（EN/ZH）偏好——持久化到服务端用户档案，跨设备同步
- **基础限速**：未认证端点按 IP 滑动窗口限速（login 30 次/分、refresh 60 次/分、health 120 次/分），超限返回 429 + `Retry-After`——与登录防爆破锁定（按用户名+IP 计失败）互补，挡住同 IP 喷洒与匿名端点滥用；计数在内存（单实例语义，重启清零）
- **健康检查**：`GET /api/health`（无需认证）探测 DB 连通性，故障返回 503，供 LB/监控接入
- **优雅停机**：SIGINT/SIGTERM 后停止接新连接，等待在途请求（≤15s）
- **错误码体系**：错误响应统一 `{"error": "<中文>", "code": "<机器码>", ...插值参数}`，前端 `i18n/apiErrors.ts` 按 code 做 EN/ZH 映射（支持 `{minutes}` 等插值），未命中回退 error 原文；`scripts/check-error-codes.mjs` 在 CI 校验两侧一致性

---

## 📂 目录结构

```text
NMS/
├── .github/workflows/release.yml      # CI：打 v* tag 自动编译并发布 Release
├── scripts/check-error-codes.mjs      # CI：校验后端错误码与前端 i18n 词条一致性
│
├── backend/                           # Go 后端（模块名 nms-backend）
│   ├── main.go                        # 入口：配置/连接池/迁移/Seed/三端口监听/优雅停机
│   ├── logger.go                      # 按天轮转 + gzip 压缩 + 过期清理（纯 stdlib）
│   ├── config.example.yaml            # 配置模板（部署时复制为 config.yaml）
│   ├── mibs_builtin/                  # 12 个标准 MIB 基础模块（go:embed 内置）
│   ├── core/
│   │   ├── errors.go                  # CodedError：携带错误码+插值参数的业务错误
│   │   ├── ipam_calc.go               # 纯算法：严格 CIDR 校验、子网拆分/合并
│   │   ├── pki.go                     # 内置 Root CA：生成/加载/轮换，签发服务端与客户端证书
│   │   └── secrets.go                 # SecretBox：SNMP 凭证 AES-256-GCM 静态加密（双口令轮换）
│   ├── asndb/                         # 可选：IP→ASN 前缀匹配（BART trie + 每日自动下载）
│   ├── models/                        # ipam_ / device_ / sys_ / agent_ / rollup 五组数据模型
│   ├── middleware/
│   │   ├── auth.go                    # JWT 校验 + AdminRequired/RequirePerm + 强制改密拦截
│   │   ├── mtls.go                    # mTLS 客户端证书校验（CN=AgentID，吊销/序列号比对，心跳刷新）
│   │   ├── ratelimit.go               # 按 IP 滑动窗口限速（login/refresh/health 等未认证端点）
│   │   └── recovery.go                # panic 恢复（堆栈写入 slog）
│   └── controllers/
│       ├── common.go                  # 跨模块工具：parseIDParam/getUsername/codedErrJSON 等
│       ├── auth_api.go                # 登录 / 刷新 / 改密 / 会话时长 / UI 偏好
│       ├── system_api.go              # 用户 & 用户组 & 安全设置 & 会话策略（管理员）
│       ├── login_protection.go        # 登录防爆破（滑动窗口 + 锁定列表管理）
│       ├── ipam_api.go                # IPAM REST（根前缀/子网树/拆分/合并/字典/审计）
│       ├── device_api.go              # Devices REST（含 SNMP 配置/详情/自定义 OID/指标序列）
│       ├── device_snmp_poller.go      # SNMP 采集核心：applySNMPResult 唯一落库 + Direct 轮询器 + 看门狗
│       ├── device_metric_rollup.go    # 指标时序降采样归档（GET_LOCK 多实例互斥）
│       ├── device_mib_api.go          # MIB 文件库（上传校验/列表/下载/删除）
│       ├── device_mib_engine.go       # gosmi 翻译引擎（OID → 可读名，全量重建）
│       ├── agent_enroll_api.go        # Agent 注册引导（一次性注册码原子消费 + IP 防爆破）
│       ├── agent_sync_api.go          # 任务下发（含 snmp_poll 合成）/ 结果上报 / 证书续期 / 二进制下发
│       ├── agent_admin_api.go         # Agent/Group/Task/Token/Release 管理 + CA 状态/轮换
│       ├── probe_results_api.go       # 结果历史 / 最新快照 / MeshPing 矩阵 / 延迟趋势 / 清理
│       ├── probe_rollup.go            # 探测结果降采样归档（Cacti RRA 风格，幂等 upsert）
│       ├── overview_api.go            # NOC 看板聚合（时间桶时序 + KPI + 分组健康度）
│       ├── asn_api.go                 # IP→ASN 批量查询 + 数据管理（可选启用）
│       ├── audit_retention.go         # 审计日志 + 探测结果分层自动保留清理
│       └── seed.go                    # 幂等 Seed：默认 admin 组/账号
│
└── frontend/                          # React 19 + TS + Vite + antd 6
    └── src/
        ├── api/                       # 共享 Axios 实例（自动带 Token + 静默刷新）+ 各模块 API 封装
        ├── types/                     # 与后端响应一一对应的 TS 类型
        ├── theme/theme.ts             # 设计令牌：buildTheme(light|dark) + palette + mono 字体
        ├── i18n/                      # useT() 钩子 + EN/ZH 全量翻译 + apiErrors 错误码映射
        ├── contexts/                  # AuthContext（Token 静默刷新）/ AppContext（主题/语言）
        ├── components/                # PageHeader / StatusTag / StatTile / MetricCard / RelativeTime / LatencySpark 等
        ├── layouts/MainLayout.tsx     # 分组侧边栏 + 顶栏（主题切换/用户菜单）
        └── pages/                     # 每菜单一个目录，页面内 Tab 即子功能（见上文功能地图）
```

---

## 🚀 快速开始（本地开发）

前置依赖：Go ≥ 1.26 · Node.js ≥ 22 · MySQL ≥ 8.0 或 MariaDB ≥ 10.6

```bash
# 后端
cd backend
cp config.example.yaml config.yaml   # 填入数据库连接 + JWT secret
go mod tidy
go run .                             # :8080 主 API + :8443 enroll + :8444 sync

# 前端（另开终端）
cd frontend
npm install
npm run dev                          # :5173，/api 自动代理到 :8080
npm run lint                         # ESLint（TypeScript + React Hooks 规则）
```

首次启动自动建表、生成 Root CA（`backend/data/pki/`）、seed 内置 MIB、写入默认账号 **`admin` / `admin`**（首次登录强制改密）。

---

## 🏭 生产部署（Debian 12/13 · Ubuntu 24+）

### 1. 数据库

```bash
sudo apt update && sudo apt install -y default-mysql-server   # Debian 下为 MariaDB
sudo mysql <<'EOF'
CREATE DATABASE IF NOT EXISTS nms_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'nms_user'@'localhost' IDENTIFIED BY 'StrongPassword123!';
GRANT ALL PRIVILEGES ON nms_db.* TO 'nms_user'@'localhost';
FLUSH PRIVILEGES;
EOF
```

### 2. 后端二进制

从 [GitHub Releases](../../releases) 下载 `nms-server`：

```bash
sudo mkdir -p /opt/nms/backend && cd /opt/nms/backend
sudo chmod +x nms-server
cp config.example.yaml config.yaml && nano config.yaml   # 参考下文「配置参考」
```

**部署前必改三项：**

1. `database.password` — 真实数据库密码
2. `jwt.secret` — 强随机字符串（≥32 位），如 `openssl rand -hex 32`
3. `agent_pki.server_san` — 必须包含 Agent 实际拨号使用的域名/IP，否则 Agent 侧 TLS 校验失败

**备份与安全要点：**

- `data/pki/ca.key` 是整套 Agent 信任体系的根密钥——**务必纳入备份，绝不能进 Git**
- `data/releases/`（Agent 二进制）、`data/mibs/`（MIB 库）、`snmp.credentials_key`（凭证加密口令）建议一并纳入备份
- 防火墙放行 `8443`/`8444` 供 Agent 直连；`8080` 只需对 Nginx 本机开放

### 3. systemd 常驻

```bash
sudo tee /etc/systemd/system/nms-backend.service <<'EOF'
[Unit]
Description=NMS Backend Server
After=network.target mysql.service

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/nms/backend
ExecStart=/opt/nms/backend/nms-server
Restart=on-failure
RestartSec=5
StandardOutput=null
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now nms-backend
```

> CA 轮换 / 终结轮换等操作只落盘不热生效，执行后需 `sudo systemctl restart nms-backend`。

### 4. 前端 + Nginx

```bash
sudo apt install -y nginx
sudo mkdir -p /var/www/nms && cd /var/www/nms
sudo tar -zxvf /path/to/dist.tar.gz

sudo tee /etc/nginx/sites-available/nms <<'EOF'
server {
    listen 80;
    server_name 你的域名或IP;

    location / {
        root /var/www/nms/dist;
        index index.html;
        try_files $uri $uri/ /index.html;
    }

    location /api/ {
        proxy_pass         http://127.0.0.1:8080;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}
EOF

sudo ln -sf /etc/nginx/sites-available/nms /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

> ⚠️ 后端主 API 引擎默认只信任**本机**（127.0.0.1/::1）反代的 `X-Forwarded-For`（防止伪造 XFF 绕过登录防爆破）。若 Nginx/LB 部署在其他主机，在 `config.yaml` 的 `server.trusted_proxies` 中加入其内网地址即可。Agent 直连的 enroll/sync 端口不信任任何代理头。

**HTTPS（生产必选，需域名）：**

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

Let's Encrypt 证书与 Agent PKI 的内置 CA 是两套完全独立的体系，互不影响。

---

## ⚙️ 配置参考

完整模板见 [backend/config.example.yaml](backend/config.example.yaml)，所有块均有注释。未配置的块使用内置默认值，旧版 `config.yaml` 可平滑升级。要点摘录：

| 配置块 | 关键项 | 默认 | 说明 |
|--------|--------|------|------|
| `server` | `port` | 8080 | 主 API 端口 |
| | `trusted_proxies` | 127.0.0.1, ::1 | 受信反代地址（仅其 X-Forwarded-For 被采信；异机 Nginx/LB 需加入） |
| `database` | 连接池 4 项 | 25/10/60m/10m | `conn_max_lifetime_minutes` 必须小于 MySQL `wait_timeout` |
| `jwt` | `secret` / `refresh_token_days` | — / 7 | secret 必须替换为强随机值 |
| `audit` | `max_age_days` | 180 | 四域审计日志保留天数，0 = 永久 |
| | `probe_results_max_age_days` | 30 | 原始探测点保留；启用归档后建议缩至 14 |
| | `path_results_max_age_days` | 0 | 路径类大 JSON 独立保留；0 = 跟随上项 |
| | `probe_rollups` | 不启用 | 降采样归档层：推荐 5min/6月 + 30min/12月 + 2h/3年 + 1d/10年 |
| | `probe_disk_guard.enabled` | false | 磁盘空间兜底：常规保留任务 24 小时一次太慢——2026-07-23 事故里 `probe_results` 几小时内就把小盘（9.2G）打满、MariaDB 因无法分配 InnoDB 临时表空间而崩溃。开启后按 `check_interval_minutes`（默认 10）高频检查可用磁盘空间，跌破 `critical_free_mb`（默认 500）立即对 `probe_results` 做一次比正常配置更激进（对半砍，但不低于归档层要求的最小天数）的紧急清理。生产环境磁盘通常远大于此量级，默认关闭；测试机/小型 VPS 建议开启 |
| `snmp` | `enabled` | true | SNMP 总开关：关闭后不启动轮询器/看门狗、不下发 snmp_poll 任务 |
| | `default_interval_seconds` | 60 | 快轮询默认间隔；设备表单可逐台覆盖（10–86400） |
| | `inventory_every_n` | 10 | 每 N 次快轮询附带一次完整 system 组 |
| | `timeout_seconds` / `retries` | 3 / 1 | 单次 SNMP 请求超时与重试 |
| | `max_concurrent` | 16 | Direct 轮询器并发上限 |
| | `metrics_max_age_days` | 14 | 自定义 OID 指标时序保留（约 16 OID × 60s ≈ 2.3 万行/天/设备） |
| | `metric_rollups` | 不启用 | 指标归档层（推荐 5min/3月 + 1h/12月 + 1d/3年） |
| | `mibs_dir` | data/mibs | MIB 文件库目录（纳入备份） |
| | `credentials_key` | 空 | SNMP 凭证静态加密口令；空 = 明文存库（凭证本就永不出 API） |
| | `credentials_key_previous` | 空 | 密钥轮换过渡：key 填新、此项填旧 → 重启自动重封 → 清空。⚠️ 两把都丢失则凭证不可恢复 |
| `agent_pki` | `enabled` / `dir` / `releases_dir` | true / data/pki / data/releases | 关闭后不生成 CA、不监听 enroll/sync |
| | `enroll_port` / `sync_port` | 8443 / 8444 | Agent 直连端口 |
| | `server_san` | localhost 等 | ⚠️ 必须覆盖 Agent 拨号地址 |
| | 证书有效期 3 项 | 365 / 730 / 3650 | 客户端 / 服务端叶子（每次启动重签）/ Root CA |
| `asndb` | `enabled` / `update_hour` | false / 3 | IP→ASN 查询，数据源 CAIDA + RIPE |
| `log` | `dir` / `level` / `format` / `stdout` 等 | logs / info / json / false | 按天轮转 + gzip，双重保留（天数+份数） |

日志文件：当日 `nms-server.log`，跨天归档为 `nms-server-YYYY-MM-DD.log.gz`。

---

## 🗂️ API 速查

错误响应统一 `{"error", "code", ...插值参数}`（见「全局能力 · 错误码体系」）。

### 认证 `/api/v1/auth`

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/login` · `/refresh` | 无需 JWT；返回 access+refresh token 对 |
| GET | `/me` | 当前用户信息 |
| POST | `/change-password` | 自助改密（返回新 Token 对） |
| PUT | `/settings` · `/profile` | 会话时长（1–720h）· UI 偏好（theme/language） |

### IPAM `/api/v1/ipam`（JWT；写需 `ipam:write`，审计清理仅管理员）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/POST/PUT/DELETE | `/root-prefixes[/:id]` | 根前缀 CRUD（删除事务+行锁级联清理子网） |
| GET | `/root-prefixes/:id/tree` | L1→L2 完整层级树 |
| POST | `/split` · `/merge` | 子网拆分 / 合并（2ⁿ 校验 + Re-parenting） |
| GET/POST/PUT/DELETE | `/groups` `/types` `/vrfs` | 字典 CRUD |
| GET / DELETE | `/audit-logs` | 审计日志查询 / 按天数清理 |

### Devices `/api/v1/devices`（JWT；写需 `devices:write`，MIB 写与审计清理仅管理员）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/POST/PUT/DELETE | `/` `/:id` | 设备 CRUD（服务端分页多条件过滤；凭证永不回显） |
| GET/POST/PUT/DELETE | `/sites` `/pops` `/roles` `/vendors` | 字典 CRUD（PoP 名在 Site 内唯一；迁站级联更新设备） |
| GET | `/agents-lite` | 表单"采集探针"下拉的轻量 Agent 列表 |
| GET | `/:id/snmp` | SNMP 详情（Drawer 数据源，含 sysObjectID 翻译名） |
| POST | `/:id/snmp/test` | 立即测试（仅 direct）：同步采集一次并落库 |
| POST/PUT/DELETE | `/:id/snmp/oids[/:oid_id]` | 自定义标量 OID（≤16/设备，gauge/counter） |
| GET | `/:id/snmp/oids/:oid_id/series?range=` | 指标趋势序列（时间桶聚合 avg/min/max） |
| GET | `/mibs/translate?oid=` | 数字 OID → 可读名（gosmi 最长前缀匹配） |
| GET / POST / DELETE | `/mibs` `/mibs/:id[/download]` | MIB 库：列表/下载登录即可；上传/删除仅管理员 |
| GET / DELETE | `/audit-logs` | 审计日志 |

### System `/api/v1/system`（JWT + 管理员）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/POST/PUT/DELETE | `/users` `/groups` | 用户 / 用户组 CRUD |
| POST | `/users/:id/force-logout` | 强制下线（吊销全部 Refresh Token） |
| GET / DELETE | `/users/:id/sessions[/:sid]` | 活跃会话列表（IP/UA/签发/到期）/ 吊销单个会话 |
| GET/PUT | `/settings/security` · `/settings/session` | 防爆破阈值 · 全局会话时长上限 |
| GET / POST | `/security/lockouts[/unlock]` | 锁定列表 / 手动解锁 |
| GET / DELETE | `/audit-logs` | 系统审计日志 |

### Agent 注册（enroll 端口 8443，无需认证）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/agents/enroll` | `{provisioning_token, hostname}` → AgentID + 客户端证书 |
| GET | `/api/v1/agents/ca-cert` | Root CA 公钥（PEM） |

### Agent 同步（sync 端口 8444，强制 mTLS）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/agent-sync/tasks` | 拉取任务（即心跳）；含 source_ip 绑定、OTA update、合成的 snmp_poll |
| POST | `/api/v1/agent-sync/results` | 批量上报探测结果。样本时间取 Agent 采集时刻 `collected_at`（unix 秒；旧版 Agent 缺失时回退入库时刻）；超窗样本（未来 5 分钟以上 / 过去 1 小时以上，时钟漂移或超长积压）显式丢弃并以 `dropped` 计数返回；按唯一键 `(agent_id, task_id, target, reported_at)` 幂等去重（`deduped` 计数）——上报重试重放整批是安全的 |
| POST | `/api/v1/agent-sync/snmp-results` | 批量回传 SNMP 采集结论（校验设备归属）；按设备级采集时刻做单调性检查，重试重放的乱序旧快照直接丢弃，状态机不会倒退 |
| POST | `/api/v1/agent-sync/renew-cert` | 证书自助续期 |
| GET | `/api/v1/agent-sync/my-ip` | 返回 Server 所见来源 IP（tcp4/tcp6 各调一次做双栈探测） |
| GET | `/api/v1/agent-sync/binary/:id` | 流式下载 Agent 二进制 |

### Agent 管理（主端口，JWT + 管理员）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/agents` · `/agents/summary` | 分页列表 · 健康汇总 |
| PUT/DELETE | `/agents/:agent_id` | 修改 / 删除（`?purge=true` 连带清探测记录） |
| POST | `/agents/:agent_id/revoke` | 作废证书（保留历史数据） |
| GET/POST | `/agents/ca-cert` `/ca/status` `/ca/rotate` `/ca/finalize` | CA 查看 / 轮换 / 终结 |
| CRUD | `/agent-groups` `/agent-tasks` `/agent-tokens` | 分组 / 任务（POST 支持多类型批量）/ 注册码 |
| GET/POST/DELETE | `/agent-releases` 及 `/:id/set-active` `/:id/progress` | OTA 上传 / 激活 / 进度 |

### 探测结果 `/api/v1/probe-results`（JWT，仅需登录；清理仅管理员）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 分页历史（`?type=&agent_id=&q=&success=&start=&end=`） |
| GET | `/latest` | 快照：每 (Agent, Target) 最新一条 |
| GET | `/meshping-matrix` | NxN 透视矩阵（`?group_id=&q=`） |
| GET | `/latency-series` | 延迟趋势（原始点/归档层自动选源，≤500 显示点） |
| DELETE | `/` · `/pair` | 按天数全量清理 / 按 (agent, target, type) 精确删除 |

### 其他

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/overview?range=1h\|24h\|7d` | NOC 看板聚合（登录即可） |
| GET | `/api/v1/asn?ips=a,b,c` | 批量 IP→ASN（`asndb.enabled` 时注册） |
| POST | `/api/v1/admin/asndb/download` · `/reload` | ASN 数据管理（管理员） |
| GET | `/api/health` | 存活 + DB 连通性（无需认证） |

---

## 🧩 数据模型与模块隔离

所有模块共存于 `nms_db`，以**表名前缀**隔离命名空间：

| 模块 | 前缀 | 数据表 |
|------|------|--------|
| IPAM | `ipam_` | root_prefixes · subnets · groups · types · vrfs · audit_logs |
| System | `sys_` | groups · users · refresh_tokens · settings · audit_logs |
| Devices | `device_` | sites · pops · roles · vendors · devices · snmp_states · snmp_oids · metric_points · metric_rollups · interfaces · mibs · audit_logs |
| Agent | `agent_` | groups · agents · tokens · tasks · releases · audit_logs |
| 探测结果 | `probe_` | probe_results（热表）· probe_series（维表）· probe_rollups（归档） |

关键关系与删除策略：

- **IPAM**：禁止单独删除 L1/L2 子网，只能 Split/Merge 重组；删根前缀在事务 + `FOR UPDATE` 行锁内级联清理
- **Devices**：删站点须先清空 PoP；删 PoP/角色/厂商时设备外键置 NULL；删设备连带清理 SNMP 快照/OID/时序/接口表
- **Agent**：删分组时组内 Agent/Task 的 `group_id` 置 NULL；删 Agent 为硬删除（只想断连用「作废证书」）；注册码 `unused → used` 经原子条件 UPDATE 转换
- 敏感凭据（用户密码 bcrypt、Refresh Token、注册码）一律**只存哈希**；SNMP 凭证 `json:"-"` 永不出 API，可选 AES-256-GCM 静态加密

---

## 🎨 前端设计系统

**"Direction A / Clarity"** —— 纯表现层设计系统，业务逻辑（分页/防抖/请求序号守卫/校验）与视觉完全解耦：

- **字体**：UI 用 Plus Jakarta Sans；IP/ID/指标/时间戳统一 IBM Plex Mono（`--cion-mono`）
- **主题**：`theme/theme.ts` 的 `buildTheme(mode)` 注入 antd 6 令牌，亮/暗双主题 + 跟随系统；偏好持久化到服务端（跨设备同步）。注意 antd 6 `cssVar` 变量只在组件子树内生效——组件树外的裸 DOM（登录页、加载屏、G2 canvas 图表）直接取 `palette` 原始 hex
- **国际化**：EN/ZH 全量翻译（`i18n/translations.ts`），antd locale 联动
- **通用组件**：`PageHeader` / `StatusTag` / `StatTile` / `MetricCard` / `RelativeTime`（相对时间随语言，悬停显绝对值）/ `LatencySpark`（共享懒加载 sparkline）
- **页面模式**：每菜单一个目录、页面内 Tabs 承载子功能；Tab 切换 version 自增强制 remount 拉新数据

---

## 📦 版本发布

打 tag 即发版：

```bash
git tag v1.19.0 && git push origin v1.19.0
```

GitHub Actions 自动：错误码一致性检查 → 前端 `npm run build` 打包 `dist.tar.gz` → 后端 `go test ./...` + 交叉编译 Linux amd64 `nms-server` → 提取自上个 tag 以来的 commit 生成 Changelog → 创建 GitHub Release。

---

## 📄 License

MIT License © 2026 CION
