# 🌐 CION NMS — 企业级网络管理与分布式拨测平台

**CION NMS** 是一套面向多数据中心 / 跨洲骨干网 / POP 边缘节点的生产级全栈**网络管理系统（Network Management System）**。后端采用 **Go 1.26 单进程三端口架构**，前端采用 **React 19 + TypeScript 6 + Ant Design 6** 构建双主题国际化单页应用，围绕 **NOC 运行总览、设备台账与双模式 SNMP 采集、双栈 IPAM 地址规划、mTLS 分布式探针管控、探测时序与全网 Mesh 质量分析、细粒度 RBAC 与安全审计** 六大核心域实现高内聚、低耦合的工程化闭环。

[![Build and Release](https://github.com/Cion-1221/NMS/actions/workflows/release.yml/badge.svg)](https://github.com/Cion-1221/NMS/actions/workflows/release.yml)
![Go Version](https://img.shields.io/badge/go-1.26-00ADD8?logo=go)
![React](https://img.shields.io/badge/react-19.2-61DAFB?logo=react)
![Ant Design](https://img.shields.io/badge/antd-6.4-1677FF?logo=antdesign)
![Database](https://img.shields.io/badge/db-MySQL%208.0%2B%20%7C%20MariaDB%2010.6%2B-4479A1?logo=mysql)
![License](https://img.shields.io/badge/license-MIT-green)

> **分布式边缘探针配套仓库**：部署在机房与 POP 节点执行主动拨测（Ping / TCPing / HTTP / DNS / Traceroute / MTR / Mesh）及内网 SNMP 代理采集的轻量守护进程位于独立仓库 **[NMS_Agent](https://github.com/Cion-1221/NMS_Agent)**。本仓库（Server + Web UI）负责内置 PKI 签发与平滑轮换、集中策略编排、OTA 二进制分发、多维时序归档及可视化呈现。

---

## 📖 目录

- [1. 架构与核心设计](#1-架构与核心设计)
  - [1.1 系统拓扑与三端口模型](#11-系统拓扑与三端口模型)
  - [1.2 核心工程亮点](#12-核心工程亮点)
  - [1.3 代码目录结构](#13-代码目录结构)
  - [1.4 数据库分域模型（33 张表）](#14-数据库分域模型33-张表)
- [2. 快速开始](#2-快速开始)
  - [2.1 使用预编译 Release 部署](#21-使用预编译-release-部署)
  - [2.2 源码编译与本地开发](#22-源码编译与本地开发)
  - [2.3 首次启动自动化流程](#23-首次启动自动化流程)
- [3. 配置文件详解（`config.yaml`）](#3-配置文件详解configyaml)
  - [3.1 `server` — 监听端口、受信代理与连接超时](#31-server--监听端口受信代理与连接超时)
  - [3.2 `database` — MySQL / MariaDB 连接池](#32-database--mysql--mariadb-连接池)
  - [3.3 `jwt` — 会话令牌签发](#33-jwt--会话令牌签发)
  - [3.4 `snmp` — 双模式采集、归档与静态加密](#34-snmp--双模式采集归档与静态加密)
  - [3.5 `agent_pki` — 内置 Root CA 与双 TLS 通道](#35-agent_pki--内置-root-ca-与双-tls-通道)
  - [3.6 `audit` — 分层保留、Cacti RRA 归档与磁盘兜底](#36-audit--分层保留cacti-rra-归档与磁盘兜底)
  - [3.7 `asndb` — 全球路由前缀与 ASN 自动标注](#37-asndb--全球路由前缀与-asn-自动标注)
  - [3.8 `log` — 结构化按日轮转日志](#38-log--结构化按日轮转日志)
  - [3.9 生产备份与机密清单](#39-生产备份与机密清单)
- [4. 功能模块全景](#4-功能模块全景)
  - [4.1 NOC 运行总览（Dashboard）](#41-noc-运行总览dashboard)
  - [4.2 设备台账与 SNMP 监控（Devices）](#42-设备台账与-snmp-监控devices)
  - [4.3 双栈地址规划（IPAM）](#43-双栈地址规划ipam)
  - [4.4 分布式探针管控（Agent 管理）](#44-分布式探针管控agent-管理)
  - [4.5 拨测质量与全网矩阵（Probe Results）](#45-拨测质量与全网矩阵probe-results)
  - [4.6 用户、权限与安全中心（System）](#46-用户权限与安全中心system)
- [5. 关键机制深度解析](#5-关键机制深度解析)
  - [5.1 三阶段零中断 Root CA 平滑轮换](#51-三阶段零中断-root-ca-平滑轮换)
  - [5.2 SNMP 双模式汇聚状态机](#52-snmp-双模式汇聚状态机)
  - [5.3 `probe_latest_states` 快照加速与 Cacti RRA 降采样归档](#53-probe_latest_states-快照加速与-cacti-rra-降采样归档)
  - [5.4 纵深安全基线](#54-纵深安全基线)
  - [5.5 后台常驻协程与优雅停机编排](#55-后台常驻协程与优雅停机编排)
- [6. 生产部署与运维手册](#6-生产部署与运维手册)
  - [6.1 数据库初始化](#61-数据库初始化)
  - [6.2 后端 systemd 服务编排](#62-后端-systemd-服务编排)
  - [6.3 前端部署与 Nginx 安全反代](#63-前端部署与-nginx-安全反代)
  - [6.4 版本平滑升级与回滚](#64-版本平滑升级与回滚)
  - [6.5 常见故障排查速查表](#65-常见故障排查速查表)
- [7. CI/CD 构建与错误码契约](#7-cicd-构建与错误码契约)
- [8. REST / mTLS API 全景速查](#8-rest--mtls-api-全景速查)
- [9. License](#9-license)

---

## 1. 架构与核心设计

### 1.1 系统拓扑与三端口模型

Go 标准库的 `tls.Config.ClientAuth` 按监听器粒度生效，同时浏览器流量走反向代理而边缘探针要求端到端双向证书校验。因此 `nms-server` 在单进程内隔离出三个职责分明的网络入口：

```text
                       浏览器（React 19 · Ant Design 6 · G2 5）
                                      │ HTTPS
                       Nginx / Caddy（托管静态 dist + 反代 /api/）
                                      │ HTTP :8080（JWT Bearer + 受信代理校验）
┌─────────────────────────────────────▼─────────────────────────────────────────┐
│                          nms-server（Go 1.26 静态单二进制）                      │
│                                                                               │
│  • :8080  主管理 API（HTTP）    /api/v1/{auth,overview,ipam,devices,agents,    │
│                                          probe-results,system,asn} + /health  │
│  • :8443  探针注册通道（HTTPS）  /api/v1/agents/{enroll,ca-cert}（单向 TLS）    │
│  • :8444  探针同步通道（mTLS）   /api/v1/agent-sync/{tasks,results,            │
│                                  snmp-results,renew-cert,my-ip,binary/:id}    │
│                                                                               │
│  内置引擎：ECDSA P-256 Root CA · gosmi MIB 解析引擎 · BART 高速路由前缀树        │
│           SecretBox（AES-256-GCM 双钥轮换，保护 SNMP 凭证 + 用户 TOTP 种子）    │
└──────────────┬────────────────────────────────────────┬───────────────────────┘
               │ GORM 连接池                             │ 双向 mTLS（探针直连，不经反代）
               ▼                                        ▼
     MySQL 8.0+ / MariaDB 10.6+                 NMS_Agent 边缘节点集群 × N
   33 张分域表（含 O(1) 最新快照表                  ├─ 主动拨测：ping / tcpping / httpcheck
   probe_latest_states 与多层归档桶）              │           dnscheck / traceroute / mtr
               ▲                                  │           meshping / meshmtr
               │ Direct SNMP Worker Pool          └─ 代理采集：snmp_poll（v1 / v2c / v3 USM）
               └──────────────► 受管网络设备 ◄──────────────────┘
```

| 监听端口（默认） | 配置项 | 传输层认证 | 访问方与网络要求 |
|-----------------|--------|------------|-----------------|
| `:8080` | `server.port` | HTTP（由前置 Nginx 终结 HTTPS） | 仅对本机或内网受信反向代理开放，承载浏览器 JWT API 与 `/api/health` |
| `:8443` | `agent_pki.enroll_port` | 单向 TLS（`tls.NoClientCert`） | 对公网/专网探针直连开放（**禁止走 Nginx 反代**），仅用于首次一次性 Token 注册引导 |
| `:8444` | `agent_pki.sync_port` | 强制双向 mTLS（`RequireAndVerifyClientCert`） | 对探针直连开放（**禁止走 Nginx 反代**），承载任务拉取、结果上报、证书续签与 OTA 下载 |

### 1.2 核心工程亮点

1. **三阶段零中断 Root CA 轮换**：支持 `Prepare（预分发）→ Rotate/Promote（激活切换）→ Finalize（终结旧 CA）` 全流程可视化编排。预分发阶段无需重启即将新旧 CA 合并下发至在线探针热更新信任锚；切换重启后自动识别旧 CA 客户端证书并下发 `renew_cert=true` 驱动探针 30 秒内平滑换证，全程零掉线。
2. **O(1) 实时快照与多层 RRA 降采样双轨存储**：高频写入热表 `probe_results` 通过 `(agent_id, task_id, target, reported_at)` 唯一键实现网络重传幂等去重，同时单调递增维护千行级快照表 `probe_latest_states`，使最新状态列表与全网 Mesh 矩阵彻底摆脱亿级热表聚合扫描；配合 Cacti RRA 风格多层归档（保存精确 `sum / cnt`），实现「近端秒级精度、远端十年趋势」。
3. **Direct + Agent Proxy 同构 SNMP 引擎**：公网/核心网设备由服务端内置并发池直采，内网隔离设备指派探针代理采集（任务随 `/agent-sync/tasks` 从 `devices` 表即时合成，无需双写任务表）；两条链路统一收敛至 `applySNMPResult` 状态机，严格隔离用户「管理状态」与机器「运行状态」，单独识别探针失联导致的 **Proxy Down**。
4. **双栈自适应 Mesh 编排**：探针启动时强制以 `tcp4` / `tcp6` 分别拨号 `/my-ip` 穿透云 NAT 反射真实公网双栈地址，并通过 `X-Agent-Stack` 权威声明节点当前可用协议栈；服务端按「源节点 ∩ 目标节点」可用协议栈动态裁剪 Mesh 互测目标，杜绝单栈节点产生永久伪告警。
5. **全链路静态加密与会话安全**：`SecretBox` 使用 AES-256-GCM 同时加密数据库中的 **SNMP v1/v2c/v3 凭证**与**用户 TOTP 两步验证种子**，支持不停服双口令平滑轮换；Refresh Token 采用旋转家族模型（30s 多标签宽限 + 超窗重放整族熔断吊销）；登录防爆破与限流器对 IPv6 自动按 `/64` 子网前缀归并，阻断 SLAAC 地址轮换绕过。
6. **大报文流式处理与异步分片清理**：Agent 二进制与 MIB 上传、四域审计日志 `?export=csv` 流式导出均通过 `http.ResponseController` 按需延长读写截止时间且不驻留全量内存；亿级历史探测清理与批量删除采用后台单飞 Job + `READ COMMITTED` 小事务分片推进 + 死锁指数退避，前端实时轮询进度。
7. **前后端错误码强契约**：后端静态业务错误统一返回机器码 `code` 与插值参数，前端 `apiErrors.ts` 双语渲染，CI 阶段由 `scripts/check-error-codes.mjs` 静态扫描全量 Go 与 TS 源码强制 100% 对齐。

### 1.3 代码目录结构

```text
NMS/
├── .github/workflows/release.yml      # GitHub Actions：v* Tag 自动校验错误码、构建前后端并发布 Release
├── scripts/check-error-codes.mjs      # CI 守卫：静态校验后端错误码与前端 i18n 词条 100% 映射一致
│
├── backend/                           # Go 1.26 后端工程（module: nms-backend）
│   ├── main.go                        # 启动装配：配置、DB 池、迁移清理、PKI、后台协程组与三端口优雅停机
│   ├── logger.go                      # 纯标准库按日轮转日志器（异步 gzip 压缩 + 天数/份数双维度保留）
│   ├── config.example.yaml            # 生产配置完整注释模板
│   ├── mibs_builtin/                  # go:embed 内置的 12 个标准基础 MIB 模块（SNMPv2 / IF-MIB 等）
│   ├── asndb/                         # 基于 BART 基数树的微秒级 IPv4/IPv6 → ASN 匹配与每日热更新调度
│   ├── core/
│   │   ├── errors.go                  # CodedError 结构化业务错误定义
│   │   ├── ipam_calc.go               # IPAM 纯算法层：严格规范化 CIDR 校验、2^n 二叉拆分与兄弟聚合
│   │   ├── pki.go                     # 内置 Root CA 与三阶段平滑轮换（Prepare / Promote / Finalize）
│   │   ├── secrets.go                 # SecretBox：SNMP 凭证与 TOTP 种子 AES-256-GCM 静态加密及双钥轮换
│   │   └── diskspace_*.go             # 磁盘剩余空间跨平台探测（Linux statfs）
│   ├── middleware/
│   │   ├── auth.go                    # JWT 鉴权 + 15s 用户状态缓存（变更即时失效）+ 强制改密与权限门禁
│   │   ├── mtls.go                    # mTLS 探针认证（CN=AgentID、序列号/吊销核验、双栈栈声明与 CA 指纹追踪）
│   │   ├── ratelimit.go               # 滑动窗口限流（IPv6 按 /64 子网归并防绕过）与安全响应头
│   │   └── recovery.go                # 统一 Panic 捕获与结构化堆栈日志
│   ├── models/                        # GORM 数据模型（ipam_ / device_ / sys_ / agent_ / probe_ 五大命名空间）
│   └── controllers/
│       ├── common.go                  # 公共响应、分页解析、流式传输超时扩展（extendTransferDeadlines）
│       ├── auth_api.go                # 登录、TOTP 二步挑战、旋转式 Refresh Token、自助改密与偏好同步
│       ├── login_protection.go        # 用户名+IP（IPv6 /64）与全局用户名双层防爆破锁定器
│       ├── system_api.go              # 用户/用户组 CRUD、会话吊销、2FA 重置、安全策略与审计 CSV 流式导出
│       ├── ipam_api.go                # 根前缀、L1/L2 子网树、受管设备地址空间利用率、拆分/合并与审计导出
│       ├── device_api.go              # 设备台账、站点/PoP/角色/厂商字典、SNMP 详情与直连即时测试
│       ├── device_snmp_poller.go      # SNMP 核心落库状态机（applySNMPResult）、Direct 轮询池与停滞看门狗
│       ├── device_snmp_oid_api.go     # 自定义标量 OID（gauge / counter 速率）与时序趋势查询
│       ├── device_metric_rollup.go    # 设备自定义指标多级降采样归档（MySQL GET_LOCK 多实例互斥）
│       ├── device_mib_api.go          # MIB 文件上传/校验/下载/删除接口
│       ├── device_mib_engine.go       # gosmi 纯 Go MIB 解析与最长前缀 OID 符号翻译引擎
│       ├── agent_enroll_api.go        # 一次性注册码原子消费、IP 防爆破与客户端证书签发
│       ├── agent_sync_api.go          # 任务合成下发、幂等分片入库、probe_latest_states 维护、续签与 OTA 流
│       ├── agent_admin_api.go         # 探针管理、任务编排、Token、三阶段 CA 轮换接口、OTA 版本与审计导出
│       ├── probe_results_api.go       # 历史明细、O(1) 最新快照、MeshPing 矩阵、延迟趋势自动选源查询
│       ├── probe_jobs.go              # 大表历史清理与批量删除后台异步单飞任务管理
│       ├── probe_rollup.go            # 探测结果 Cacti RRA 风格多级降采样归档
│       ├── audit_retention.go         # 四域审计与探测数据分层过期清理 + 小盘紧急空间守卫
│       ├── overview_api.go            # NOC 看板多维 KPI、环比与时间桶聚合接口
│       ├── asn_api.go                 # 批量 IP → ASN 查询及管理端在线下载/热重载接口
│       └── seed.go                    # 空库幂等初始化默认管理员组与 admin 账号
│
└── frontend/                          # React 19 + TypeScript 6 + Vite 8 + Ant Design 6
    └── src/
        ├── api/                       # Axios 单飞刷新客户端与分模块类型安全 API 封装
        ├── components/                # PageHeader / StatusTag / StatTile / MetricCard / LatencySpark 等公共组件
        ├── contexts/                  # AuthContext（会话生命周期）与 AppContext（亮暗主题 / 中英双语）
        ├── i18n/                      # 中英双语全量词典（translations.ts）与后端错误码词典（apiErrors.ts）
        ├── layouts/MainLayout.tsx     # 响应式分组侧边导航栏与顶部全局工具栏
        ├── pages/                     # Dashboard · Devices · IPAM · Agent · ProbeResults · System · Login
        ├── theme/theme.ts             # Clarity 设计系统令牌与自托管字体（Plus Jakarta Sans + IBM Plex Mono）
        ├── types/                     # 与后端 JSON 契约严格对齐的 TypeScript 接口定义
        └── utils/                     # 严格客户端 CIDR/树构建算法（cidr.ts）、权限钩子（perms.ts）、图表刻度工具
```

### 1.4 数据库分域模型（33 张表）

所有表共享同一 MySQL / MariaDB 库，通过命名前缀清晰隔离业务域，启动时由 `db.AutoMigrate` 自动维护结构（禁用内联外键以兼容不同 MySQL/MariaDB 版本的 DDL 约束规则，级联一致性由事务层显式保障）：

| 业务域 | 表数量 | 数据表清单 |
|--------|--------|------------|
| **IPAM 地址管理** | 6 | `ipam_groups` · `ipam_types` · `ipam_vrfs` · `ipam_root_prefixes` · `ipam_subnets` · `ipam_audit_logs` |
| **Devices 设备与采集** | 12 | `device_sites` · `device_pops` · `device_roles` · `device_vendors` · `devices` · `device_snmp_states` · `device_snmp_oids` · `device_metric_points` · `device_metric_rollups` · `device_interfaces` · `device_mibs` · `device_audit_logs` |
| **System 账号与安全** | 5 | `sys_groups` · `sys_users` · `sys_refresh_tokens` · `sys_settings` · `sys_audit_logs` |
| **Agent 探针管控** | 6 | `agent_groups` · `agents` · `agent_tokens` · `agent_tasks` · `agent_releases` · `agent_audit_logs` |
| **Probe Results 拨测数据** | 4 | `probe_results`（原始时序热表）· `probe_latest_states`（O(1) 最新快照表）· `probe_series`（序列维表）· `probe_rollups`（多层降采样归档桶） |

---

## 2. 快速开始

**运行环境要求**：Go ≥ 1.26（源码编译时）· Node.js ≥ 22（前端构建时）· MySQL ≥ 8.0 或 MariaDB ≥ 10.6。

### 2.1 使用预编译 Release 部署

前往 [GitHub Releases](https://github.com/Cion-1221/NMS/releases) 下载最新版本的两个产物：
- `nms-server`：Linux `amd64` 纯静态编译后端二进制（`CGO_ENABLED=0`）
- `dist.tar.gz`：前端生产静态资源包（交由 Nginx / Caddy 托管）

```bash
sudo mkdir -p /opt/nms && cd /opt/nms
# 放入 nms-server 并赋予可执行权限
sudo chmod +x nms-server
# 复制仓库 backend/config.example.yaml 为 config.yaml 并修改数据库密码、jwt.secret 与 server_san
./nms-server
```

> `nms-server` 固定读取**当前工作目录**下的 `config.yaml`（systemd 部署需配置 `WorkingDirectory`，详见 [6.2](#62-后端-systemd-服务编排)）。

### 2.2 源码编译与本地开发

```bash
# 1. 启动后端（监听 :8080 主 API + :8443 注册 + :8444 mTLS 同步）
cd backend
cp config.example.yaml config.yaml   # 配置本地 MySQL 连接信息与 jwt.secret
go mod tidy
go test -v ./...
go run .

# 2. 启动前端开发服（监听 :5173，自动代理 /api 至 127.0.0.1:8080）
cd frontend
npm install
npm run dev

# 3. 提交前自检（错误码契约检查 + 前端类型检查与打包）
node scripts/check-error-codes.mjs
cd frontend && npm run build
```

### 2.3 首次启动自动化流程

1. **配置与安全自检**：加载 `config.yaml` 并填充缺省值；若 `jwt.secret` 仍为默认占位符则输出醒目告警；校验 `audit.probe_rollups` 与 `snmp.metric_rollups` 桶粒度递增及原始保留期约束，配置矛盾时立即 fail-fast 退出。
2. **Schema 自动迁移与清理**：连接数据库并自动迁移全部 33 张表；幂等清理历史遗留废弃列；后台协程异步检查并建立 `probe_results` 唯一去重索引 `idx_probe_dedup`，并按类型自动回填存量 `probe_latest_states` 快照。
3. **默认管理员初始化**：空库首次启动自动创建 `admin` 组与初始账号 **`admin` / `admin`**（标记 `must_change_password = true`，首次登录强制改密后方可使用系统）。
4. **静态机密自动迁移**：若配置了 `snmp.credentials_key`，自动扫描并将库中存量明文 SNMP 凭证与用户 TOTP 种子加密升级为 `AES-256-GCM` 密文（双钥轮换期间自动重封旧密钥数据）。
5. **内置 MIB 与 PKI 就绪**：将内置的 12 个标准 MIB 模块幂等释放至 `data/mibs/` 并构建内存符号树；初始化或加载 `data/pki/` 下的 ECDSA P-256 Root CA（含过渡期 `ca-previous.crt` 与预分发 `ca-next.crt`），签发内存态服务端叶子证书并启动 `:8080`、`:8443`、`:8444` 监听。

---

## 3. 配置文件详解（`config.yaml`）

完整带注释模板位于 [`backend/config.example.yaml`](backend/config.example.yaml)。除数据库连接与 `jwt.secret` 外，其余配置块均可省略并自动回退至安全的生产默认值。

### 3.1 `server` — 监听端口、受信代理与连接超时

| 配置键 | 默认值 | 说明 |
|--------|--------|------|
| `port` | `8080` | 主 HTTP REST API 端口，建议仅监听本机供反向代理转发 |
| `trusted_proxies` | `["127.0.0.1", "::1"]` | 采信 `X-Forwarded-For` 的反向代理 IP / CIDR 白名单；异机部署 Nginx / LB 时务必填入其内网 IP |
| `read_header_timeout_seconds` | `10` | 读取请求头超时（秒），防御 Slowloris 慢速连接耗尽；`<=0` 不限制 |
| `read_timeout_seconds` | `30` | 常规请求读取超时（秒）；大文件上传接口内部自动动态延长至 10 分钟 |
| `write_timeout_seconds` | `120` | 常规响应写入超时（秒）；Agent 二进制下载与 CSV 流式导出自动动态延长至 10 分钟 |
| `idle_timeout_seconds` | `120` | Keep-Alive 空闲连接超时（秒），同时作用于 `:8080` / `:8443` / `:8444` |

### 3.2 `database` — MySQL / MariaDB 连接池

| 配置键 | 默认值 | 说明 |
|--------|--------|------|
| `host` / `port` / `user` / `password` / `dbname` | — | 数据库连接参数（固定启用 `utf8mb4`、`parseTime=True`、`loc=Local`） |
| `max_open_conns` | `50` | 最大并发打开连接数（兼顾 SNMP 轮询池、归档任务与高频上报） |
| `max_idle_conns` | `15` | 最大空闲连接数 |
| `conn_max_lifetime_minutes` | `60` | 单连接最大存活分钟数（**必须小于 MySQL `wait_timeout`**） |
| `conn_max_idle_time_minutes` | `10` | 空闲连接最长保留分钟数 |

### 3.3 `jwt` — 会话令牌签发

| 配置键 | 默认值 | 说明 |
|--------|--------|------|
| `secret` | 占位符 | **生产必改**：HS256 签名密钥，建议使用 `openssl rand -hex 32` 生成 ≥32 字节随机串 |
| `refresh_token_days` | `7` | 旋转式 Refresh Token 有效期（天）；Access Token 时长支持个人设置（1–720h）并受全局安全策略上限钳制 |

### 3.4 `snmp` — 双模式采集、归档与静态加密

| 配置键 | 默认值 | 说明 |
|--------|--------|------|
| `enabled` | `true` | SNMP 采集总开关；关闭后停止 Direct 轮询器、状态看门狗及 `snmp_poll` 代理任务合成 |
| `default_interval_seconds` | `60` | 默认快轮询周期（秒），支持在单台设备上独立覆盖（10–86400s） |
| `inventory_every_n` | `10` | 慢轮询倍率：每 N 次快轮询附带拉取一次完整 RFC 1213 `system` 组资产信息 |
| `timeout_seconds` / `retries` | `3` / `1` | 单次 SNMP 请求超时与重试次数 |
| `max_concurrent` | `16` | Direct 直连轮询器最大并发在途设备数 |
| `metrics_max_age_days` | `14` | 自定义标量 OID 原始点（`device_metric_points`）保留天数，`0` 为永久 |
| `metric_rollups` | 未启用 | 自定义指标多级降采样归档层（`bucket_minutes` 严格递增；启用时原始保留天数须 `≥ 最大桶天数×2 + 2`） |
| `mibs_dir` | `"data/mibs"` | MIB 模块文件持久化目录 |
| `credentials_key` | `""` | **静态加密主口令**（SHA-256 派生 AES-256-GCM 密钥），同时加密 **SNMP 团体字/v3 口令**与**用户 TOTP 种子** |
| `credentials_key_previous` | `""` | **平滑轮换旧口令**：换新 `credentials_key` 时将旧口令填入此处，重启后自动全量重封为新密钥，随后即可清空 |

### 3.5 `agent_pki` — 内置 Root CA 与双 TLS 通道

| 配置键 | 默认值 | 说明 |
|--------|--------|------|
| `enabled` | `true` | 是否启用内置 PKI 及 `:8443` / `:8444` 探针监听 |
| `dir` | `"data/pki"` | Root CA 私钥与证书持久化目录（**核心机密，严禁丢失或提交 Git**） |
| `releases_dir` | `"data/releases"` | OTA 待分发 Agent 二进制文件存储目录 |
| `enroll_port` / `sync_port` | `8443` / `8444` | 单向 TLS 注册端口 / 双向 mTLS 同步端口 |
| `server_san` | `["localhost", "127.0.0.1"]` | **生产必改**：服务端证书 SAN 列表，必须包含 Agent 配置中 `enroll_url` / `report_url` 使用的域名或公网 IPv4/IPv6 |
| `client_cert_days` | `365` | 签发给 Agent 的客户端证书有效期（天） |
| `server_cert_days` / `ca_cert_days` | `730` / `3650` | 服务端叶子证书有效期（每次进程启动自动重签）/ Root CA 有效期（天） |

### 3.6 `audit` — 分层保留、Cacti RRA 归档与磁盘兜底

| 配置键 | 默认值 | 说明 |
|--------|--------|------|
| `max_age_days` | `180` | 四大业务域审计日志保留天数，`0` 为永久 |
| `probe_results_max_age_days` | `30` | 原始拨测明细点保留天数（开启 `probe_rollups` 归档后推荐缩短为 `7`～`14` 天） |
| `path_results_max_age_days` | `0` | `mtr` / `meshmtr` / `traceroute` 大体积逐跳 JSON 独立保留天数（`0` 表示跟随上一项） |
| `probe_rollups` | 未启用 | 探测结果多层归档（推荐：`5m/183d`、`30m/366d`、`120m/1096d`、`1440m/3660d`） |
| `probe_disk_guard` | `enabled: false` | 小容量磁盘防爆兜底：每 `check_interval_minutes`（10）检测 `check_path` 剩余空间，低于 `critical_free_mb`（500 MB）立即触发安全边界内的紧急裁剪 |

### 3.7 `asndb` — 全球路由前缀与 ASN 自动标注

| 配置键 | 默认值 | 说明 |
|--------|--------|------|
| `enabled` | `false` | 启用后加载 CAIDA RouteViews IPv4/IPv6 前缀表与 RIPE AS 名称表，为 MTR / MeshMTR 逐跳 IP 标注 ASN 与运营商名称 |
| `v4_prefix_file` / `v6_prefix_file` / `names_file` | `"data/asndb/..."` | 本地路由表缓存路径 |
| `update_hour` | `3` | 每日自动拉取更新的本地整点小时（0–23），下载完成后通过原子指针无锁热切换 |

### 3.8 `log` — 结构化按日轮转日志

| 配置键 | 默认值 | 说明 |
|--------|--------|------|
| `dir` | `"logs"` | 日志目录，当前活跃文件为 `nms-server.log`，跨零点切分为 `nms-server-YYYY-MM-DD.log[.gz]` |
| `max_age_days` / `max_backups` / `compress` | `30` / `30` / `true` | 按天数与文件数双重清理，历史文件后台异步 gzip 压缩 |
| `level` / `format` | `"info"` / `"json"` | 级别支持 `debug`/`info`/`warn`/`error`；格式支持 `json` 或 `text` |
| `stdout` / `access_log` | `false` / `true` | 是否同步输出至标准输出 / 是否记录主引擎 HTTP 访问日志 |

### 3.9 生产备份与机密清单

- **必备份项**：`config.yaml`（含 `jwt.secret`、`snmp.credentials_key`）· `data/pki/`（含 `ca.crt`、`ca.key`，丢失将导致存量探针全部失联需重绑）· `data/mibs/` · `data/releases/` · MySQL 数据库。
- **无需备份项**：`data/asndb/`（可随时在线拉取重建）· `logs/`。

---

## 4. 功能模块全景

前端采用清晰的一级导航 + 页面内多 Tab 组织（切换 Tab 自动递增版本号拉取最新状态）：

```text
📊 总览 Dashboard        /dashboard        NOC 核心 KPI · 环比趋势 · 探测吞吐柱图 · 设备双状态分面 · 实时告警
🏗️ 基础设施
   ├─ 设备 Devices       /devices          设备列表 · 站点与 PoP · 设备角色 · 厂商字典 · MIB 库 · 设备审计日志
   └─ 地址管理 IPAM       /ipam             根前缀 · 子网树（含设备利用率）· 分组 · 类型 · VRF · IPAM 审计日志
📡 拨测监控
   ├─ 探针管理 Agent      /agents  [admin]  Agent 列表 · 分组 · 任务下发 · 注册码与 CA 轮换 · 版本更新 · 操作日志
   └─ 探测结果 Results    /probe-results    Ping · TCP Ping · HTTP Check · DNS 解析 · Traceroute · MTR · MeshPing
⚙️ 系统管理              [admin]
   ├─ 用户管理 Users      /system/users     用户启停/改密 · 活跃会话明细与单点踢出 · 2FA 状态与重置
   ├─ 用户组 Groups       /system/groups    细粒度模块写权限分配（admin / ipam:write / devices:write）
   └─ 安全设置 Settings   /system/settings  登录防爆破与会话上限配置 · 实时锁定解锁 · 系统安全审计日志
```

### 4.1 NOC 运行总览（Dashboard）

- 单一聚合接口 `GET /api/v1/overview?range=1h|24h|7d` 驱动，支持 `1H`（5m 桶）、`24H`（1h 桶）、`7D`（6h 桶）一键切换与 30 秒无感轮询。
- 顶部四张 KPI 卡片展示受管设备数、在线探针数、窗口拨测总次数与失败率，附带迷你趋势线及与上一等长周期的环比变化。
- 设备健康卡片同时呈现管理状态分布与 SNMP 运行状态分面（显式单列 **Proxy Down** 代理链路中断告警）；底部聚合 Top 分组在线率与最新异常拨测事件。

### 4.2 设备台账与 SNMP 监控（Devices）

- **三层物理拓扑与双状态解耦**：`Site（站点）→ PoP（机房）→ Device（设备）`。用户维护的**管理状态**（`active` / `maintenance` / `planned`）与采集器维护的**运行状态**（`up` / `down` / `unknown` + `oper_reason`）严格分离，采集故障绝不篡改资产台账状态。
- **SNMP v1 / v2c / v3 USM 双模式采集**：支持服务端直连（`direct`）或指定边缘探针代理（`agent`）；支持 `sysUpTime` 回退重启检测、系统组资产自动发现、`sysObjectID` 自动符号翻译。
- **自定义标量 OID 与接口表监控**：单设备支持最多 16 个自定义标量 OID（支持 `gauge` 瞬时值与 `counter` 每秒速率自动换算及 64 位防溢出处理），提供 1 小时至 90 天趋势曲线；开启 `collect_interfaces` 后自动同步 `ifTable`/`ifXTable`（优先采用 `ifHCInOctets`/`ifHCOutOctets` 64 位计数器换算实时吞吐率）。
- **内置 gosmi MIB 引擎**：自带 12 个标准 RFC MIB，支持管理员上传私有厂商 MIB（自动解析校验与全量热重建）及在线 OID 翻译器。

### 4.3 双栈地址规划（IPAM）

- 原生支持 IPv4 / IPv6 双栈根前缀管理，客户端与服务端双重执行严格规范化网络位校验（非规范主机位自动给出修正建议）与根前缀重叠冲突检测。
- **无洞无重叠子网树**：L1 / L2 子网树强制通过二进制幂等 **Split（拆分）** 与相邻同父兄弟 **Merge（聚合）** 演进，禁止破坏树完整性的单点随意删除。
- **受管设备地址空间利用率联动**：自动将设备台账中的双栈管理 IP 映射归属到叶子子网，直观展示各网段地址空间占用百分比与关联设备数量徽标。

### 4.4 分布式探针管控（Agent 管理）

包含 **Agent 列表、分组、任务下发、注册码（含 Root CA 管理）、版本更新、操作日志** 6 个子面板：
- **精细化双栈出口与互测控制**：支持查看探针公网 IPv4/IPv6、协议栈声明（`stack`）、证书到期时间与系统架构；可配置 `Source IP Override`（单栈或 `ipv4 / ipv6` 双栈格式）同时控制探针拨测源地址绑定与 Mesh 对端目标地址。
- **8 类主动拨测任务编排**：支持 `ping`、`tcpping`、`httpcheck`、`dnscheck`（支持 `domain` 或指定上游 `domain@server[:port]`）、`traceroute`、`mtr`、`meshping`、`meshmtr`；支持一次勾选多协议批量拆单、三级下发范围（全局 / 分组 / 单节点）、域名解析地址族控制（`auto` / `v4` / `v6` / `both` 双序列对照）以及 `httpcheck` 跳过自签证书校验。
- **一次性 Token、三阶段平滑 CA 轮换与可视化 OTA**：详见 [5.1](#51-三阶段零中断-root-ca-平滑轮换)。OTA 面板支持流式上传各平台编译后的 `nms-agent` 纯二进制文件、按 `os/arch` 互斥激活，并每 10 秒实时追踪全网探针升级进度。

### 4.5 拨测质量与全网矩阵（Probe Results）

包含 **Ping、TCP Ping、HTTP Check、DNS 解析、Traceroute、MTR、MeshPing** 7 个完整结果视图：
- **O(1) 最新快照与历史切换**：默认展示每个 `(Agent, Target)` 的最新状态（秒开无延迟），支持一键切换全量历史时间线，支持按关键字、探针主机名、去重 Target 下拉与成功/失败过滤，悬停延迟数值即显近 24 小时迷你 Sparkline。
- **路径逐跳透视与 ASN 标注**：`Traceroute` 与 `MTR` 支持行内展开逐跳 RTT、丢包率、最值/标准差及路由跳 ASN 归属信息。
- **双栈全网 Mesh 矩阵**：`MeshPing` 以 `N × N` 双向矩阵实时渲染节点间 IPv4 / IPv6 互测延迟热力格（自动剔除超 24 小时未刷新的陈旧序列），点击任意单元格可直接下钻对应的 `MeshMTR` 逐跳路由路径或打开历史延迟/丢包双轴趋势图（支持 CSV 导出）。
- **后台异步清理与批量删除**：按保留天数清理全表或勾选多对 `(Agent, Target)` 批量删除均在后台分片异步执行，弹窗实时展示精确行数进度并支持切入后台运行。

### 4.6 用户、权限与安全中心（System）

- **三级 RBAC 权限体系**：所有登录用户默认具备只读观测权限；用户组可按需勾选 `ipam:write`、`devices:write` 或超级管理员 `admin`，前后端双重校验，且内置防呆锁死保护（禁止删除或降权系统最后一个可用管理员账号/管理员组）。
- **精细化会话与 TOTP 管控**：支持查看任意用户名下的活跃登录会话（含来源 IP、User-Agent、签发与到期时间）并单点踢出或一键全退；支持个人开启 RFC 6238 TOTP 两步验证与 8 枚一次性恢复码，验证器遗失时可由管理员安全重置。
- **全系统流式审计导出**：IPAM、Devices、Agent、System 四大模块的审计日志均支持多条件检索、按天数清理及 **一键流式导出 CSV**（UTF-8 BOM 编码，分批流式扫描最高 10 万行，Excel 直接打开不乱码）。

---

## 5. 关键机制深度解析

### 5.1 三阶段零中断 Root CA 平滑轮换

传统直接替换服务端 Root CA 会导致服务端重启瞬间 `:8444` 签发的新叶子证书不被存量探针认识，造成全网探针永久断连。本项目通过三阶段状态机彻底消除断连窗口：

```text
阶段 1：预分发新 CA         POST /api/v1/agents/ca/prepare
  ├─ 服务端生成 ca-next.{crt,key}，不改变当前活跃签发者（无需重启）
  ├─ /agent-sync/tasks 响应附带 ca_bundle_pem = Active CA + Next CA
  ├─ 在线 Agent 30s 内原子热更新本地 .certs/ca.crt 并通过 X-Agent-CA-FP 回报指纹
  └─ 管理面板实时显示「新 CA 信任链同步：X / Y 台在线已就绪」

阶段 2：激活新 CA           POST /api/v1/agents/ca/rotate  +  重启 nms-server
  ├─ 原 ca.crt 归档为 ca-previous.crt，ca-next 提升为活跃 ca.{crt,key}
  ├─ 重启后 :8443/:8444 叶子证书由新 CA 签发（Agent 已在阶段 1 信任新 CA，零握手失败）
  ├─ 服务端信任池同时接纳新旧 CA；识别仍持旧 CA 客户端证书的探针并下发 renew_cert = true
  ├─ 在线 Agent 立即调用 /agent-sync/renew-cert 换取新 CA 签发的客户端证书
  └─ 管理面板实时显示「新 CA 客户端证书续期：X / Y 台在线已就绪」

阶段 3：终结轮换            POST /api/v1/agents/ca/finalize +  重启 nms-server
  └─ 删除 ca-previous.crt，重启后从服务端信任池彻底移除旧 CA
```

### 5.2 SNMP 双模式汇聚状态机

无论是服务端内置 Worker Pool 直连轮询（`Direct`），还是探针端执行合成任务回传 `/agent-sync/snmp-results`（`Agent Proxy`），全部采集观测最终经单调时间守卫校验后进入唯一状态机入口 `applySNMPResult`：
- **防重放乱序保护**：探针断网重连补传的旧快照若 `collected_at <= last_collected_at`，会被识别为 `stale` 安全丢弃，绝不倒退设备当前状态与计数器基准。
- **停滞看门狗（Watchdog）**：后台每分钟巡检所有开启采集的设备，若超过 `max(3 × 采集间隔, 300s)` 未收到新结论则自动置为 `unknown`（代理模式下标记 `oper_reason = agent_down`，在看板与列表中高亮为 **Proxy Down**）。

### 5.3 `probe_latest_states` 快照加速与 Cacti RRA 降采样归档

- **读写分离的快照设计**：每次上报入库在完成 `probe_results` 幂等插入后，先在内存按 `(type, agent_id, target)` 归并批次内最新点，再以 `VALUES(reported_at) >= reported_at` 条件幂等更新 `probe_latest_states`。这使得 `/probe-results/latest` 与 `/probe-results/meshping-matrix` 仅需访问千行级快照表，彻底消除大表 `GROUP BY` 慢查询。
- **无损跨级重聚合归档**：每小时归档协程扫描近 26 小时窗口，将标量探测点与自定义 SNMP 指标聚合写入各配置层桶，持久化 `lat_sum / lat_cnt / min / max / runs / failed`。延迟趋势接口 `/latency-series` 根据查询起点自动选取能覆盖该时间窗的最细数据源，并对齐为 `≤ 500` 个显示点返回。

### 5.4 纵深安全基线

- **认证与会话防重放**：密码采用 `bcrypt`（显式拦截 >72 字节超长输入避免截断碰撞）；Refresh Token 仅存 SHA-256 哈希，旋转后超出 30 秒并发宽限期再次使用即判定令牌泄露，立即吊销整个 `family_id` 会话树并记录安全审计。
- **IPv6 `/64` 归并防爆破与限流**：登录防爆破（支持「用户名+IP」与「跨 IP 全局用户名」双阈值）及未认证接口滑动窗口限流器自动将 IPv6 客户端地址掩码归并为 `/64` 前缀，防止利用海量 IPv6 地址池绕过封禁；不存在账号、停用账号与密码错误对外耗时与报错完全一致，杜绝用户名枚举。
- **严格 CSP 与静态自托管字体**：前端通过 `@fontsource` 本地打包 Plus Jakarta Sans 与 IBM Plex Mono 字体，无任何外部 CDN 依赖，配合 `script-src 'self'; object-src 'none'; frame-ancestors 'none'` 严格内容安全策略阻断 XSS 外联。

### 5.5 后台常驻协程与优雅停机编排

收到 `SIGINT` / `SIGTERM` 信号时，进程通过统一的根上下文 `appCtx` 与 `sync.WaitGroup` 按序优雅收尾：
1. 先在 15 秒窗口内优雅关闭 `:8080`、`:8443`、`:8444` 三个 HTTP/TLS 监听器，等待在途请求返回；
2. 通知所有后台协程（SNMP 轮询池、状态看门狗、Agent 离线扫描、探测/指标归档、保留清理、磁盘空间守卫、ASN 更新器及异步清理任务 `WaitProbeJobs`）停止新轮次并在 10 秒窗口内安全落盘收尾；
3. 最后关闭 MySQL 连接池并刷盘关闭按日轮转日志文件，确保零截断、零悬挂事务。

---

## 6. 生产部署与运维手册

以下以 **Debian 12/13 或 Ubuntu 24.04 LTS** 生产环境为例。

### 6.1 数据库初始化

```bash
sudo apt update && sudo apt install -y default-mysql-server
sudo mysql <<'EOF'
CREATE DATABASE IF NOT EXISTS nms_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'nms_user'@'127.0.0.1' IDENTIFIED BY '请替换为高强度随机密码';
GRANT ALL PRIVILEGES ON nms_db.* TO 'nms_user'@'127.0.0.1';
FLUSH PRIVILEGES;
EOF
```

### 6.2 后端 systemd 服务编排

```bash
sudo useradd -r -s /sbin/nologin -d /opt/nms nms || true
sudo mkdir -p /opt/nms/data /opt/nms/logs
# 将 nms-server 与填写好的 config.yaml 放入 /opt/nms
sudo chmod 755 /opt/nms/nms-server
sudo chmod 600 /opt/nms/config.yaml
sudo chown -R nms:nms /opt/nms

sudo tee /etc/systemd/system/nms-server.service > /dev/null <<'EOF'
[Unit]
Description=CION NMS Backend Server
After=network-online.target mysql.service mariadb.service
Wants=network-online.target

[Service]
Type=simple
User=nms
Group=nms
WorkingDirectory=/opt/nms
ExecStart=/opt/nms/nms-server
Restart=on-failure
RestartSec=5s
TimeoutStopSec=30s

NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/opt/nms

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now nms-server
```

> **防火墙策略**：对探针节点放行 TCP `8443` 与 `8444` 端口（直连 `nms-server`）；`8080` 端口保持仅本机回环访问，由 Nginx 反代对外提供 `443` HTTPS 服务。

### 6.3 前端部署与 Nginx 安全反代

```bash
sudo mkdir -p /var/www/nms
sudo tar -xzf dist.tar.gz -C /var/www/nms

sudo tee /etc/nginx/sites-available/nms > /dev/null <<'EOF'
server {
    listen 80;
    server_name nms.example.com;
    server_tokens off;

    add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;

    location / {
        root /var/www/nms/dist;
        index index.html;
        try_files $uri $uri/ /index.html;
    }

    # 常规 REST API 与审计 CSV 流式导出
    location /api/ {
        proxy_pass         http://127.0.0.1:8080;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        client_max_body_size 2m;
        proxy_read_timeout   600s;
    }

    # Agent 二进制包（上限 256 MiB）与 MIB 上传专用长超时通道
    location ~ ^/api/v1/(agent-releases|devices/mibs)$ {
        proxy_pass         http://127.0.0.1:8080;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        client_max_body_size 260m;
        proxy_read_timeout   600s;
        proxy_send_timeout   600s;
    }
}
EOF

sudo ln -sf /etc/nginx/sites-available/nms /etc/nginx/sites-enabled/nms
sudo nginx -t && sudo systemctl reload nginx
# 生产环境签发 HTTPS 证书：sudo certbot --nginx -d nms.example.com
```

### 6.4 版本平滑升级与回滚

1. **备份数据库与旧二进制**：`cp /opt/nms/nms-server /opt/nms/nms-server.bak` 并做好常规数据库备份。
2. **更新后端与前端**：替换 `/opt/nms/nms-server` 后执行 `sudo systemctl restart nms-server`（启动时自动完成增量表/列迁移）；同步替换 `/var/www/nms/dist` 静态资源。
3. **Agent OTA 分发注意事项**：在管理界面「Agent 管理 → 版本更新」上传新探针版本时，请先将 GitHub Release 下载的 `.tar.gz` / `.zip` 压缩包解压，**仅上传解压后的可执行二进制文件本身**（Linux/macOS 为 `nms-agent`，Windows 为 `nms-agent.exe`）。

### 6.5 常见故障排查速查表

| 现象 | 排查方向与解决办法 |
|------|-------------------|
| Agent 报错 `x509: certificate is valid for localhost, not ...` | `config.yaml` 的 `agent_pki.server_san` 未包含探针实际连接的域名或公网 IP；补齐后重启 `nms-server` 即可自动重签服务端证书 |
| Agent 进程正常运行但界面显示 `offline` | 检查服务器安全组/防火墙是否放行 TCP `8444`，且确认探针 `report_url` 直连 `:8444` 而未经过 Nginx 反代 |
| 上传 Agent 二进制报 `413 Request Entity Too Large` 或超时中断 | 检查 Nginx 是否按 [6.3](#63-前端部署与-nginx-安全反代) 配置了 `client_max_body_size 260m` 与 `600s` 超时 |
| 升级后前端提示“接口不存在” | 前端 `dist.tar.gz` 与后端 `nms-server` 版本未同步更新，请确保前后端产物成对升级并重启 `nms-server` |
| 厂商 MIB 上传后状态显示未解析 | 该 MIB `IMPORTS` 引用的前置依赖模块尚未上传；补传对应基础 MIB 后系统会自动全量重建恢复正常 |
| 小盘机器数据库空间告警 | 在 `config.yaml` 中开启 `audit.probe_disk_guard.enabled: true`，配置 `audit.probe_rollups` 并缩短 `probe_results_max_age_days` |

---

## 7. CI/CD 构建与错误码契约

本仓库通过 GitHub Actions（[`.github/workflows/release.yml`](.github/workflows/release.yml)）采用 **Tag 驱动发版**：

```bash
git tag v1.32.0
git push origin main v1.32.0
```

推送 `v*` Tag 后流水线自动执行四步闭环：
1. **API 错误码强一致性校验**：运行 `node scripts/check-error-codes.mjs`，验证后端所有 `Code` / `"code"` 与前端 `frontend/src/i18n/apiErrors.ts` 双语词条一一对应，杜绝漏配；
2. **前端类型检查与打包**：执行 `npm install && npm run build`（`tsc && vite build`）生成 `dist.tar.gz`；
3. **后端测试与静态编译**：执行 `go mod tidy && go test ./...` 后编译 `CGO_ENABLED=0 GOOS=linux GOARCH=amd64` 生产二进制 `nms-server`；
4. **自动提取提交历史生成 Changelog** 并发布 GitHub Release。

---

## 8. REST / mTLS API 全景速查

除 `/api/health` 外，所有接口均挂载于 `/api/v1` 下：

| 模块与监听端口 | 核心端点路由 | 权限与说明 |
|---------------|-------------|-----------|
| **健康检查** (`:8080`) | `GET /api/health` | 公开（按 IP 限流 120/min），实时 Ping 数据库连通性，异常返回 `503` |
| **认证与个人中心** (`:8080`) | `POST /auth/login` · `POST /auth/login/totp` · `POST /auth/refresh` · `POST /auth/logout`<br>`GET /auth/me` · `POST /auth/change-password` · `PUT /auth/settings` · `PUT /auth/profile`<br>`POST /auth/totp/{setup,enable,disable,recovery-codes}` | JWT 会话生命周期、TOTP 二步验证绑定与恢复码管理、跨设备主题/语言偏好持久化 |
| **NOC 看板与 ASN** (`:8080`) | `GET /overview?range=1h\|24h\|7d`<br>`GET /asn?ips=...` · `POST /admin/asndb/{download,reload}` | 登录可读看板与批量 IP→ASN 查询；ASN 下载与热重载仅 `admin` |
| **IPAM 地址管理** (`:8080`) | `CRUD /ipam/root-prefixes[/:id]` · `GET /ipam/root-prefixes/:id/tree`<br>`POST /ipam/{split,merge}` · `PUT /ipam/subnets/:id`<br>`CRUD /ipam/{groups,types,vrfs}` · `GET / DELETE /ipam/audit-logs[?export=csv]` | 登录只读；写操作需 `ipam:write`；审计清理仅 `admin`，支持 `?export=csv` 流式导出 |
| **设备与 SNMP** (`:8080`) | `CRUD /devices[/:id]` · `CRUD /devices/{sites,pops,roles,vendors}` · `GET /devices/agents-lite`<br>`GET /devices/:id/snmp` · `POST /devices/:id/snmp/test`<br>`CRUD /devices/:id/snmp/oids[/:oid_id]` · `GET /devices/:id/snmp/oids/:oid_id/series`<br>`GET / POST / DELETE /devices/mibs[/:id[/download]]` · `GET /devices/mibs/translate`<br>`GET / DELETE /devices/audit-logs[?export=csv]` | 登录只读；资产与 SNMP 写操作需 `devices:write`；MIB 上传/删除与审计清理仅 `admin` |
| **Agent 管控与 PKI** (`:8080`) | `GET /agents-lite`（登录可读）· `GET /agents` · `GET /agents/{summary,filter-options}`<br>`PUT / DELETE /agents/:agent_id` · `POST /agents/:agent_id/revoke`<br>`GET /agents/ca-cert` · `GET /agents/ca/status` · `POST /agents/ca/{prepare,rotate,finalize}`<br>`CRUD /agent-groups` · `CRUD /agent-tasks` · `GET / POST /agent-tokens` · `POST /agent-tokens/:id/revoke`<br>`GET / POST / DELETE /agent-releases[/:id]` · `POST /agent-releases/:id/set-active` · `GET /agent-releases/:id/progress`<br>`GET / DELETE /agents/audit-logs[?export=csv]` | 除 `/agents-lite` 外均需 `admin`；涵盖三阶段平滑 CA 轮换、多协议任务编排、OTA 与审计流式导出 |
| **拨测结果分析** (`:8080`) | `GET /probe-results` · `GET /probe-results/latest` · `GET /probe-results/targets`<br>`GET /probe-results/meshping-matrix` · `GET /probe-results/latency-series`<br>`DELETE /probe-results?days=N` · `DELETE /probe-results/pair` · `POST /probe-results/pairs/bulk-delete` · `GET /probe-results/jobs/:id` | 登录可读全量查询与趋势导出；同步删除与后台异步分片清理（`jobs/:id`）仅 `admin` |
| **系统与安全设置** (`:8080`) | `CRUD /system/{users,groups}` · `POST /system/users/:id/{force-logout,totp/reset}`<br>`GET / DELETE /system/users/:id/sessions[/:sid]`<br>`GET / PUT /system/settings/{security,session}` · `GET / POST /system/security/lockouts[/unlock]`<br>`GET / DELETE /system/audit-logs[?export=csv]` | 全部需 `admin` |
| **探针注册通道** (`:8443`) | `POST /agents/enroll` · `GET /agents/ca-cert` | 单向 TLS，一次性 Token 原子核销并签发客户端证书与完整 CA 信任包 |
| **探针同步通道** (`:8444`) | `GET /agent-sync/tasks` · `POST /agent-sync/results` · `POST /agent-sync/snmp-results`<br>`POST /agent-sync/renew-cert` · `GET /agent-sync/my-ip` · `GET /agent-sync/binary/:id` | 强制双向 mTLS，承载任务/CA 信任包/续签指令下发、结果幂等入库、双栈 IP 反射与 OTA 流式下载 |

---

## 9. License

本项目采用 [MIT License](LICENSE) 开源许可 © 2026 CION。
