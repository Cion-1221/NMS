# 🌐 CION NMS — 网络管理系统

企业级生产标准的**网络管理系统（NMS）**：Go 单进程后端 + React 前端，按业务域模块化组织。覆盖 **IPAM 地址管理、设备台账与 SNMP 采集、分布式探针（mTLS Agent）、探测结果分析、用户权限体系**五大领域，自带 NOC 运行总览看板。

[![Build and Release](https://github.com/Cion-1221/NMS/actions/workflows/release.yml/badge.svg)](https://github.com/Cion-1221/NMS/actions/workflows/release.yml)
![Go Version](https://img.shields.io/badge/go-1.26-00ADD8?logo=go)
![React](https://img.shields.io/badge/react-19-61DAFB?logo=react)
![antd](https://img.shields.io/badge/antd-6-1677FF)
![Database](https://img.shields.io/badge/db-MySQL%20%7C%20MariaDB-4479A1?logo=mysql)
![License](https://img.shields.io/badge/license-MIT-green)

> 探测任务的**执行方**（真正跑 ping / mtr / SNMP 的 Agent 程序）是独立项目 [NMS_Agent](https://github.com/Cion-1221/NMS_Agent)。本仓库的 Server 负责 Agent 的注册引导、任务调度、结果存储与展示，并通过 Releases 功能向 Agent 分发二进制更新。

---

## 📖 目录

- **[1. 项目概览](#1-项目概览)**
  - [1.1 一句话架构](#11-一句话架构)
  - [1.2 核心特性一览](#12-核心特性一览)
  - [1.3 架构图](#13-架构图)
  - [1.4 目录结构](#14-目录结构)
- **[2. 快速开始](#2-快速开始)**
  - [2.1 下载预编译产物](#21-下载预编译产物)
  - [2.2 从源码构建与本地开发](#22-从源码构建与本地开发)
  - [2.3 首次启动做了什么](#23-首次启动做了什么)
  - [2.4 验证启动](#24-验证启动)
- **[3. 配置说明](#3-配置说明)**
  - [3.1 server 块 — 端口与受信代理](#31-server-块--端口与受信代理)
  - [3.2 database 块 — 连接池](#32-database-块--连接池)
  - [3.3 jwt 块 — 令牌签发](#33-jwt-块--令牌签发)
  - [3.4 audit 块 — 保留策略与归档](#34-audit-块--保留策略与归档)
  - [3.5 snmp 块 — 设备采集](#35-snmp-块--设备采集)
  - [3.6 agent_pki 块 — 内置 CA 与 Agent 端口](#36-agent_pki-块--内置-ca-与-agent-端口)
  - [3.7 asndb 块 — IP 到 ASN 标注](#37-asndb-块--ip-到-asn-标注)
  - [3.8 log 块 — 日志轮转](#38-log-块--日志轮转)
  - [3.9 敏感信息与备份清单](#39-敏感信息与备份清单)
- **[4. 功能模块](#4-功能模块)**（一个菜单一个功能，页面内 Tab 即子功能）
  - [4.1 总览 Dashboard](#41-总览-dashboard)
  - [4.2 设备 Devices](#42-设备-devices)
    - [4.2.1 设备列表与双状态模型](#421-设备列表与双状态模型)
    - [4.2.2 SNMP 采集 Direct 与 Agent Proxy](#422-snmp-采集-direct-与-agent-proxy)
    - [4.2.3 自定义 OID 与指标时序](#423-自定义-oid-与指标时序)
    - [4.2.4 接口表采集](#424-接口表采集)
    - [4.2.5 站点 PoP 角色 厂商](#425-站点-pop-角色-厂商)
    - [4.2.6 MIB 库与翻译引擎](#426-mib-库与翻译引擎)
    - [4.2.7 设备审计日志](#427-设备审计日志)
  - [4.3 IPAM 地址管理](#43-ipam-地址管理)
  - [4.4 Agent 管理](#44-agent-管理)
    - [4.4.1 Agent 列表](#441-agent-列表)
    - [4.4.2 分组](#442-分组)
    - [4.4.3 探测任务 Probe Config](#443-探测任务-probe-config)
    - [4.4.4 注册码与 CA 管理](#444-注册码与-ca-管理)
    - [4.4.5 版本发布 OTA](#445-版本发布-ota)
  - [4.5 探测结果 Probe Results](#45-探测结果-probe-results)
    - [4.5.1 通用结果 Tab](#451-通用结果-tab)
    - [4.5.2 MeshPing 矩阵](#452-meshping-矩阵)
    - [4.5.3 延迟趋势图](#453-延迟趋势图)
    - [4.5.4 清理与批量删除](#454-清理与批量删除)
  - [4.6 用户管理](#46-用户管理)
  - [4.7 用户组与权限模型](#47-用户组与权限模型)
  - [4.8 安全设置](#48-安全设置)
  - [4.9 全局能力](#49-全局能力)
- **[5. 高级主题](#5-高级主题)**
  - [5.1 三端口模型与 mTLS](#51-三端口模型与-mtls)
  - [5.2 SNMP 采集链路与状态机](#52-snmp-采集链路与状态机)
  - [5.3 分层保留与降采样归档](#53-分层保留与降采样归档)
  - [5.4 安全设计](#54-安全设计)
  - [5.5 后台任务一览](#55-后台任务一览)
  - [5.6 数据模型与模块隔离](#56-数据模型与模块隔离)
  - [5.7 前端设计系统](#57-前端设计系统)
- **[6. 部署运维](#6-部署运维)**
  - [6.1 数据库](#61-数据库)
  - [6.2 后端 systemd 常驻](#62-后端-systemd-常驻)
  - [6.3 前端与 Nginx](#63-前端与-nginx)
  - [6.4 HTTPS](#64-https)
  - [6.5 升级与回滚](#65-升级与回滚)
  - [6.6 常用管理命令](#66-常用管理命令)
  - [6.7 故障排查](#67-故障排查)
- **[7. 构建与发布 CI](#7-构建与发布-ci)**
- **[8. API 速查](#8-api-速查)**
  - [8.1 认证](#81-认证)
  - [8.2 IPAM](#82-ipam)
  - [8.3 Devices](#83-devices)
  - [8.4 System](#84-system)
  - [8.5 Agent 注册 enroll 端口](#85-agent-注册-enroll-端口)
  - [8.6 Agent 同步 sync 端口](#86-agent-同步-sync-端口)
  - [8.7 Agent 管理](#87-agent-管理)
  - [8.8 探测结果](#88-探测结果)
  - [8.9 其他](#89-其他)
- **[9. 配套项目 NMS Agent](#9-配套项目-nms-agent)**
- **[10. License](#10-license)**

---

## 1. 项目概览

### 1.1 一句话架构

**一个 Go 进程、三个监听端口、一套 MySQL**：`:8080` 给浏览器提供 JWT REST API（经 Nginx 反代），`:8443` 单向 HTTPS 供 Agent 用一次性注册码换取客户端证书，`:8444` 双向 mTLS 供 Agent 拉任务、报结果、续证书、拉二进制。前端是纯静态的 React 19 + Ant Design 6 单页应用；SNMP 设备采集既可由 Server 直连，也可指派给探针代理，两条路径汇聚到同一落库函数；探测结果与设备指标按 Cacti RRA 的思路分层归档，长期趋势不依赖原始点保留期。

### 1.2 核心特性一览

| # | 特性 | 说明 |
|---|------|------|
| 1 | **五大业务域模块化** | IPAM / Devices / Agent / Probe Results / System 各自拥有独立的路由注册函数、前缀表名、前端页面目录与审计日志表，互不耦合 |
| 2 | **内置 CA + mTLS 探针体系** | 纯标准库 PKI（ECDSA P-256）：一次性注册码原子消费 → 签发客户端证书（CN=AgentID）→ 之后全部通信走 mTLS；支持证书自助续期、CA 轮换与终结 |
| 3 | **8 种探测类型集中调度** | ping · tcpping · httpcheck · dnscheck · traceroute · mtr · meshping · meshmtr；三级 Scope（全局 / 分组 / 单台）；meshping 目标由 Server 按同组存活 Agent 动态解析 |
| 4 | **SNMP 双模式采集** | Direct（Server 内置 worker pool 轮询器）或 Agent Proxy（探针代理，任务从 devices 表即时合成）；v1 / v2c / v3 USM 全支持；快慢两档轮询 + 运行状态看门狗 |
| 5 | **管理状态与运行状态分离** | `status`（用户意图）与 `oper_status`（机器结论）双字段，采集永不改写用户设置；探针失联的设备单列为 Proxy Down |
| 6 | **自定义 OID 时序 + 接口表** | 每台 ≤16 条标量 OID（gauge / counter 每秒速率），趋势图 1h–90d；可选 WALK ifTable/ifXTable 维护接口维表并换算 bit/s |
| 7 | **MIB 翻译引擎** | gosmi 纯 Go 解析，12 个标准基础 MIB 编译进二进制，上传厂商 MIB 即可把数字 OID 翻译为可读名 |
| 8 | **Cacti RRA 风格分层归档** | 探测结果与设备指标都支持多层降采样（如 5min/6月 → 1d/10年），存 sum/cnt 精确重聚合，趋势图自动选源 |
| 9 | **异步维护任务** | 清理历史数据 / 批量删除在后台分片执行并返回 job_id，前端每秒轮询进度，热表上的大删除不再撞客户端与反代超时 |
| 10 | **IPAM 结构化子网树** | 严格 CIDR 校验，Split / Merge 保证树永远无洞无重叠；L1/L2 子网禁止单独删除 |
| 11 | **OTA 升级** | 上传各 OS/Arch 二进制并激活，Agent 在下一次任务同步中收到 `update` 指令，自行下载校验 SHA256 并原地重启；进度可视 |
| 12 | **模块级权限 + 双重门禁** | `admin` / `ipam:write` / `devices:write` 固化进 JWT，前端按权限隐藏入口，后端中间件强制校验 |
| 13 | **安全基线** | 可选两步验证（TOTP + 一次性恢复码）、登录防爆破（用户名+IP 与跨 IP 用户名两级锁定）、未认证端点按 IP 限速、旋转式 Refresh Token 只存哈希且重放即吊销整个会话家族、服务端登出、首次登录强制改密、SNMP 凭证 AES-256-GCM 静态加密、受信代理白名单、错误细节只进日志 |
| 14 | **可观测与运维友好** | `/api/health` 探测 DB、结构化 slog 按天轮转 gzip、优雅停机、错误码 EN/ZH 映射并在 CI 校验一致性、磁盘空间兜底清理 |

### 1.3 架构图

```
                        浏览器（React 19 · antd 6 · @ant-design/charts）
                                       │ HTTPS
                          Nginx / Caddy：静态 dist + /api/ 反代
                                       │ :8080 HTTP（JWT Bearer）
┌──────────────────────────────────────▼───────────────────────────────────────┐
│                            nms-server（Go 单进程）                             │
│                                                                              │
│  :8080  /api/v1/*      JWT REST：auth · ipam · devices · system · agents      │
│                        probe-results · overview · asn      /api/health       │
│  :8443  /api/v1/agents/enroll · /agents/ca-cert    单向 HTTPS（注册引导）      │
│  :8444  /api/v1/agent-sync/*                       双向 mTLS（任务 / 结果）    │
│                                                                              │
│  后台任务   Direct SNMP 轮询器 · 运行状态看门狗 · Agent 离线扫描 · 探测/指标     │
│            降采样归档 · 分层保留清理 · 磁盘空间兜底 · ASN 数据每日更新          │
│  内置组件   Root CA（ECDSA P-256）· gosmi MIB 翻译引擎 · SecretBox 凭证加密     │
└──────────────┬───────────────────────────────────┬───────────────────────────┘
               │ GORM                               │ mTLS（Agent 直连，不经反代）
        MySQL / MariaDB                      NMS Agent × N（独立仓库）
   ipam_* · device_* · sys_*            ping / tcpping / httpcheck / dnscheck
   agent_* · probe_*                    traceroute / mtr / meshping / meshmtr
                                        snmp_poll（探针代理采集）
                                                   │ SNMP
                                             网络设备 ◄──── Direct 模式由 Server 直采
```

### 1.4 目录结构

```text
NMS/
├── .github/workflows/release.yml      # CI：打 v* tag 自动编译前后端并发布 Release
├── scripts/check-error-codes.mjs      # CI：校验后端错误码与前端 i18n 词条一致性
│
├── backend/                           # Go 后端（模块名 nms-backend）
│   ├── main.go                        # 入口：配置 / 连接池 / 迁移 / Seed / 三端口监听 / 优雅停机
│   ├── logger.go                      # 按天轮转 + gzip 压缩 + 过期清理（纯 stdlib）
│   ├── config.example.yaml            # 配置模板（部署时复制为 config.yaml）
│   ├── mibs_builtin/                  # 12 个标准 MIB 基础模块（go:embed 内置）
│   ├── core/
│   │   ├── errors.go                  # CodedError：携带错误码 + 插值参数的业务错误
│   │   ├── ipam_calc.go               # 纯算法：严格 CIDR 校验、子网拆分 / 合并
│   │   ├── pki.go                     # 内置 Root CA：生成 / 加载 / 轮换，签发服务端与客户端证书
│   │   ├── secrets.go                 # SecretBox：SNMP 凭证 AES-256-GCM 静态加密（双口令轮换）
│   │   └── diskspace_*.go             # 可用磁盘空间探测（Linux statfs / 其他平台空实现）
│   ├── asndb/                         # 可选：IP→ASN 前缀匹配（BART trie + 每日自动下载）
│   ├── models/                        # ipam_ / device_ / sys_ / agent_ / rollup 五组数据模型
│   ├── middleware/
│   │   ├── auth.go                    # JWT 校验 + AdminRequired / RequirePerm + 强制改密拦截
│   │   ├── mtls.go                    # mTLS 客户端证书校验（CN=AgentID，吊销 / 序列号比对，心跳刷新）
│   │   ├── ratelimit.go               # 按 IP 滑动窗口限速（login / refresh / health）
│   │   └── recovery.go                # panic 恢复（堆栈写入 slog）
│   └── controllers/
│       ├── common.go                  # 跨模块工具：parseIDParam / getUsername / codedErrJSON
│       ├── auth_api.go                # 登录 / 刷新 / 改密 / 会话时长 / UI 偏好
│       ├── system_api.go              # 用户 & 用户组 & 安全设置 & 会话管理（管理员）
│       ├── login_protection.go        # 登录防爆破（滑动窗口 + 锁定列表管理）
│       ├── ipam_api.go                # IPAM REST（根前缀 / 子网树 / 拆分 / 合并 / 字典 / 审计）
│       ├── device_api.go              # Devices REST（设备 / 字典 / SNMP 详情 / 立即测试）
│       ├── device_snmp_oid_api.go     # 自定义标量 OID CRUD + 指标趋势序列
│       ├── device_snmp_poller.go      # SNMP 采集核心：applySNMPResult 唯一落库 + Direct 轮询器 + 看门狗
│       ├── device_metric_rollup.go    # 指标时序降采样归档（GET_LOCK 多实例互斥）
│       ├── device_mib_api.go          # MIB 文件库（上传校验 / 列表 / 下载 / 删除）
│       ├── device_mib_engine.go       # gosmi 翻译引擎（OID → 可读名，全量重建）
│       ├── agent_enroll_api.go        # Agent 注册引导（一次性注册码原子消费 + IP 防爆破）
│       ├── agent_sync_api.go          # 任务下发（含 snmp_poll 合成）/ 结果上报 / 证书续期 / 二进制下发
│       ├── agent_admin_api.go         # Agent / Group / Task / Token / Release 管理 + CA 状态 / 轮换
│       ├── probe_results_api.go       # 结果历史 / 最新快照 / MeshPing 矩阵 / 延迟趋势 / 清理
│       ├── probe_jobs.go              # 清理 / 批量删除的异步任务表（单飞 + 进度查询）
│       ├── probe_rollup.go            # 探测结果降采样归档（Cacti RRA 风格，幂等 upsert）
│       ├── overview_api.go            # NOC 看板聚合（时间桶时序 + KPI + 分组健康度）
│       ├── asn_api.go                 # IP→ASN 批量查询 + 数据管理（可选启用）
│       ├── audit_retention.go         # 审计日志 + 探测结果分层自动保留 + 磁盘空间兜底
│       └── seed.go                    # 幂等 Seed：默认 admin 组 / 账号
│
└── frontend/                          # React 19 + TypeScript + Vite + antd 6
    └── src/
        ├── api/                       # 共享 Axios 实例（自动带 Token + 静默刷新）+ 各模块 API 封装
        ├── types/                     # 与后端响应一一对应的 TS 类型
        ├── theme/theme.ts             # 设计令牌：buildTheme(light|dark) + palette + mono 字体
        ├── i18n/                      # useT() 钩子 + EN/ZH 全量翻译 + apiErrors 错误码映射
        ├── contexts/                  # AuthContext（Token 静默刷新）/ AppContext（主题 / 语言）
        ├── components/                # PageHeader / StatusTag / StatTile / MetricCard / RelativeTime / LatencySpark …
        ├── layouts/MainLayout.tsx     # 分组侧边栏 + 顶栏（主题切换 / 用户菜单）
        ├── utils/                     # perms（useCan）/ useDebounced / cidr / chartTicks
        └── pages/                     # 每菜单一个目录，页面内 Tab 即子功能
            ├── Dashboard.tsx
            ├── Devices/  IPAM/  Agent/  ProbeResults/
            ├── System/User  System/Group  System/Settings
            └── Login/
```

规模参考：后端约 1.2 万行 Go，前端约 1.3 万行 TypeScript；数据库 32 张表，全部由 GORM AutoMigrate 管理。

---

## 2. 快速开始

前置依赖：Go ≥ 1.26 · Node.js ≥ 22 · MySQL ≥ 8.0 或 MariaDB ≥ 10.6。

### 2.1 下载预编译产物

每个 [GitHub Release](../../releases) 附带两个文件：

| 文件 | 说明 |
|------|------|
| `nms-server` | Linux amd64 后端二进制，静态编译（`CGO_ENABLED=0`），单文件即可运行 |
| `dist.tar.gz` | 前端静态资源，解压后交给 Nginx / Caddy 托管 |

```bash
sudo mkdir -p /opt/nms/backend && cd /opt/nms/backend
# 把 nms-server 放到这里，然后
sudo chmod +x nms-server
cp config.example.yaml config.yaml      # 模板在仓库 backend/ 目录，按第 3 节填写
./nms-server                            # 前台试跑；生产用 systemd（见 6.2）
```

后端只从**二进制同级目录**读取 `config.yaml`，没有命令行参数。完整生产部署（数据库、systemd、Nginx、HTTPS）见 [第 6 节](#6-部署运维)。

### 2.2 从源码构建与本地开发

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
npm run build                        # tsc + vite build → dist/
```

交叉编译 Linux 二进制（与 CI 一致）：

```bash
cd backend && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o nms-server .
```

### 2.3 首次启动做了什么

1. 读取 `config.yaml`，`jwt.secret` 为空或仍是占位符时打印警告（不阻止启动，但生产必须替换）
2. 连接 MySQL，`AutoMigrate` 建全部 32 张表（外键约束不内联，级联逻辑由应用层管理）
3. 写入默认用户组 `admin` 与默认账号 **`admin` / `admin`**（`must_change_password = true`，首次登录强制改密）
4. 后台为 `probe_results` 创建幂等去重唯一索引（大表可能耗时数分钟，不阻塞启动）
5. 校验保留策略与归档层配置（矛盾配置直接拒绝启动，避免静默损坏长期数据）
6. 生成或加载 Root CA 到 `data/pki/`（ECDSA P-256，默认 10 年），每次启动重签服务端叶子证书
7. 把 12 个内置标准 MIB seed 进 `data/mibs/` 并构建翻译引擎
8. 配置了 `snmp.credentials_key` 时，一次性加密库中存量明文 SNMP 凭证
9. 启动全部后台任务（见 [5.5](#55-后台任务一览)），然后监听三个端口

### 2.4 验证启动

```bash
curl -s http://127.0.0.1:8080/api/health        # {"status":"ok","db":"up"}；DB 不通返回 503
ss -ltnp | grep nms-server                      # 应看到 8080 / 8443 / 8444
tail -f logs/nms-server.log                     # 结构化 JSON 日志（log.format 可改 text）
openssl s_client -connect 127.0.0.1:8444 </dev/null 2>/dev/null | head -3   # mTLS 端口握手
```

浏览器打开前端，用 `admin / admin` 登录，按提示修改密码后进入 `/dashboard`。

---

## 3. 配置说明

完整模板见 [backend/config.example.yaml](backend/config.example.yaml)，每一块都有注释。**未配置的块使用内置默认值**，旧版 `config.yaml` 可平滑升级。下表按块列出关键项。

### 3.1 server 块 — 端口与受信代理

| 键 | 默认 | 说明 |
|----|------|------|
| `port` | 8080 | 主 API 端口，只对 Nginx 本机开放即可 |
| `trusted_proxies` | `127.0.0.1`, `::1` | 只有来自这些地址（单 IP 或 CIDR）的连接，其 `X-Forwarded-For` 才被采信为客户端 IP。Nginx / LB 异机部署时加入其内网地址，否则登录防爆破按 IP 锁定可被伪造 XFF 绕过 |

Agent 直连的 enroll / sync 端口**不信任任何代理头**，一律取 TCP 来源地址。

### 3.2 database 块 — 连接池

| 键 | 默认 | 说明 |
|----|------|------|
| `host` / `port` / `user` / `password` / `dbname` | — | 标准连接参数，DSN 固定 `charset=utf8mb4&parseTime=True&loc=Local` |
| `max_open_conns` / `max_idle_conns` | 25 / 10 | 连接池上限 |
| `conn_max_lifetime_minutes` | 60 | **必须小于 MySQL `wait_timeout`**（默认 480），否则空闲连接被服务端单方面关闭后下一个请求拿到死连接 |
| `conn_max_idle_time_minutes` | 10 | 空闲连接最长保留 |

### 3.3 jwt 块 — 令牌签发

| 键 | 默认 | 说明 |
|----|------|------|
| `secret` | 占位符 | HS256 签名密钥，**部署前必须替换**为 ≥32 位强随机值：`openssl rand -hex 32` |
| `refresh_token_days` | 7 | Refresh Token 有效期；Access Token 有效期由用户自定义（1–720h，默认 24h）并受安全设置里的全局上限钳制 |

### 3.4 audit 块 — 保留策略与归档

| 键 | 默认 | 说明 |
|----|------|------|
| `max_age_days` | 180 | IPAM / Devices / Agent / System 四张审计日志表的保留天数，0 = 永久 |
| `probe_results_max_age_days` | 30 | 原始探测点保留；启用归档后建议缩至 14 |
| `path_results_max_age_days` | 0 | 路径类大 JSON（mtr / meshmtr / traceroute）独立保留；0 = 跟随上项 |
| `probe_rollups` | 不启用 | 降采样归档层列表，每层 `bucket_minutes` + `max_age_days`。推荐 5min/183d · 30min/366d · 2h/1096d · 1d/3660d。各层桶粒度必须严格递增；启用时原始保留需 ≥ 最大桶天数 × 2 + 2 |
| `probe_disk_guard.enabled` | false | 磁盘空间兜底。常规保留任务 24 小时一次，小盘部署可能来不及反应（2026-07-23 事故：9.2G VPS 几小时内被 `probe_results` 打满导致 MariaDB 崩溃）。开启后每 `check_interval_minutes`（10）检查一次，可用空间低于 `critical_free_mb`（500）立即对 `probe_results` 做一次更激进的紧急清理，但不会砍破归档层要求的最小原始天数 |

保留任务每 24 小时运行一次，同时兜底清理过期 Refresh Token。

### 3.5 snmp 块 — 设备采集

| 键 | 默认 | 说明 |
|----|------|------|
| `enabled` | true | 总开关。关闭后不启动轮询器 / 看门狗 / 指标保留与归档，也不向 Agent 下发 `snmp_poll` 任务；MIB 库与翻译引擎不受影响 |
| `default_interval_seconds` | 60 | 快轮询默认间隔，设备表单可逐台覆盖（10–86400） |
| `inventory_every_n` | 10 | 每 N 次快轮询附带一次完整 RFC 1213 system 组 |
| `timeout_seconds` / `retries` | 3 / 1 | 单次 SNMP 请求超时与重试（总请求数 = 1 + retries） |
| `max_concurrent` | 16 | Direct 轮询器同时在途的 SNMP 请求上限 |
| `metrics_max_age_days` | 14 | 自定义 OID 指标时序保留。估算：16 OID × 60s ≈ 2.3 万行 / 天 / 设备 |
| `metric_rollups` | 不启用 | 指标归档层，语义同 `audit.probe_rollups`。推荐 5min/90d · 1h/366d · 1d/1096d |
| `mibs_dir` | `data/mibs` | MIB 文件库目录，纳入备份 |
| `credentials_key` | 空 | SNMP 凭证静态加密口令（SHA-256 派生 AES-256-GCM 密钥）。空 = 明文存库；配置后启动时自动加密存量凭证 |
| `credentials_key_previous` | 空 | 密钥轮换过渡：`credentials_key` 填新口令、此项填旧口令 → 重启自动重封全部凭证 → 清空此项。⚠️ 两把口令都丢失时已加密凭证不可恢复 |

### 3.6 agent_pki 块 — 内置 CA 与 Agent 端口

| 键 | 默认 | 说明 |
|----|------|------|
| `enabled` | true | 关闭后不生成 CA、不监听 enroll / sync 端口；Agent 列表等管理页面仍可用 |
| `dir` | `data/pki` | Root CA 与证书存储目录。`ca.key` 是整套 Agent 信任体系的根密钥，**务必备份，绝不进 Git** |
| `releases_dir` | `data/releases` | 上传的 Agent 二进制存储目录 |
| `enroll_port` / `sync_port` | 8443 / 8444 | Agent 直连端口，防火墙放行；不能经 Nginx 反代（mTLS 校验在本进程内完成） |
| `server_san` | `localhost`, `127.0.0.1` | ⚠️ 服务端证书 SAN，**必须覆盖 Agent 实际拨号使用的域名 / IP**，否则 Agent 侧 TLS 校验失败。监听本身双栈，按需同时列出 v4 / v6 |
| `client_cert_days` | 365 | 签发给 Agent 的客户端证书有效期；Agent 剩余 < 30 天自动续期 |
| `server_cert_days` | 730 | enroll / sync 端口的服务端叶子证书，每次启动重签，无需手工轮换 |
| `ca_cert_days` | 3650 | Root CA 有效期，首次启动生成后长期复用 |

### 3.7 asndb 块 — IP 到 ASN 标注

| 键 | 默认 | 说明 |
|----|------|------|
| `enabled` | false | 关闭时不注册 `/api/v1/asn` 等路由，对其他功能无影响 |
| `v4_prefix_file` / `v6_prefix_file` / `names_file` | `data/asndb/…` | 数据文件路径。来源固定：CAIDA RouteViews 前缀表（v4 / v6）+ RIPE NCC AS 名称表 |
| `update_hour` | 3 | 每天几点自动下载更新（服务器本地时间）。CAIDA 当日文件未就绪时自动回退最多 7 天 |

初次启用可用 `POST /api/v1/admin/asndb/download` 手动触发下载，无需重启。

### 3.8 log 块 — 日志轮转

| 键 | 默认 | 说明 |
|----|------|------|
| `dir` | `logs` | 日志目录，支持绝对路径（如 `/var/log/nms`） |
| `max_age_days` / `max_backups` | 30 / 30 | 双重保留：天数 + 份数，0 = 不限制 |
| `compress` | true | 历史文件 gzip 压缩，后台异步执行 |
| `level` | info | debug / info / warn / error |
| `format` | json | json 适合 ELK / Loki；text 适合直接 grep |
| `stdout` | false | 同时输出到标准输出（Docker / journald 环境建议开启） |
| `access_log` | true | HTTP 访问日志；Nginx 已有采集时可关闭 |

当日活跃文件 `nms-server.log`，跨天归档为 `nms-server-YYYY-MM-DD.log.gz`。

### 3.9 敏感信息与备份清单

| 项目 | 位置 | 说明 |
|------|------|------|
| `jwt.secret` | config.yaml | 泄露即可伪造任意用户的 Access Token |
| `database.password` | config.yaml | — |
| `snmp.credentials_key` | config.yaml | 丢失后已加密的 SNMP 凭证不可恢复 |
| Root CA 私钥 | `data/pki/ca.key` | 丢失 = 全部 Agent 需要重新注册 |
| Agent 二进制 | `data/releases/` | OTA 分发源 |
| MIB 文件库 | `data/mibs/` | 上传的厂商 MIB |
| ASN 数据 | `data/asndb/` | 可重新下载，非必须备份 |
| 数据库 | MySQL `nms_db` | 常规 mysqldump / 物理备份 |

`config.yaml` 与整个 `data/` 目录都不应进入版本控制。

---

## 4. 功能模块

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
   ├─ 用户         /system/users       账号生命周期 · 强制下线 · 会话管理
   ├─ 用户组        /system/groups      模块级权限分配
   └─ 安全设置      /system/settings    防护配置 · 锁定列表 · 系统审计日志
```

### 4.1 总览 Dashboard

登录后的默认落地页，NOC 运行总览。数据源为聚合端点 `GET /api/v1/overview?range=1h|24h|7d`（任何已登录用户可访问），30 秒轮询 + 请求序号守卫（乱序响应直接丢弃）。

- **KPI 卡**：设备 / Agent / 探测量 / 失败率，mono 大数字 + sparkline，含与上一等长窗口的环比
- **探测量时序**：服务端按时间桶聚合（1H = 5min 桶 / 24H = 1h 桶 / 7D = 6h 桶），Go 侧补齐空桶
- **设备状态**：管理状态环图 + **运行状态分面**（up / down / **proxy down**——探针失联的设备单列，不淹没在 unknown 里）
- **分组健康度**：各 Agent 分组的在线率（Top 6）
- **活跃告警**：窗口内最新失败探测 + 离线 Agent 派生
- 图表库（G2）较重，本路由 `React.lazy` 懒加载，不拖累登录与其他页面

### 4.2 设备 Devices

设备台账 + SNMP 采集监控。物理结构三层：**Site（站点）→ PoP（机房节点）→ Device（设备）**。写操作需 `devices:write` 权限；MIB 上传 / 删除与审计清理仅管理员。

#### 4.2.1 设备列表与双状态模型

- **CRUD**：Hostname 全局唯一；管理地址 IPv4 / IPv6 **至少一项**、各自全局唯一（存 SQL NULL 而非空串以兼容唯一索引）；关联 Site / PoP / Role / Vendor 字典；服务端分页 + 多条件过滤（主机名 / IP / 状态 / 运行状态 / 站点 / PoP / 角色 / 厂商）
- **管理状态** `status`（用户设置）：`active` / `maintenance` / `planned`——生命周期意图，SNMP 永不改写（`offline` 为遗留值，UI 显示"已停用"）
- **运行状态** `oper_status`（机器写入）：`up` / `down` / `unknown`——只由采集链路驱动，`oper_reason` 记录原因（`snmp_timeout` / `agent_down` / `poller_stale` / `agent_revoked` …）
- planned / 停用设备不采集并归位 unknown；maintenance 照常采集（真相不丢，前端叠加维护标识）

#### 4.2.2 SNMP 采集 Direct 与 Agent Proxy

逐台开启，v1 / v2c / **v3 USM** 全支持（安全级别由 authProto / privProto 组合推导，认证 MD5–SHA512，加密 DES / AES 系列）。

- **Direct**：Server 内置轮询器（worker pool + 到期扫描 + 在途去重），并发受 `snmp.max_concurrent` 限制
- **Agent Proxy**：表单指派探针代理，适合管理网段仅探针可达的场景。代理任务**不进 `agent_tasks` 表**——每次任务同步时从 devices 表即时合成（虚拟 TaskID = 2³⁰ + device_id，与真实任务 ID 永不冲突），改配置 / 换探针下个周期自动生效；结果回传时服务端校验设备归属防越权伪造
- 两种模式最终汇聚到同一落库路径 `applySNMPResult`，状态机行为完全一致（见 [5.2](#52-snmp-采集链路与状态机)）
- **快 / 慢两档**：每周期只 GET `sysUpTime`（最小报文，兼做存活判定），每 `inventory_every_n` 次附带完整 RFC 1213 system 组；`sysUpTime` 回退触发重启检测（写 `reboot_detected` 审计）
- **看门狗**：后台每分钟扫描 `last_poll_at`，停滞超 `max(3 × 采集间隔, 300s)` → `unknown`（agent 模式原因 `agent_down`，前端展示 **Proxy Down**）；探针被吊销 / 删除立即归位
- **凭证安全**：community / v3 口令一律 `json:"-"` 永不出现在任何 API 响应（前端以 `*_set` 派生标志感知，编辑留空 = 不修改）；配置 `snmp.credentials_key` 后 AES-256-GCM 静态加密落库
- **SNMP 详情 Drawer**（点主机名打开）：system 组全量 + 采集来源 / 延迟 / 最近错误 + sysObjectID 翻译名；Direct 模式提供**立即测试**（同步采集一次并落库）

#### 4.2.3 自定义 OID 与指标时序

- 每台 ≤16 条标量 OID，与 system 组同一 GET 报文，不增加请求数；名称留空自动用 MIB 翻译命名
- `gauge` 存瞬时原值；`counter` 入库时换算每秒速率（时间基准用 Agent 上报的采集时刻；负差值 = 回绕 / 重置跳点，RRDtool 同语义）
- 数值型自动进指标时序 `device_metric_points`，Drawer 内趋势图 1h ～ 90d（时间桶聚合 avg / min / max）；配置 `snmp.metric_rollups` 后启用降采样归档，长窗口曲线不断档
- 改 OID 或换 kind 时清空旧时序，避免两种语义混在一条线上

#### 4.2.4 接口表采集

表单开关 `collect_interfaces`：每周期 WALK `ifTable` / `ifXTable` 维护接口维表——名称 / 别名 / 速率上限 / admin-oper 状态 / 实时流量（HC 64 位计数器优先，服务端换算 bit/s）/ 累计错误。消失接口自动清理，单设备上限 512。按接口的历史趋势**有意不入库**（关键端口用自定义 OID + counter 变通获得时序）。

#### 4.2.5 站点 PoP 角色 厂商

- **站点 Tab 内嵌 PoP 管理**：Site CRUD + 每站点的 PoP 子表（PoP 名在 Site 内唯一；PoP 迁站在事务内级联更新所属设备）。删站点须先清空其 PoP
- **角色 / 厂商**：分类字典 CRUD。删除时关联设备外键置 NULL，不阻断

#### 4.2.6 MIB 库与翻译引擎

- 管理员上传（≤2 MiB，轻量 SMI 校验 + SHA256 + 模块名唯一），登录用户可查看 / 下载；文件按 `<模块名>.mib` 落盘（gosmi 按模块名解析 IMPORTS）
- **gosmi 翻译引擎**：启动与每次上传 / 删除后全量重建；单模块解析失败不影响其他模块（常见原因是 IMPORTS 依赖未上传，补传后自动转好，解析状态列表可见）
- **12 个标准基础模块内置**（SNMPv2-SMI / TC / CONF / MIB、SNMP-FRAMEWORK-MIB、INET-ADDRESS-MIB、IANAifType-MIB、IF-MIB、RFC1155-SMI、RFC-1215、RFC1213-MIB），go:embed 编译进二进制，首次启动 seed，管理员删除后不复活
- 用途：`GET /devices/mibs/translate?oid=` 数字 OID → 可读名（最长前缀匹配）；Drawer 中 sysObjectID 自动翻译（如 `CISCO-PRODUCTS-MIB::cisco7206VXR`）；自定义 OID 自动命名

#### 4.2.7 设备审计日志

Devices 域全部写操作留痕（含 SNMP 配置变更、立即测试、重启检测），分页查询；按天数清理仅管理员。

### 4.3 IPAM 地址管理

IPv4 / IPv6 双栈地址规划。写操作需 `ipam:write` 权限。页头 StatTile 展示根前缀 / VRF / 分组 / 类型计数。

| Tab | 功能 |
|-----|------|
| 根前缀 | 根 CIDR CRUD（严格校验：必须是网络地址本身，否则返回建议值）。删除在同一事务 + `FOR UPDATE` 行锁内级联清理全部子网 |
| 子网树 | `GET /root-prefixes/:id/tree` 渲染 L1 → L2 两级层级树，含利用率视图；按 CIDR / 分组 / 类型 / VRF 过滤 |
| 拆分 Split | 把一个前缀按 2ⁿ 等分为子网 |
| 合并 Merge | 相邻兄弟子网合并回父级（2ⁿ 校验 + 同父 / 同级 / 同根 / 相邻 + Re-parenting） |
| 分组 / 类型 / VRF | 业务字典 CRUD（VRF 含 RD 字段），供根前缀与子网打标 |
| 审计日志 | IPAM 域操作留痕；清理仅管理员 |

L1 / L2 子网**禁止单独删除**，只能通过 Split / Merge 重组——保证树永远无洞、无重叠。纯算法层 `core/ipam_calc.go` 与 HTTP 层分离。

### 4.4 Agent 管理

分布式探针体系：内置 CA + mTLS 自动引导注册、中心化任务调度、OTA 升级。整个页面仅管理员可见。

#### 4.4.1 Agent 列表

- 列表：搜索 + 分组 / 版本 / 系统架构 / 状态四个下拉过滤（候选由服务端去重给出，不受分页影响）+ 健康汇总卡（total / online / offline / revoked / 近 1 小时探测量与失败率）
- 状态口径：online / offline 只统计未作废的 Agent，revoked 单独一类
- 编辑：hostname、分组、**Source IP Override**（覆盖自动追踪的连接地址，支持 `ipv4 / ipv6` 双栈格式——作为 MeshPing 互测目标与探测源绑定）
- **作废证书（Revoke）**：立即断连但保留历史数据；**删除**为硬删除（`?purge=true` 连带清探测记录，并解绑其名下设备的 SNMP 采集）；支持多选批量
- **心跳机制**：Agent 周期调用 `GET /agent-sync/tasks` 拉任务，该调用本身即心跳——mTLS 中间件顺手刷新 `last_seen_at` / 连接 IP（写库 30 秒节流；`X-Agent-IPv4/IPv6` 头上报双栈地址，`X-Agent-Version/OS/Arch` 上报档案）；失联超 5 分钟由后台扫描（每分钟）翻转为 offline

#### 4.4.2 分组

逻辑分组（如 HKG / SIN / LAX），同时是 **meshping / meshmtr 的互测边界**。删除分组时组内 Agent / 任务的 `group_id` 置 NULL。

#### 4.4.3 探测任务 Probe Config

- **8 种类型**：`ping` · `tcpping` · `httpcheck` · `dnscheck` · `traceroute` · `mtr` · `meshping` · `meshmtr`；POST 支持多类型一次批量创建（共享同一份 Target 列表，校验按所选类型的并集放行）
- **三级 Scope**：Global（全部 Agent）/ Group（指定分组）/ Agent（指定单台）
- **Target 格式**：每行一个字面 IP **或域名**；`tcpping` / `httpcheck` 可附加 `:port`（IPv6 用 `[addr]:port`；省略时 Agent 侧有默认值）；`httpcheck` 亦支持完整 `http(s)://` URL；`dnscheck` 填待解析域名
- **meshping / meshmtr**：Target 由 Server 动态解析——同组（或全局）存活 Agent 的 IP 实时组装下发，配置时填写的 Target 被忽略。peer IP 优先级：`source_ip_override` → 自动追踪的 `connection_ipv4/v6` → 旧版 `connection_ip` 兜底
- **每任务可选项**
  - `address_family`——域名 Target 的解析族：`auto`（默认）/ `v4` / `v6` / `both`（两族各测一次，结果以 ` (v4)` / ` (v6)` 后缀分为两条独立序列）。字面 IP 不受影响。切换 both 会更换序列键（旧序列停止增长）；traceroute 在 both 下两族串行，建议 interval ≥ 300s
  - `skip_tls_verify`——仅 `httpcheck`：探测裸 IP（证书 SAN 只签域名）或自签证书设备时开启

#### 4.4.4 注册码与 CA 管理

- **一次性注册码**：可设有效期、预设分组；明文仅生成时显示一次，DB 只存 SHA-256 哈希（与 Refresh Token 同模式）
- **注册流程**：Agent 调 `POST /agents/enroll`（单向 HTTPS）携带注册码 + hostname → 后端**原子条件 UPDATE** 认领注册码（杜绝并发重复消费）+ 来源 IP 滑动窗口防爆破（10 分钟 10 次失败 → 锁 15 分钟）→ 分配全局唯一 `AgentID`（如 `AGT-3F2A9B7C`）→ 内置 CA 签发客户端证书（CN = AgentID，默认 1 年）连同 CA 公钥返回。此后所有 `/agent-sync/*` 调用凭证书做 mTLS，证书 CN 即身份，服务端额外比对序列号与吊销状态
- **证书续期**：Agent 用仍有效的证书调 `POST /agent-sync/renew-cert` 直接换发（语义同 Refresh Token 旋转）
- **CA 轮换**：「轮换 CA」生成新 CA 用于后续签发，旧 CA 公钥保留过渡期仍被信任；全部 Agent 续期完毕后「终结轮换」停止信任旧 CA。**两个操作均只落盘，需重启服务进程生效**（避免对正被并发 TLS 握手读取的信任池做无锁热切换）

#### 4.4.5 版本发布 OTA

1. 上传各 OS / Arch 的 Agent 二进制（流式写盘 + 同步计算 SHA256，不占内存；上传进度条实时显示，传输中窗口不可关闭）
2. 「激活」某版本——同 OS + Arch 互斥，自动取消其他激活记录
3. 匹配 OS / Arch 且版本不同的 Agent 在下次任务同步响应中收到 `update` 字段
4. Agent 经 mTLS 从 `GET /agent-sync/binary/:id` 下载、校验 SHA256、自替换并重启
5. 前端每 10 秒轮询 `/agent-releases/:id/progress` 查看各 Agent 更新进度

### 4.5 探测结果 Probe Results

所有登录用户可见（只读）；清理与删除仅管理员。

#### 4.5.1 通用结果 Tab

Ping / TCPing / HTTPCheck / MTR 四个 Tab 共用同一组件：

- **最新快照**视图：每 (Agent, Target) 一行；过滤：关键字 / 主机名下拉 / **Target 下拉**（候选按类型 + 当前 Agent 服务端去重）/ 成败
- 路径类结果（mtr）行内可展开**逐跳详情**（丢包 / 延迟 / ASN 标注）
- 每行提供**延迟趋势**入口；悬停延迟值显示近 24 小时迷你 sparkline
- 管理员可**多选 / 全选当前页**批量删除（删除按 Agent + Target 组合清掉全部历史，否则上一条历史会立刻成为新的"最新"）

#### 4.5.2 MeshPing 矩阵

- NxN 延迟热力矩阵（v4 / v6 独立单元格），按分组 / 关键字过滤，30 秒轮询
- 单元格菜单可下钻：对应 (源, 目标) 的 **MTR 逐跳详情**（meshmtr 结果）或**延迟趋势图**
- 已知取舍：矩阵按各 Agent *当前* IP 反查历史结果归属，IP 变化瞬间个别历史单元格可能短暂错位

#### 4.5.3 延迟趋势图

- 1 小时 ～ 1 年预设或自定义区间；avg / min / max 三线 + 丢包率子图，两图共用 x 轴逐桶对齐；CSV 导出
- 数据源在**原始点与归档层间自动选择**（能覆盖起点的最细数据源），聚合到 ≤500 个显示点；粒度与来源在统计条可见
- 全部失败的桶画成断线而不是连成假直线
- 坐标轴 Cacti 风格：y 轴从 0 起、整数刻度（数值本身保留小数），x 轴时间标签水平显示、按密度抽样

#### 4.5.4 清理与批量删除

页头「清理历史数据」（按天数，0 = 全部）与通用 Tab 的批量删除都是**后端异步任务**：请求立即返回 `job_id`，删除在后台按 5000 行分片执行（命中死锁自动退避重试），前端进度框每秒轮询——清理按行数百分比、批量删除按组合数百分比，显示耗时；可「后台运行」关窗，重新打开页面自动找回进行中的任务。同一时刻只允许一个维护任务，再发起会附带运行中的 `job_id` 并直接切到它的进度。任务状态在内存中，进程重启即丢（前端会提示刷新列表确认结果）。

### 4.6 用户管理

- 用户 CRUD：创建 / 重置密码支持**一键生成强随机密码**；重置后强制改密
- **账号停用 / 启用**：停用即吊销全部 Refresh Token（历史数据保留；停用提示只在密码校验通过后返回，防用户名枚举）
- **会话管理**：点击列表中的会话数打开**会话列表**（每会话的客户端 IP / User-Agent / 登录与到期时间，Token 旋转时同步更新），可**吊销单个会话**；「强制下线」一键吊销全部
- 列表展示启用状态、**两步验证状态**、**活跃会话数**、最后登录时间
- **重置两步验证**：用户验证器丢失时由管理员关闭其 2FA 并吊销全部会话，用户凭密码登录后重新开启
- **管理保护**：不能删除 / 停用 / 降权最后一个启用状态的管理员；不能删除 / 停用自己、不能改自己的组

### 4.7 用户组与权限模型

模块级权限模型——组的 `permissions` 为权限值数组（白名单校验），JWT 签发时固化进 `perms` 声明（组权限变更在下次 Token 刷新时生效）。前端按权限隐藏写入口（`useCan`），后端路由中间件强制校验（`RequirePerm`，双重门禁）：

| 权限值 | 授予的能力 |
|--------|-----------|
| （无，只读基线） | 所有登录用户：查看 Dashboard / IPAM / Devices / Probe Results / 各审计日志 |
| `ipam:write` | IPAM 全部写操作（根前缀 CRUD、拆分 / 合并、字典维护） |
| `devices:write` | Devices 全部写操作（设备 / 站点 / PoP / 角色 / 厂商 CRUD，含 SNMP 配置与立即测试） |
| `admin` | 超级管理员：隐含全部权限 + 用户 / 组管理、Agent 体系、MIB 库写、安全设置、各类数据清理 |

不能删除唯一管理员组（组权限按解析结果校验，非字符串比较）。

### 4.8 安全设置

| Tab | 功能 |
|-----|------|
| 防护配置 | **登录防爆破**两级锁定：同一「用户名 + IP」滑动窗口内失败达阈值即临时锁定（默认 5 分钟 5 次 → 锁 15 分钟）；同一用户名**跨全部 IP** 累计失败达上限（默认 20，0 = 关闭）也锁定，挡住轮换来源 IP 的分布式撞库；用户不存在与密码错误同样计数，防用户名枚举；两步验证的验证码错误同样计入。**会话策略**：全局最大会话时长上限（签发 Token 时钳制用户自定义值） |
| 锁定列表 | 当前被锁定的条目（用户名级锁定的 IP 显示为 `*`），支持搜索与单条 / 批量手动解锁 |
| 系统审计日志 | 登录成功 / 失败、登出、令牌重放、两步验证开关与恢复码使用、用户 / 用户组 / 安全设置 / 会话管理的全部敏感操作留痕，支持查询与按天数清理。登录失败同时输出固定格式日志行（`login failed username=… ip=…`）供 fail2ban 匹配 |

计数器在内存中——单实例部署下足够，重启即清零不会误锁。

### 4.9 全局能力

- **认证**：JWT Access Token（HS256）有效期用户自定义（1–720h，默认 24h，受全局上限钳制）+ Refresh Token（默认 7 天，**旋转式**，只存哈希）；前端到期前 5 分钟静默换新，401 时拦截器单飞刷新后重放原请求
- **令牌重放检测**：旋转后的旧 Refresh Token 保留到过期；30 秒宽限期内再次出现视为多标签页并发刷新照常放行，超过宽限期再出现即视为泄露，**整个会话家族立即吊销**并写审计
- **服务端登出**：退出登录调用 `POST /auth/logout` 吊销本会话的 Refresh Token 家族，不再只清浏览器本地存储；自助改密同样吊销其余全部会话
- **两步验证（可选）**：个人中心 → 安全设置开启 TOTP（RFC 6238，纯标准库实现，兼容 Google / Microsoft Authenticator、1Password 等）：扫码或手输密钥 → 验证码确认 → 得到 8 枚一次性恢复码。开启后登录分两步，密码正确只换到 5 分钟有效、绑定来源 IP、最多 5 次尝试的挑战令牌，验证码错误计入防爆破；同一时间步的验证码拒绝重放。关闭需当前密码 + 验证码，管理员可为丢失验证器的用户重置
- **首次登录强制改密**：默认账号 `admin/admin` 登录后（及管理员重置密码后），JWT 声明 + 中间件双重拦截，改密前只放行 `me` / `change-password` / `logout`
- **密码规则**：8–72 字符（bcrypt 上限，超长明确拒绝而非静默截断）
- **登录页**：双栏布局，预登录即可切换主题 / 语言
- **个人资料**（右上角头像菜单）：改密、会话时长设置、主题（亮 / 暗 / 跟随系统）与语言（EN / ZH）偏好——持久化到服务端用户档案，跨设备同步
- **基础限速**：未认证端点按 IP 滑动窗口限速（login 30 次/分、refresh 60 次/分、health 120 次/分），超限返回 429 + `Retry-After`——与登录防爆破互补
- **健康检查**：`GET /api/health`（无需认证）探测 DB 连通性，故障返回 503，供 LB / 监控接入
- **优雅停机**：SIGINT / SIGTERM 后停止接新连接，等待在途请求（≤15s）
- **错误码体系**：错误响应统一 `{"error": "<中文>", "code": "<机器码>", ...插值参数}`，前端 `i18n/apiErrors.ts` 按 code 做 EN / ZH 映射（支持 `{minutes}` 等插值），未命中回退 error 原文；裸 404（后端旧版本缺接口）单独提示；`scripts/check-error-codes.mjs` 在 CI 校验两侧一致性
- **错误细节不外泄**：数据库 / 文件系统等内部错误的原文（表名、约束名、SQL、路径）只写服务端日志（含请求路径、操作者、IP），客户端统一收到通用文案 + `server_error`；唯一键冲突翻译为 `common.duplicate`；业务校验错误（CodedError）照常透出
- **API 响应安全头**：`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: no-referrer`、`Cache-Control: no-store`；页面级 CSP 由前端构建期注入 `<meta>`，HSTS / `frame-ancestors` 由 Nginx 下发（见 6.3）
- **空集合契约**：所有列表接口返回 `[]` 而非 `null`（GORM `Scan` 零行不触碰目标，后端显式初始化；前端再 `?? []` 兜底）

---

## 5. 高级主题

### 5.1 三端口模型与 mTLS

| 端口（默认） | 配置项 | TLS 模式 | 用途 |
|------|--------|----------|------|
| `8080` | `server.port` | 普通 HTTP（由 Nginx 反代为 HTTPS） | 浏览器前端全部 JWT API |
| `8443` | `agent_pki.enroll_port` | 单向 HTTPS（`tls.NoClientCert`） | Agent 首次注册：`POST /agents/enroll`、`GET /agents/ca-cert` |
| `8444` | `agent_pki.sync_port` | 双向 mTLS（`tls.RequireAndVerifyClientCert`） | `/agent-sync/*`：任务拉取 / 结果上报 / 证书续期 / 二进制下载 |

- Go 的 `tls.Config.ClientAuth` 按监听器全局生效，无法在同一端口内按路径区分是否要求客户端证书，因此 enroll 与 sync 必须分开监听
- 这两个端口**必须让 Agent 直连**（防火墙放行），不能经过 Nginx 反代——mTLS 校验在本进程内完成
- 监听地址留空主机部分（`:8443`），双栈系统上同时接受 IPv4 / IPv6 连接，纯 IPv4 环境自动回退
- 证书链信任由 TLS 握手完成；标准库不检查吊销列表，`AgentMTLS` 中间件在应用层按 CN 查 Agent 记录并比对吊销状态与证书序列号
- 每次启动重签服务端叶子证书，SAN 来自 `agent_pki.server_san`；CA 轮换期间 `ca-previous.crt` 一并加入信任池

### 5.2 SNMP 采集链路与状态机

```
Direct 模式                                   Agent Proxy 模式
Server 轮询器（worker pool）                   GET /agent-sync/tasks 时从 devices 表合成 snmp_poll
  │ gosnmp GET sysUpTime [+ system 组 + 自定义 OID]   │ Agent 采集后 POST /agent-sync/snmp-results
  ▼                                                   ▼（校验设备归属 + 采集时刻单调性）
                    applySNMPResult（唯一落库路径）
   ├─ device_snmp_states 快照 upsert（system 组 / uptime / 延迟 / 错误 / 来源探针）
   ├─ oper_status 翻转（UpdateColumns，不动 updated_at）+ oper_reason
   ├─ sysUpTime 回退 → reboot_detected 审计
   ├─ 自定义 OID：快照回写 + 数值进 device_metric_points（counter 换算每秒速率）
   └─ 接口表 reconcile（开启 collect_interfaces 时）
                    看门狗（每分钟）：last_poll_at 停滞 → unknown
```

- `up` = 最近一次采集成功；`down` = 最近一次采集明确失败（超时 / SNMP 错误）；`unknown` = 没有可信结论（未开启采集、从未采集、采集链路本身断了）
- Agent 上报重试会把整批快照延迟重放，采集时刻不晚于 `last_collected_at` 的结论直接丢弃，状态机不会倒退
- 凭证经 mTLS 信道明文下发给探针，Agent 只在内存持有不落盘；库内静态加密解密失败时按"凭证缺失"处理，绝不把密文当密码去撞设备

### 5.3 分层保留与降采样归档

Cacti / RRD 的 RRA 思路，探测结果与设备指标两套同构实现：

| 层 | 探测结果 | 设备指标 |
|----|---------|---------|
| 原始点 | `probe_results`（粒度 = 任务 Interval），默认保留 30 天 | `device_metric_points`，默认 14 天 |
| 归档层 | `probe_rollups`，配置 `audit.probe_rollups` | `device_metric_rollups`，配置 `snmp.metric_rollups` |
| 序列维表 | `probe_series`：(type, agent_id, target) 归一化为 4 字节 ID | 直接用 `oid_id` |

- 后台每小时把原始点聚合到各层桶（回看 26 小时，任务漏跑 / 重启后自动补算；唯一键 upsert 天然幂等），并按层清理过期桶
- 存 `sum / cnt` 而非均值，跨层重聚合精确无失真；`probe_rollups` 用复合主键聚簇、零二级索引
- `GET_LOCK` 咨询锁保证多实例部署互斥；拿不到锁直接跳过本轮
- 趋势查询选源规则：窗口起点落在原始保留期内且窗口 ≤ 45 天 → 原始表；否则选保留期能覆盖起点的最细归档层；显示桶为源粒度的整数倍，≤500 点
- 推荐配置下可实现「5 分钟粒度 6 个月 → 1 天粒度 10 年」的长期趋势，存储紧凑度对标 RRD
- 路径类结果（mtr / meshmtr / traceroute，detail 为大 JSON）不参与归档，可独立设更短保留

### 5.4 安全设计

| 面 | 措施 |
|----|------|
| 浏览器 ↔ Server | JWT HS256 + 旋转式 Refresh Token（只存 SHA-256，家族 ID 追踪，重放即整族吊销）；服务端登出与改密吊销其余会话；可选 TOTP 两步验证；到期前静默刷新；强制改密拦截；模块级权限双重门禁；API 安全头 + 构建期注入的严格 CSP（script-src 'self'，字体自托管无第三方来源） |
| 登录面 | 用户名 + IP 与跨 IP 用户名两级滑动窗口锁定（可调）；未认证端点按 IP 限速；用户不存在与密码错误同样计数；停用提示只在密码正确后返回（防枚举）；登录成功 / 失败全部审计并输出 fail2ban 友好日志 |
| 反向代理 | 只信任 `server.trusted_proxies` 的 `X-Forwarded-For`；Agent 直连端口不信任任何代理头 |
| Agent ↔ Server | 一次性注册码（哈希存储、原子消费、IP 防爆破）→ mTLS 客户端证书（CN = AgentID，序列号 + 吊销状态应用层比对）→ 证书自助续期 / CA 轮换 |
| 凭证存储 | 密码 bcrypt(12)；Refresh Token / 注册码只存哈希；SNMP 凭证 `json:"-"` 永不出 API，可选 AES-256-GCM 静态加密 + 双口令轮换 |
| 结果入库 | Agent 上报按唯一键幂等去重；采集时刻超窗（未来 5 分钟以上 / 过去 1 小时以上）的样本显式丢弃；SNMP 结论校验设备归属 |
| 进程 | 自定义 Recovery 把 panic 堆栈写入日志而非 stderr；内部错误细节只进日志；优雅停机 |

### 5.5 后台任务一览

| 任务 | 周期 | 启用条件 | 说明 |
|------|------|---------|------|
| 审计日志 + 探测结果保留清理 | 24h | 始终 | 四域审计日志 / 原始探测点 / 路径类结果分层清理；兜底清理过期 Refresh Token |
| 探测结果降采样归档 | 1h | `audit.probe_rollups` | 各层幂等 upsert + 过期桶清理，GET_LOCK 互斥 |
| 磁盘空间兜底 | `check_interval_minutes` | `audit.probe_disk_guard.enabled` | 可用空间跌破阈值即紧急清理 `probe_results` |
| Direct SNMP 轮询器 | 到期扫描 | `snmp.enabled` | worker pool，并发上限 `max_concurrent` |
| 运行状态看门狗 | 1min | `snmp.enabled` | `last_poll_at` 停滞 → unknown，对 direct / agent 两种模式统一兜底 |
| 指标时序保留 + 归档 | 24h / 1h | `snmp.enabled`（归档需 `metric_rollups`） | 自定义 OID 时序 |
| Agent 离线扫描 | 1min | `agent_pki.enabled` | 心跳超 5 分钟 → offline |
| probe_results 去重索引 | 启动后一次 | 始终 | 大表建索引 / 清重不阻塞启动 |
| ASN 数据更新 | 每日 `update_hour` | `asndb.enabled` | CAIDA + RIPE 下载后无锁热重载（atomic pointer swap） |
| 清理 / 批量删除任务 | 按需 | 管理员触发 | 内存任务表单飞，完成后保留 10 分钟供最后一次轮询 |

### 5.6 数据模型与模块隔离

所有模块共存于 `nms_db`，以**表名前缀**隔离命名空间：

| 模块 | 前缀 | 数据表 |
|------|------|--------|
| IPAM | `ipam_` | root_prefixes · subnets · groups · types · vrfs · audit_logs |
| System | `sys_` | groups · users · refresh_tokens · settings · audit_logs |
| Devices | `device_` / `devices` | sites · pops · roles · vendors · devices · snmp_states · snmp_oids · metric_points · metric_rollups · interfaces · mibs · audit_logs |
| Agent | `agent_` / `agents` | groups · agents · tokens · tasks · releases · audit_logs |
| 探测结果 | `probe_` | probe_results（热表）· probe_series（维表）· probe_rollups（归档） |

关键关系与删除策略：

- **IPAM**：禁止单独删除 L1 / L2 子网，只能 Split / Merge 重组；删根前缀在事务 + `FOR UPDATE` 行锁内级联清理
- **Devices**：删站点须先清空 PoP；删 PoP / 角色 / 厂商时设备外键置 NULL；删设备连带清理 SNMP 快照 / OID / 时序 / 接口表
- **Agent**：删分组时组内 Agent / Task 的 `group_id` 置 NULL；删 Agent 为硬删除（只想断连用「作废证书」）；注册码 `unused → used` 经原子条件 UPDATE 转换
- **probe_results 索引**：`(type, reported_at)` 服务历史列表；`(type, agent_id, target, reported_at)` 服务最新快照 / 矩阵 / Target 候选的纯索引扫描；`reported_at` 单列服务看板聚合与保留清理；`(agent_id, task_id, target, reported_at)` 唯一索引服务上报幂等去重

每个模块的后端入口是一个 `Register*Routes(r, db, authMW, …)` 函数、前端入口是 `pages/<模块>/index.tsx` + `components/Tab*.tsx`。新增功能遵循同一模式：独立路由注册、前缀表名、独立页面 / Tab、独立审计日志，不跨模块耦合。

### 5.7 前端设计系统

**"Direction A / Clarity"** —— 纯表现层设计系统，业务逻辑（分页 / 防抖 / 请求序号守卫 / 校验）与视觉完全解耦：

- **字体**：UI 用 Plus Jakarta Sans；IP / ID / 指标 / 时间戳统一 IBM Plex Mono（`--cion-mono`）。两套字体经 `@fontsource` 随 Vite 打包自托管，不再外链 Google Fonts——生产 CSP 可以收紧到 `font-src 'self'`，访问者 IP 也不再交给第三方
- **主题**：`theme/theme.ts` 的 `buildTheme(mode)` 注入 antd 6 令牌，亮 / 暗双主题 + 跟随系统；偏好持久化到服务端。antd 6 `cssVar` 变量只在组件子树内生效——组件树外的裸 DOM（登录页、加载屏）与 G2 Canvas 图表直接取 `palette` 原始 hex
- **国际化**：EN / ZH 全量翻译（`i18n/translations.ts`），antd locale 联动；API 错误码另有独立映射表
- **通用组件**：`PageHeader` / `StatusTag` / `StatTile` / `MetricCard` / `RelativeTime`（相对时间随语言，悬停显绝对值）/ `LatencySpark`（共享 sparkline，模块级 60 秒缓存）
- **页面模式**：每菜单一个目录、页面内 Tabs 承载子功能；Tab 切换 version 自增强制 remount 拉新数据；列表统一"防抖搜索 + 请求序号守卫 + 服务端分页"
- **图表**：`@ant-design/charts`（G2 5）静态 import——三处懒加载边界共享 G2 会触发 chunk 加载顺序崩溃，只有 Dashboard 路由整体懒加载；坐标轴刻度工具 `utils/chartTicks.ts` 两个趋势图共用

---

## 6. 部署运维

以 Debian 12/13 · Ubuntu 24+ 为例。

### 6.1 数据库

```bash
sudo apt update && sudo apt install -y default-mysql-server   # Debian 下为 MariaDB
sudo mysql <<'EOF'
CREATE DATABASE IF NOT EXISTS nms_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'nms_user'@'localhost' IDENTIFIED BY 'StrongPassword123!';
GRANT ALL PRIVILEGES ON nms_db.* TO 'nms_user'@'localhost';
FLUSH PRIVILEGES;
EOF
```

`probe_results` 是持续高频写入的热表，磁盘请按探测规模预留；小盘部署务必开启 `audit.probe_disk_guard`。

### 6.2 后端 systemd 常驻

```bash
sudo mkdir -p /opt/nms/backend && cd /opt/nms/backend
sudo chmod +x nms-server
cp config.example.yaml config.yaml && nano config.yaml
```

**部署前必改三项：**

1. `database.password` — 真实数据库密码
2. `jwt.secret` — 强随机字符串（≥32 位），如 `openssl rand -hex 32`
3. `agent_pki.server_san` — 必须包含 Agent 实际拨号使用的域名 / IP

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

sudo chown -R www-data:www-data /opt/nms/backend
sudo systemctl daemon-reload
sudo systemctl enable --now nms-backend
```

防火墙放行 `8443` / `8444` 供 Agent 直连；`8080` 只需对 Nginx 本机开放。

### 6.3 前端与 Nginx

```bash
sudo apt install -y nginx
sudo mkdir -p /var/www/nms && cd /var/www/nms
sudo tar -zxvf /path/to/dist.tar.gz

sudo tee /etc/nginx/sites-available/nms <<'EOF'
server {
    listen 80;
    server_name 你的域名或IP;
    server_tokens off;

    # ── 安全头（certbot 接管 443 后这些头随 server 块一起生效）──
    # CSP 与前端构建期注入的 <meta> 一致，另加 meta 形式不支持的 frame-ancestors
    add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "DENY" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
    # 启用 HTTPS 后再打开（先用短 max-age 观察，确认无误再加长并考虑 preload）
    # add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;

    location / {
        root /var/www/nms/dist;
        index index.html;
        try_files $uri $uri/ /index.html;
    }

    # 通用 API：请求体上限收紧到 1m（登录 / 列表 / 表单远用不到），限速登录面
    location /api/ {
        proxy_pass         http://127.0.0.1:8080;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        client_max_body_size 1m;
    }

    # 只有两个上传接口需要大请求体与长超时：Agent 二进制（几十 MB）与 MIB 文件。
    # 清理探测结果 / 批量删除已是后端异步任务，不再依赖长超时。
    location ~ ^/api/v1/(agent-releases|devices/mibs)$ {
        proxy_pass         http://127.0.0.1:8080;
        proxy_set_header   Host              $host;
        proxy_set_header   X-Real-IP         $remote_addr;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
        client_max_body_size 256m;
        proxy_read_timeout   600s;
        proxy_send_timeout   600s;
    }
}
EOF

sudo ln -sf /etc/nginx/sites-available/nms /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

> ⚠️ 后端主 API 引擎默认只信任**本机**（127.0.0.1 / ::1）反代的 `X-Forwarded-For`。若 Nginx / LB 部署在其他主机，在 `config.yaml` 的 `server.trusted_proxies` 中加入其内网地址。

### 6.4 HTTPS

生产必选，需域名：

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

Let's Encrypt 证书与 Agent PKI 的内置 CA 是两套完全独立的体系，互不影响。

### 6.5 升级与回滚

前后端是**两份独立产物，必须一起更新**。只换前端不换后端时，新页面调用新接口会得到裸 404，界面提示"接口不存在：后端可能仍在运行旧版本"。

```bash
# 1. 备份（二进制 + 配置 + data 目录 + 数据库）
sudo cp /opt/nms/backend/nms-server /opt/nms/backend/nms-server.bak
mysqldump nms_db | gzip > nms_db_$(date +%F).sql.gz

# 2. 后端：替换二进制并重启（AutoMigrate 在启动时自动补表补列）
sudo systemctl stop nms-backend
sudo cp ~/nms-server /opt/nms/backend/nms-server && sudo chmod +x /opt/nms/backend/nms-server
sudo systemctl start nms-backend && sudo journalctl -u nms-backend -n 50 --no-pager

# 3. 前端：解压新 dist（浏览器强刷或等待缓存过期）
cd /var/www/nms && sudo rm -rf dist && sudo tar -zxvf ~/dist.tar.gz
```

回滚：换回 `.bak` 二进制并重启即可；AutoMigrate 只增不删，旧版本二进制可直接跑在新 schema 上。

### 6.6 常用管理命令

```bash
sudo systemctl status nms-backend                 # 运行状态
sudo systemctl restart nms-backend                # 重启（CA 轮换 / 终结、改 config.yaml 后必需）
sudo journalctl -u nms-backend -f                 # 启动期错误（业务日志在 logs/ 目录）
tail -f /opt/nms/backend/logs/nms-server.log      # 结构化日志
curl -s http://127.0.0.1:8080/api/health          # 健康检查
ss -ltnp | grep nms-server                        # 三端口监听确认
sudo nginx -t && sudo systemctl reload nginx      # 改 Nginx 配置后
```

### 6.7 故障排查

| 现象 | 原因与处理 |
|------|-----------|
| 前端操作报 "Request failed" 或 "接口不存在" | 后端二进制没有随前端一起更新，新接口 404。换新 `nms-server` 并重启 |
| 页面白屏，控制台 `Cannot read properties of null (reading 'map')` | 旧版后端对空表返回 `null`。升级后端；当前版本所有列表接口保证返回 `[]` |
| Agent 注册 / 同步报 TLS 证书校验失败 | `agent_pki.server_san` 未包含 Agent 拨号用的域名 / IP。补上后重启（服务端证书每次启动重签） |
| Agent 一直 offline 但进程在跑 | 8444 未放行，或 Agent 走了 Nginx 反代。两个 Agent 端口必须直连 |
| enroll 返回锁定 | 同一来源 IP 10 分钟内 10 次失败触发 15 分钟锁定；检查注册码是否过期 / 已用 |
| 上传 Agent 二进制 413 或中途断开 | Nginx 缺 `client_max_body_size` / 超时过短，按 6.3 配置 |
| 登录被锁 | 安全设置 → 锁定列表手动解锁，或等待锁定期满；确认 `trusted_proxies` 正确否则所有用户共享 Nginx 的 IP |
| 启动报 "audit 保留策略配置无效" | `probe_rollups` 桶粒度未严格递增，或原始保留天数 < 最大桶 × 2 + 2 |
| MIB 上传后"未解析" | IMPORTS 的依赖模块尚未上传，补传后自动重建转好；解析错误在列表可见 |
| 磁盘被 `probe_results` 打满 | 开启 `audit.probe_disk_guard`，缩短 `probe_results_max_age_days` 并启用归档层；页头「清理历史数据」可立即释放 |
| AutoMigrate 报外键 errno 150 | 已在 GORM 层禁用内联外键约束；若仍出现，检查表引擎是否统一为 InnoDB |
| CA 轮换后 Agent 仍用旧证书连不上 | 轮换 / 终结只落盘，需 `systemctl restart nms-backend`；终结前确认全部 Agent 已续期 |

---

## 7. 构建与发布 CI

打 tag 即发版：

```bash
git tag v1.29.0 && git push origin v1.29.0
```

GitHub Actions（[release.yml](.github/workflows/release.yml)）自动执行：

1. **错误码一致性检查** `node scripts/check-error-codes.mjs`——后端 `gin.H "code"` / `core.CodedError` / `codedf(...)` 三种书写位置的错误码必须在前端 `apiErrors.ts` 有词条，漏配即失败
2. **前端** `npm install && npm run build`（`tsc` 类型检查 + Vite 打包）→ `dist.tar.gz`
3. **后端** `go mod tidy && go test ./...`，`CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w"` → `nms-server`
4. 提取自上个 tag 以来的 commit 生成 Changelog，创建 GitHub Release 并附上两个产物

ESLint（`npm run lint`）不阻塞 CI，作为本地提交前自查。依赖版本在 `package.json` 中精确钉死，保证 CI 每次解析结果一致。

---

## 8. API 速查

所有 JSON 接口挂在 `/api/v1`；错误响应统一 `{"error", "code", ...插值参数}`。

### 8.1 认证

`/api/v1/auth`

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/login` | 无需 JWT，按 IP 限速 30 次/分。未开两步验证返回 access + refresh token 对；开启时返回 `{totp_required: true, mfa_token}` |
| POST | `/login/totp` | 第二步 `{mfa_token, code}`（验证器 6 位码或恢复码）→ token 对；挑战 5 分钟有效、绑定 IP、最多 5 次尝试 |
| POST | `/refresh` | 无需 JWT，限速 60 次/分；旋转式，旧 Token 超 30 秒宽限期后重放 → `401 auth.refresh_reused` 且整族吊销 |
| POST | `/logout` | 吊销本会话的 Refresh Token 家族（`{refresh_token}`） |
| GET | `/me` | 当前用户信息（含权限列表、`totp_enabled`） |
| POST | `/change-password` | 自助改密（返回新 Token 对，其余会话全部吊销） |
| PUT | `/settings` · `/profile` | 会话时长（1–720h）· UI 偏好（theme / language） |
| POST | `/totp/setup` · `/totp/enable` · `/totp/disable` · `/totp/recovery-codes` | 两步验证：生成密钥与 otpauth URI → 验证码确认开启（返回 8 枚恢复码）→ 密码 + 验证码关闭 → 重新生成恢复码 |

### 8.2 IPAM

`/api/v1/ipam`（JWT；写需 `ipam:write`，审计清理仅管理员）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET / POST / PUT / DELETE | `/root-prefixes[/:id]` | 根前缀 CRUD（删除事务 + 行锁级联清理子网） |
| GET | `/root-prefixes/:id/tree` | L1 → L2 完整层级树 |
| POST | `/split` · `/merge` | 子网拆分 / 合并 |
| PUT | `/subnets/:id` | 子网打标（分组 / 类型 / VRF / 备注） |
| GET / POST / PUT / DELETE | `/groups` `/types` `/vrfs` | 字典 CRUD |
| GET / DELETE | `/audit-logs` | 审计日志查询 / 按天数清理 |

### 8.3 Devices

`/api/v1/devices`（JWT；写需 `devices:write`，MIB 写与审计清理仅管理员）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET / POST / PUT / DELETE | `/` `/:id` | 设备 CRUD（服务端分页多条件过滤；凭证永不回显） |
| GET / POST / PUT / DELETE | `/sites` `/pops` `/roles` `/vendors` | 字典 CRUD（PoP 名在 Site 内唯一；迁站级联更新设备） |
| GET | `/agents-lite` | 表单"采集探针"下拉的轻量 Agent 列表 |
| GET | `/:id/snmp` | SNMP 详情（Drawer 数据源，含 sysObjectID 翻译名与接口表） |
| POST | `/:id/snmp/test` | 立即测试（仅 direct）：同步采集一次并落库 |
| POST / PUT / DELETE | `/:id/snmp/oids[/:oid_id]` | 自定义标量 OID（≤16 / 设备，gauge / counter） |
| GET | `/:id/snmp/oids/:oid_id/series?range=` | 指标趋势序列（原始点 / 归档层自动选源） |
| GET | `/mibs/translate?oid=` | 数字 OID → 可读名 |
| GET / POST / DELETE | `/mibs` `/mibs/:id[/download]` | MIB 库：列表 / 下载登录即可；上传 / 删除仅管理员 |
| GET / DELETE | `/audit-logs` | 审计日志 |

### 8.4 System

`/api/v1/system`（JWT + 管理员）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET / POST / PUT / DELETE | `/users` `/groups` | 用户 / 用户组 CRUD |
| POST | `/users/:id/force-logout` | 强制下线（吊销全部 Refresh Token） |
| GET / DELETE | `/users/:id/sessions[/:sid]` | 活跃会话列表（IP / UA / 签发 / 到期）/ 吊销单个会话 |
| POST | `/users/:id/totp/reset` | 重置目标用户的两步验证（验证器丢失），同时吊销其全部会话 |
| GET / PUT | `/settings/security` · `/settings/session` | 防爆破阈值 · 全局会话时长上限 |
| GET / POST | `/security/lockouts[/unlock]` | 锁定列表 / 手动解锁 |
| GET / DELETE | `/audit-logs` | 系统审计日志 |

### 8.5 Agent 注册 enroll 端口

端口 `8443`，单向 HTTPS，无需认证：

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/agents/enroll` | `{provisioning_token, hostname}` → AgentID + 客户端证书 + CA 公钥 + sync 端口 |
| GET | `/api/v1/agents/ca-cert` | Root CA 公钥（PEM） |

### 8.6 Agent 同步 sync 端口

端口 `8444`，强制 mTLS；请求头 `X-Agent-Version / OS / Arch / IPv4 / IPv6` 上报档案与双栈地址：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/agent-sync/tasks` | 拉取任务（即心跳）；含 `source_ip` 绑定、OTA `update`、合成的 `snmp_poll` |
| POST | `/api/v1/agent-sync/results` | 批量上报探测结果。样本时间取 Agent 采集时刻 `collected_at`（旧版缺失时回退入库时刻）；超窗样本（未来 5 分钟以上 / 过去 1 小时以上）丢弃并以 `dropped` 计数返回；按唯一键幂等去重（`deduped` 计数）——重试重放整批是安全的 |
| POST | `/api/v1/agent-sync/snmp-results` | 批量回传 SNMP 采集结论（校验设备归属 + 采集时刻单调性） |
| POST | `/api/v1/agent-sync/renew-cert` | 证书自助续期 |
| GET | `/api/v1/agent-sync/my-ip` | 返回 Server 所见来源 IP（tcp4 / tcp6 各调一次做双栈探测） |
| GET | `/api/v1/agent-sync/binary/:id` | 流式下载 Agent 二进制 |

### 8.7 Agent 管理

主端口，JWT + 管理员：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/agents` · `/agents/summary` · `/agents/filter-options` | 分页列表（`?q=&group_id=&status=&version=&os=&arch=`）· 健康汇总 · 下拉候选（去重版本 / OS+Arch） |
| PUT / DELETE | `/agents/:agent_id` | 修改 / 删除（`?purge=true` 连带清探测记录） |
| POST | `/agents/:agent_id/revoke` | 作废证书（保留历史数据） |
| GET / POST | `/agents/ca-cert` `/agents/ca/status` `/agents/ca/rotate` `/agents/ca/finalize` | CA 查看 / 状态 / 轮换 / 终结（仅 `agent_pki.enabled`） |
| CRUD | `/agent-groups` `/agent-tasks` `/agent-tokens` | 分组 / 任务（POST 支持多类型批量）/ 注册码（`POST /:id/revoke` 作废未用注册码） |
| GET / POST / DELETE | `/agent-releases` 及 `/:id/set-active` `/:id/progress` | OTA 上传（multipart）/ 激活 / 进度 |

### 8.8 探测结果

`/api/v1/probe-results`（JWT，仅需登录；删除与清理仅管理员）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 分页历史（`?type=&agent_id=&q=&success=&start=&end=`） |
| GET | `/latest` | 快照：每 (Agent, Target) 最新一条（`?type=` 必填，另支持 `agent_id` / `target` / `q` / `success`） |
| GET | `/meshping-matrix` | NxN 透视矩阵（`?group_id=&q=`） |
| GET | `/latency-series` | 延迟趋势（`?agent_id=&target=&type=&start=&end=`，原始点 / 归档层自动选源，≤500 显示点） |
| GET | `/targets?type=&agent_id=` | Target 下拉候选（去重，不受分页影响） |
| DELETE | `/?days=N` | 按天数全量清理（0 = 全部）——**异步**：立即返回 `202 {job_id}` |
| DELETE | `/pair?agent_id=&target=&type=` | 按组合精确删除（同步） |
| POST | `/pairs/bulk-delete` | 批量删除 `{type, pairs:[{agent_id,target}]}`（≤200 组合，异步同上） |
| GET | `/jobs/:id` | 维护任务进度；`:id=current` 返回正在运行的任务。同一时刻只允许一个，再发起返回 `409 probe.job_running` + 运行中的 `job_id` |

### 8.9 其他

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/overview?range=1h\|24h\|7d` | NOC 看板聚合（登录即可） |
| GET | `/api/v1/asn?ips=a,b,c` | 批量 IP → ASN（`asndb.enabled` 时注册） |
| POST | `/api/v1/admin/asndb/download` · `/reload` | ASN 数据下载 / 重载（管理员） |
| GET | `/api/health` | 存活 + DB 连通性（无需认证，120 次/分/IP 限速） |

---

## 9. 配套项目 NMS Agent

[NMS_Agent](https://github.com/Cion-1221/NMS_Agent) 是部署在边缘节点 / 机房的探测程序（纯 Go，Linux / Windows / macOS × amd64 / arm64 交叉编译）。它本地只有身份与服务端地址配置，探测目标、类型、周期、源 IP 绑定、软件升级全部由本项目的 Server 动态驱动：

1. 首次启动用管理员在「注册码」Tab 生成的一次性 token 调 `:8443/api/v1/agents/enroll` 换取 mTLS 客户端证书
2. 之后按 `task_poll_interval` 调 `:8444/api/v1/agent-sync/tasks` 拉任务（diff 式增删探测协程），该调用即心跳
3. 结果攒批 `POST /agent-sync/results`、SNMP 结论 `POST /agent-sync/snmp-results`，失败批次指数退避重试
4. 证书剩余 < 30 天自动 `renew-cert`；服务端响应携带 `update` 时下载校验并原地重启

协议变更需两端同步，发布顺序**先 Server 后 Agent（OTA）**——Agent 对未知任务类型返回空，旧版收到新字段无害。

---

## 10. License

MIT License © 2026 CION
