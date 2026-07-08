# 🌐 CION NMS — 网络管理系统

企业级生产标准的**网络管理系统（NMS）**，前后端彻底分离、按业务域模块化组织。核心能力：

- ✅ **IPAM**：IPv4/IPv6 双栈地址管理——根前缀 CRUD、L1/L2 子网拆分与合并、利用率树视图
- ✅ **Devices**：设备台账——Site → PoP → Device 三层物理结构，角色/厂商字典，全操作审计
- ✅ **SNMP 采集**：设备级 SNMP 监控（system 组资产信息 + sysUpTime 存活判定 + 自定义标量 OID）——**直连**（Server 内置轮询器）与**探针代理**（下发给指定 Agent）双模式，v1/v2c/**v3(USM)** 全支持，运行状态（up/down/unknown）由采集结论驱动，看门狗兜底探针失联；凭证可选 AES-256-GCM 静态加密；MIB 文件库 + gosmi 翻译引擎（OID → 可读名）
- ✅ **System**：用户与用户组、JWT 认证 + Refresh Token 旋转、首次登录强制改密、登录防爆破与锁定管理
- ✅ **Agent**：内置 CA + mTLS 自动引导注册的分布式探针体系——中心化任务调度、MeshPing/MeshMTR 互测矩阵、OTA 版本下发、证书自助续期与 CA 轮换
- ✅ **NOC Dashboard**：登录首页运行总览看板（`/api/v1/overview` 聚合端点，含设备运行状态分面），全站 "Direction A / Clarity" SaaS 设计系统，亮/暗双主题 + EN/ZH 双语

> 探测任务的**执行方**（真正跑 ping/mtr 的 Agent 程序）是独立项目，不在本仓库内。本仓库的 Server 负责 Agent 的注册引导、任务调度、结果存储与展示，并通过 Releases 功能向 Agent 分发二进制更新。

---

## 🏗️ 架构总览

| 层 | 技术栈 |
|----|--------|
| 后端 | Go 1.26 · Gin · GORM · MySQL/MariaDB · 纯标准库 PKI（ECDSA P-256）· 纯标准库日志轮转 |
| 前端 | React 19 · TypeScript · Vite · Ant Design 6 · @ant-design/charts |
| CI | GitHub Actions：打 `v*` tag 自动构建前后端并发布 Release |

后端**单进程同时监听三个端口**：

| 端口（默认） | 配置项 | TLS 模式 | 用途 |
|------|--------|----------|------|
| `8080` | `server.port` | 普通 HTTP（由 Nginx 反代为 HTTPS） | 浏览器前端全部 JWT API |
| `8443` | `agent_pki.enroll_port` | 单向 HTTPS（`tls.NoClientCert`） | Agent 首次注册：`POST /agents/enroll`、`GET /agents/ca-cert` |
| `8444` | `agent_pki.sync_port` | 双向 mTLS（`tls.RequireAndVerifyClientCert`） | `/agent-sync/*`：任务拉取 / 结果上报 / 证书续期 / 二进制下载 |

Go 的 `tls.Config.ClientAuth` 按监听器全局生效，无法在同一端口内按路径区分是否要求客户端证书，因此 enroll 与 sync 必须分开监听。**这两个端口必须让 Agent 直连**（防火墙放行），不能经过 Nginx 反代——mTLS 校验在本进程内完成，Nginx 不认识这套内置 CA。

enroll/sync 监听地址留空主机部分（`:8443`），在支持双栈套接字的系统上同时接受 IPv4/IPv6 连接，纯 IPv4 环境自动回退，无需配置区分。

---

## 📂 目录结构

```text
NMS/
├── .github/workflows/release.yml      # CI：打 v* tag 自动编译并发布 Release
├── scripts/check-error-codes.mjs      # CI：校验后端错误码与前端 i18n 词条一致性
│
├── backend/                           # Go 后端（模块名 nms-backend）
│   ├── main.go                        # 入口：配置/连接池/迁移/Seed/三端口监听/优雅停机
│   ├── logger.go                      # 按天轮转 + gzip 压缩 + 过期清理（纯 stdlib，无第三方依赖）
│   ├── config.example.yaml            # 配置模板（部署时复制为 config.yaml）
│   ├── core/
│   │   ├── errors.go                  # CodedError：携带错误码+插值参数的业务错误类型
│   │   ├── ipam_calc.go               # 纯算法：严格 CIDR 校验、子网拆分/合并
│   │   └── pki.go                     # 内置 Root CA：生成/加载/轮换，签发服务端与客户端证书
│   ├── asndb/                         # 可选：IP→ASN 前缀匹配（BART trie，MTR 逐跳 ASN 标注）
│   │   ├── asndb.go                   # 无锁热重载查询（atomic.Pointer）
│   │   └── downloader.go              # CAIDA/RIPE 数据自动下载 + 每日定时更新
│   ├── models/                        # ipam_ / device_ / sys_ / agent_ 四组数据模型
│   ├── middleware/
│   │   ├── auth.go                    # JWT 校验 + AdminRequired + 强制改密拦截
│   │   ├── mtls.go                    # mTLS 客户端证书校验（CN=AgentID，吊销/序列号比对，心跳刷新）
│   │   └── recovery.go                # panic 恢复（堆栈写入 slog）
│   └── controllers/
│       ├── common.go                  # 跨模块工具：parseIDParam/getUsername/codedErrJSON/isDuplicateErr
│       ├── auth_api.go                # 登录 / 刷新 / 改密 / 会话时长 / UI 偏好
│       ├── system_api.go              # 用户 & 用户组 CRUD（管理员）
│       ├── login_protection.go        # 登录防爆破（滑动窗口 + 锁定列表管理）
│       ├── ipam_api.go                # IPAM REST（根前缀/子网树/拆分/合并/字典/审计）
│       ├── device_api.go              # Devices REST（Sites/PoPs/Roles/Vendors/Devices/审计 + agents-lite/SNMP 详情）
│       ├── device_snmp_poller.go      # SNMP 采集核心：applySNMPResult 唯一落库 + Direct 轮询器 + 运行状态看门狗 + 立即测试
│       ├── device_mib_api.go          # MIB 文件库（上传校验/列表/下载/删除，admin-only 写）
│       ├── agent_enroll_api.go        # Agent 注册引导（一次性注册码原子消费 + IP 防爆破）
│       ├── agent_sync_api.go          # 任务下发（含 snmp_poll 合成）/ 结果上报（probe + snmp）/ 证书续期 / my-ip / 二进制下发 + 离线扫描
│       ├── agent_admin_api.go         # Agent/Group/Task/Token/Release 管理 + CA 状态/轮换
│       ├── probe_results_api.go       # 结果历史 / 最新快照 / MeshPing 矩阵 / 清理
│       ├── overview_api.go            # NOC 看板聚合（时间桶时序 + KPI + 分组健康度）
│       ├── asn_api.go                 # IP→ASN 批量查询 + 数据管理（可选启用）
│       ├── audit_retention.go         # 审计日志 + 探测结果分层自动保留清理
│       ├── probe_rollup.go            # 探测结果降采样归档（Cacti RRA 风格，幂等 upsert）
│       └── seed.go                    # 幂等 Seed：默认 admin 组/账号
│
└── frontend/                          # React 19 + TS + Vite + antd 6
    └── src/
        ├── api/                       # 共享 Axios 实例（自动带 Token）+ 各模块 API 封装
        ├── types/                     # 与后端响应一一对应的 TS 类型
        ├── theme/theme.ts             # 设计令牌：buildTheme(light|dark) + palette + mono 字体
        ├── i18n/                      # useT() 钩子 + EN/ZH 全量翻译
        ├── contexts/                  # AuthContext（Token 静默刷新）/ AppContext（主题/语言）
        ├── components/                # PageHeader / StatusTag / StatTile / MetricCard / RelativeTime 等
        ├── layouts/MainLayout.tsx     # 分组侧边栏 + 顶栏（主题切换/用户菜单）
        └── pages/
            ├── Dashboard.tsx          # ⭐ 登录首页：NOC 运行总览
            ├── Login/                 # 双栏登录（预登录主题切换）
            ├── IPAM/  Devices/        # 各自多 Tab 页面
            ├── Agent/                 # 管理员可见：列表/分组/任务/注册码+CA/版本发布
            ├── ProbeResults/          # 所有登录用户可见：历史/快照/MeshPing 矩阵
            └── System/                # 用户 / 用户组 / 安全设置（防爆破 + 锁定列表）
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
```

首次启动自动建表、生成 Root CA（`backend/data/pki/`）、写入默认账号 **`admin` / `admin`**（首次登录强制改密）。

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

- `data/pki/ca.key` 是整套 Agent 信任体系的根密钥——**务必纳入备份，绝不能进 Git**（`.gitignore` 已排除 `data/`）
- `data/releases/` 存放上传的 Agent 二进制，建议一并备份（丢失不影响已注册 Agent，但需重新上传才能继续下发更新）
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

> ⚠️ 后端主 API 引擎默认只信任**本机**（127.0.0.1/::1）反代的 `X-Forwarded-For`（防止伪造 XFF 绕过登录防爆破）。若 Nginx/LB 部署在其他主机，在 `config.yaml` 的 `server.trusted_proxies` 中加入其内网地址即可，无需改代码。Agent 直连的 enroll/sync 端口不信任任何代理头。

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
| `database` | `max_open_conns` 等连接池 4 项 | 25/10/60m/10m | `conn_max_lifetime_minutes` 必须小于 MySQL `wait_timeout` |
| `jwt` | `secret` / `refresh_token_days` | — / 7 | secret 必须替换为强随机值 |
| `audit` | `max_age_days` | 180 | IPAM/Devices/Agent/System 审计日志保留天数，0 = 永久 |
| | `probe_results_max_age_days` | 30 | 原始探测点保留天数（粒度=任务 Interval）；启用归档后建议缩至 14 |
| | `path_results_max_age_days` | 0 | 路径类结果（mtr/traceroute，大 JSON）独立保留；0 = 跟随上项 |
| | `probe_rollups` | 不启用 | 降采样归档层（Cacti RRA 风格）：推荐 5 分钟/6 月 + 30 分钟/12 月 + 2 小时/3 年 + 1 天/10 年，延迟趋势图自动选源，曲线永不断档 |
| `snmp` | `enabled` | true | SNMP 设备采集总开关：关闭后不启动轮询器/看门狗、不下发 snmp_poll 任务 |
| | `default_interval_seconds` | 60 | 快轮询默认间隔（仅采 sysUpTime，兼做存活判定）；设备表单可逐台覆盖（10–86400） |
| | `inventory_every_n` | 10 | 每 N 次快轮询附带一次完整 system 组（资产信息变化慢，无需每轮全采） |
| | `timeout_seconds` / `retries` | 3 / 1 | 单次 SNMP 请求超时与重试（总请求数 = 1 + retries） |
| | `max_concurrent` | 16 | Direct 模式内置轮询器并发上限 |
| | `metrics_max_age_days` | 14 | 自定义 OID 指标时序保留天数（0 = 永久）；约 16 OID × 60s ≈ 2.3 万行/天/设备 |
| | `metric_rollups` | 不启用 | 指标降采样归档层（推荐 5 分钟/3 月 + 1 小时/12 月 + 1 天/3 年）；趋势图自动选源 |
| | `mibs_dir` | data/mibs | MIB 文件库存储目录（建议纳入备份） |
| | `credentials_key` | 空 | SNMP 凭证静态加密口令（AES-256-GCM）；空 = 明文存库。配置后启动时自动加密存量凭证 |
| | `credentials_key_previous` | 空 | 密钥轮换过渡：key 填新口令、此项填旧口令 → 重启自动重封全部凭证 → 清空此项。⚠️ 两把口令都丢失时凭证不可恢复 |
| `agent_pki` | `enabled` / `dir` / `releases_dir` | true / data/pki / data/releases | 关闭后不生成 CA、不监听 enroll/sync 端口 |
| | `enroll_port` / `sync_port` | 8443 / 8444 | Agent 直连端口 |
| | `server_san` | localhost 等 | ⚠️ 必须覆盖 Agent 拨号地址 |
| | `client_cert_days` / `server_cert_days` / `ca_cert_days` | 365 / 730 / 3650 | 服务端叶子证书每次启动自动重签 |
| `asndb` | `enabled` / `update_hour` | false / 3 | IP→ASN 查询（MTR 逐跳 ASN 列），数据来自 CAIDA RouteViews + RIPE |
| `log` | `dir` / `level` / `format` / `stdout` 等 | logs / info / json / false | 按天轮转，历史 gzip 压缩，双重保留策略（天数 + 份数） |

日志文件：当日 `nms-server.log`，跨天归档为 `nms-server-YYYY-MM-DD.log.gz`。

---

## 🤖 Agent / mTLS 探针体系

### 注册引导（Enrollment）

1. 管理员在 **Agent → Tokens** 页生成一次性注册码（可设有效期、预设分组）；明文仅生成时显示一次，DB 只存 SHA-256 哈希
2. Agent 调 `POST /api/v1/agents/enroll`（单向 HTTPS）携带注册码 + hostname
3. 后端用**原子条件 UPDATE**（`WHERE status='unused' AND expires_at>now`，检查 `RowsAffected`）认领注册码，杜绝并发重复消费；来源 IP 滑动窗口防爆破（10 分钟 10 次失败 → 锁定 15 分钟）
4. 分配全局唯一 `AgentID`（如 `AGT-3F2A9B7C`），内置 CA 签发客户端证书（CN=AgentID，默认 1 年），连同 CA 公钥一起返回
5. 此后所有 `/agent-sync/*` 调用凭该证书做 mTLS——`Subject.CommonName` 即身份，无需再传任何 Token；服务端额外比对证书序列号与吊销状态

### 任务调度与心跳

Agent 周期调用 `GET /api/v1/agent-sync/tasks` 拉取任务，**该调用本身即心跳**——mTLS 中间件顺手刷新 `LastSeenAt`/`Status`/连接 IP（支持 `X-Agent-IPv4` / `X-Agent-IPv6` 头主动上报双栈地址，及 `X-Agent-Version/OS/Arch` 硬件档案）。失联超过 5 分钟的 Agent 由后台扫描（每分钟）自动翻转为 offline。

任务按三级 Scope 下发：**Global**（全部 Agent）/ **Group**（指定分组）/ **Agent**（指定单台）。支持类型：

`ping` · `tcpping` · `httpcheck` · `dnscheck` · `traceroute` · `mtr` · `meshping` · `meshmtr`

**meshping / meshmtr** 的目标列表由 Server 动态解析：同组（或全局）存活 Agent 的 IP 实时组装下发，配置时填写的 Target 被忽略。每个 peer 的 IP 取值优先级：管理员手填的 `source_ip_override`（支持 `ipv4 / ipv6` 双栈格式）→ 自动追踪的 `connection_ipv4/v6` → 旧版 `connection_ip` 兜底。

前端 **Probe Results → MeshPing** 渲染 NxN 延迟热力矩阵（v4/v6 独立单元格），单元格菜单可下钻到对应 (源, 目标) 的 **MTR 逐跳详情**或**延迟趋势图**（1小时～1年/自定义区间，avg/min/max/丢包，数据源按分层保留自动选择）；通用结果 Tab（ping/tcpping/httpcheck/mtr）每行同样提供延迟趋势入口。已知取舍：矩阵按各 Agent *当前* IP 反查历史结果归属，若 IP 在两次探测之间变化，个别历史单元格可能短暂错位。

Agent 还可通过 `GET /agent-sync/my-ip` 分别以 tcp4/tcp6 各调一次，取得 Server 所见的双栈公网地址（穿透 NAT）。

### OTA 版本下发（Releases）

1. 管理员在 **Agent → Releases** 上传各 OS/Arch 的 Agent 二进制（服务端流式写盘 + 同步计算 SHA256，不占内存）
2. 将某版本「激活」——同 OS+Arch 互斥，自动取消其他激活记录
3. 匹配 OS/Arch 且版本不同的 Agent 在下次任务同步响应中收到 `update` 字段（版本/文件 ID/SHA256/大小）
4. Agent 经 mTLS 从 `GET /agent-sync/binary/:id` 下载、校验 SHA256、自替换并重启
5. 前端可实时查看每台 Agent 的更新进度（`/agent-releases/:id/progress` 轮询）

### 证书续期与 CA 轮换

- **续期**：Agent 用现有仍有效的证书调 `POST /agent-sync/renew-cert` 直接换发新证书（语义同 Refresh Token），无需重新注册
- **CA 轮换**：管理页「轮换 CA」生成新 CA 并用于后续签发；旧 CA 公钥保留在 `data/pki/ca-previous.crt`，过渡期内仍被信任，等所有 Agent 续期完毕后「终结轮换」停止信任旧 CA。**两个操作均只落盘，需重启服务进程才生效**（避免对正被并发 TLS 握手读取的信任池做无锁热切换）

### IP→ASN 查询（可选）

`asndb.enabled: true` 后启用。基于 [gaissmai/bart](https://github.com/gaissmai/bart) 前缀树做最长前缀匹配，数据源为 CAIDA RouteViews（v4/v6 前缀表）+ RIPE NCC（AS 名称），每日定时自动下载并**无锁热重载**（atomic pointer swap，查询零停顿）。前端 MTR 弹窗为每一跳标注 ASN 与 ISP 名称。管理员可手动触发下载（`POST /admin/asndb/download`）或重载本地文件（`POST /admin/asndb/reload`）。

---

## 📡 SNMP 设备采集

在 **Devices** 页逐台开启，采集 RFC 1213 system 组（`sysUpTime`/`sysName`/`sysDescr`/`sysObjectID`/`sysLocation`/`sysContact`）+ 设备级**自定义标量 OID**（Drawer 内管理，每台 ≤16 条，与 system 组同一 GET 报文，不额外增加请求）。数值型自定义 OID 自动进**指标时序**（`device_metric_points`）：`gauge` 存瞬时原值，`counter` 在入库时按相邻采样换算**每秒速率**（差值为负 = 回绕/重置则跳点，dt<1s 防除零假尖峰；时间基准是 Agent 侧的采集时刻 `collected_at`，不受批量上报影响）；Drawer 内每个 OID 提供趋势图（1h/6h/24h/7d/30d/90d 时间桶聚合 avg/min/max，图表代码块懒加载不拖累首屏），原始点保留 `snmp.metrics_max_age_days`，配置 `snmp.metric_rollups` 后启用**降采样归档层**（Cacti RRA 风格，与 probe_rollups 同构：每小时幂等聚合 + GET_LOCK 多实例互斥 + 按层保留），趋势查询按窗口自动选源（原始点 → 最细可覆盖归档层），长窗口曲线不断档。

**接口表采集**（表单开关 `采集接口表`）：每周期 WALK `ifTable`/`ifXTable` 两个子树，维护接口维表 `device_interfaces`——名称（ifName 优先回退 ifDescr）、别名（ifAlias）、速率上限（ifHighSpeed 优先）、admin/oper 状态（RFC 2863 枚举）、实时流量（HC 64 位计数器优先，服务端相邻采样换算 bit/s）、累计错误；消失的接口自动清理（WALK 明确成功才 reconcile，失败保留最后已知状态）；单设备上限 512 接口。Drawer 内接口区块展示（分页小表）。按接口的历史趋势不入库——关键端口用自定义 OID（如 `ifHCInOctets.<ifIndex>` + counter 类型）获得完整时序与归档。支持 **SNMP v1 / v2c / v3(USM)**——v3 安全级别由字段组合推导（authProto 空 = noAuthNoPriv，authProto = authNoPriv，authProto+privProto = authPriv；认证 MD5/SHA/SHA2 族，加密 DES/AES 族），且 v3 有显式认证失败报文，运行状态可精确区分 `auth_fail` 与真离线（v1/v2c 协议下 community 错误只能表现为超时）。

**凭证安全**：community 与 v3 口令均 `json:"-"` 永不出现在任何 API 响应（前端以 `*_set` 派生标志感知，编辑留空 = 不修改）；配置 `snmp.credentials_key` 后凭证 AES-256-GCM 静态加密落库（`enc:v1:` 前缀密文与明文旧值共存，启动时一次性清扫加密，渐进迁移零停机），解密仅发生在采集/任务合成的读路径。

### 状态双字段模型

- **管理状态**（`status`，用户设置）：`active` / `maintenance` / `planned`——生命周期意图，SNMP 不改写它（`offline` 为遗留值，UI 显示"已停用"，表单不再提供）
- **运行状态**（`oper_status`，机器写入）：`up` / `down` / `unknown`——只由采集链路驱动，`oper_reason` 记录原因；`planned`/停用设备不采集，`maintenance` 照常采集（真相不丢，前端叠加维护标识）

### 直连与探针代理双模式

| 模式 | 执行方 | 适用场景 |
|------|--------|----------|
| **Direct SNMP** | Server 内置轮询器（worker pool + 到期扫描 + 在途去重） | Server 可直达设备管理地址 |
| **Agent Proxy** | 表单指派的 Agent（同机房/同网段） | 管理网段仅探针可达 |

代理模式的 `snmp_poll` 任务**不进 `agent_tasks` 表**——`GET /agent-sync/tasks` 从 devices 表即时合成（与 meshping 动态解析同思路），虚拟 TaskID = `2³⁰ + device_id`，凭证经 mTLS 信道下发（Agent 仅内存持有）；结论经 `POST /agent-sync/snmp-results` 回传，服务端校验"设备确实指派给调用方"后才落库（防越权伪造）。两种模式最终都汇聚到同一落库路径 `applySNMPResult`：状态快照 upsert（`device_snmp_states`，每设备一行，不进 probe_results 热表）、运行状态翻转、`sysUpTime` 回退检测（疑似重启 → 写 `reboot_detected` 审计，注意 32 位 TimeTicks 约 497 天自然回绕会有一次误报）。

**快/慢两档节奏**：每个采集周期只 GET `sysUpTime`（最小报文，兼做存活判定），每 `inventory_every_n` 次附带完整 system 组。

### 看门狗（防连环故障幽灵状态）

Agent 断电后无法上报"设备超时"，没有兜底的话其名下设备会永远停在最后一次结论。后台每分钟扫描：判定依据是**设备自身的 `last_poll_at`**（最近拿到采集结论的时间，direct 模式 poller 卡死同样被覆盖），停滞超过 `max(3 × 采集间隔, 300s)` → `unknown`（agent 模式原因为 `agent_down`，前端展示 **Proxy Down**）；探针被吊销/删除立即归位 `unknown/agent_revoked`；planned/停用设备的残留结论归位 `unknown`。

### 前端交互

设备表单（两列布局）选择采集模式/探针/凭证（Community 永不回显，编辑留空 = 不修改）；列表新增运行状态列与 Uptime 列；点主机名打开 **SNMP 详情 Drawer**（system 组全量 + 采集来源/延迟/最近错误），direct 模式提供**立即测试**按钮（同步采集一次并落库）。NOC 看板含运行状态分面（up/down/proxy down）并生成对应告警条目。

### MIB 文件库与翻译引擎（Devices → MIBs）

admin 上传（≤2 MiB，轻量 SMI 校验：提取 `<模块名> DEFINITIONS ::= BEGIN`、SHA256、模块名唯一），登录用户可查看/下载。文件按 `<模块名>.mib` 落盘——**gosmi 翻译引擎**（纯 Go 的 libsmi 移植）按模块名解析 IMPORTS 依赖，启动与每次上传/删除后全量重建；单模块解析失败不影响其他模块（常见原因是依赖模块未上传，补传后自动转好，解析状态在列表可见）。**标准基础模块已内置**：SNMPv2-SMI/TC/CONF/MIB、SNMP-FRAMEWORK、INET-ADDRESS、IANAifType、IF-MIB、RFC1155/1213/1215 共 12 个（go:embed 编译进二进制，首次启动自动 seed，`sys_settings` 标记保证管理员删除后不复活）——厂商 MIB 几乎都依赖它们，上传即可解析。引擎用途：`GET /devices/mibs/translate?oid=` 数字 OID → 可读名（最长前缀匹配）；Drawer 中 sysObjectID 自动显示翻译名（如 `CISCO-PRODUCTS-MIB::cisco7206VXR`）；自定义 OID 留空名称时自动命名。

---

## 👤 用户 · 认证 · 安全

**模块级权限模型**：用户组的 `permissions` 是权限值数组（白名单校验），JWT 签发时固化进 `perms` 声明（组权限变更在下次 Token 刷新时生效）。前端按权限隐藏写操作入口，后端路由中间件强制校验（双重保障）：

| 权限值 | 授予的能力 |
|--------|-----------|
| （无，只读基线） | 所有登录用户：查看 Dashboard / IPAM / Devices / Probe Results / 各审计日志 |
| `ipam:write` | IPAM 全部写操作（根前缀 CRUD、拆分/合并、字典维护） |
| `devices:write` | Devices 全部写操作（设备/站点/PoP/角色/厂商 CRUD，含 SNMP 采集配置与立即测试） |
| `admin` | 超级管理员：隐含全部权限 + 用户/组管理、Agent 体系、MIB 库上传/删除、安全设置、各类数据清理 |

- **账号生命周期**：账号可**停用/启用**（停用即吊销全部会话，历史数据保留；停用状态只有在密码校验通过后才提示，防用户名枚举）；管理员可**强制下线**任意用户（吊销全部 Refresh Token）；用户列表展示启用状态、活跃会话数、最后登录时间；创建/重置密码支持**一键生成强随机密码**
- **首次登录强制改密**：默认账号 `admin/admin` 登录后（以及管理员重置密码后），后端 JWT 声明 + 中间件双重拦截，改密前只放行 `me` / `change-password` 两个接口
- **Token 机制**：Access Token 有效期用户自定义（1–720 小时，默认 24h），且不超过管理员在安全设置中配置的**全局会话时长上限**；Refresh Token 默认 7 天，**旋转式**——每次刷新旧 Token 即作废；前端在到期前 5 分钟静默换新
- **登录防爆破**（系统 → 安全设置可调）：同一「用户名+IP」窗口内失败达阈值即临时锁定（默认 5 分钟 5 次 → 锁 15 分钟）；用户不存在与密码错误同样计数，防用户名枚举；内置**锁定列表**支持搜索与单条/批量手动解锁。计数保存在内存，单实例部署下重启即清零
- **System 审计日志**：用户/用户组/安全设置/会话管理的全部敏感操作（含自助改密、手动解锁、强制下线）写入 `sys_audit_logs`，安全设置页可查询与按天数清理，与其余模块共用保留策略
- **管理保护**：不能删除/停用/降权最后一个**启用状态**的管理员账号或唯一管理员组（组权限按解析结果校验，非字符串比较）；不能删除/停用自己、不能修改自己的组
- **健康检查**：`GET /api/health`（无需认证）探测 DB 连通性，DB 故障返回 503，供 LB/监控接入

---

## 🗂️ API 速查

错误响应统一形如 `{"error": "<中文描述>", "code": "<机器可读错误码>", ...插值参数}`。所有面向浏览器的模块（Auth/System/IPAM/Devices/Agent 管理/Probe Results/ASN）的**静态确定性错误**均带 `code`（如 `auth.locked`、`device.ipv4_taken`、`sys.last_admin_user`），前端按 `code` 做 i18n 映射（`src/i18n/apiErrors.ts`，支持 `{minutes}`/`{count}` 等参数插值），未命中时回退展示 `error` 原文。动态拼接 DB 详情的报错与 Agent 机器端点（enroll/sync）不带 code。IPAM 拆分/合并等 core 层业务错误通过 `core.CodedError` 携带 code 与插值参数。**后端新增错误码时需同步 apiErrors.ts 词条**——`scripts/check-error-codes.mjs` 会在 CI 构建时校验两侧一致性（也可本地 `node scripts/check-error-codes.mjs` 运行）。

### 认证 `/api/v1/auth`

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/login` · `/refresh` | 无需 JWT；返回 access+refresh token 对 |
| GET | `/me` | 当前用户信息 |
| POST | `/change-password` | 自助改密（返回新 Token 对） |
| PUT | `/settings` · `/profile` | 会话时长（1–720h）· UI 偏好（theme/language） |

### IPAM `/api/v1/ipam`（JWT；写操作需 `ipam:write` 权限，审计清理仅管理员）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/POST/PUT/DELETE | `/root-prefixes[/:id]` | 根前缀 CRUD（严格 CIDR 校验；删除时事务+行锁级联清理子网） |
| GET | `/root-prefixes/:id/tree` | L1→L2 完整层级树 |
| POST | `/split` · `/merge` | 子网拆分 / 合并（2ⁿ 校验 + Re-parenting） |
| GET/POST/PUT/DELETE | `/groups` `/types` `/vrfs` | 字典 CRUD |
| GET / DELETE | `/audit-logs` | 审计日志分页查询 / 按天数清理 |

### Devices `/api/v1/devices`（JWT；写操作需 `devices:write` 权限，审计清理与 MIB 写仅管理员）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/POST/PUT/DELETE | `/` `/:id` | 设备 CRUD（IPv4/IPv6 至少一项、全局唯一；服务端分页多条件过滤，含 `oper_status`/`polling_mode`；SNMP 凭证永不回显，编辑留空 = 不修改） |
| GET/POST/PUT/DELETE | `/sites` `/pops` `/roles` `/vendors` | 字典 CRUD（PoP 名在 Site 内唯一；PoP 迁站级联更新设备） |
| GET | `/agents-lite` | 表单"采集探针"下拉的轻量 Agent 列表（登录即可，最小字段集） |
| GET | `/:id/snmp` | SNMP 详情：采集配置 + 状态快照 + 自定义 OID + sysObjectID 翻译名（Drawer 数据源） |
| POST | `/:id/snmp/test` | 立即测试（仅 direct 模式）：同步采集一次并落库，`devices:write` |
| POST/PUT/DELETE | `/:id/snmp/oids[/:oid_id]` | 自定义标量 OID 管理（≤16/设备，`devices:write`；名称留空自动 MIB 命名；gauge/counter 指标类型） |
| GET | `/:id/snmp/oids/:oid_id/series?range=1h\|6h\|24h\|7d` | 指标趋势序列（时间桶聚合 avg/min/max；counter 已是每秒速率） |
| GET | `/mibs/translate?oid=` | 数字 OID → 可读名（gosmi 最长前缀匹配，登录即可） |
| GET / POST / DELETE | `/mibs` `/mibs/:id[/download]` | MIB 文件库：列表/下载登录即可；上传（≤2 MiB，SMI 校验+去重，含解析状态）/删除仅管理员 |
| GET / DELETE | `/audit-logs` | 审计日志 |

### System `/api/v1/system`（JWT + 管理员）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET/POST/PUT/DELETE | `/users` `/groups` | 用户 / 用户组 CRUD（用户含 `enabled` 启停；组权限白名单校验） |
| POST | `/users/:id/force-logout` | 强制下线：吊销该用户全部 Refresh Token |
| GET/PUT | `/settings/security` | 登录防爆破阈值 |
| GET/PUT | `/settings/session` | 会话策略：全局最大会话时长（签发 Token 时钳制） |
| GET / POST | `/security/lockouts[/unlock]` | 锁定列表 / 手动解锁（单条或批量） |
| GET / DELETE | `/audit-logs` | System 审计日志分页查询 / 按天数清理 |

### Agent 注册（enroll 端口 8443，无需认证）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/agents/enroll` | `{provisioning_token, hostname}` → AgentID + 客户端证书 |
| GET | `/api/v1/agents/ca-cert` | Root CA 公钥（PEM） |

### Agent 同步（sync 端口 8444，强制 mTLS）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/agent-sync/tasks` | 拉取任务（即心跳）；响应含 source_ip 绑定、OTA update 字段与合成的 snmp_poll 任务（含凭证参数块） |
| POST | `/api/v1/agent-sync/results` | 批量上报探测结果 |
| POST | `/api/v1/agent-sync/snmp-results` | 批量回传 SNMP 采集结论（校验设备归属后驱动运行状态） |
| POST | `/api/v1/agent-sync/renew-cert` | 证书自助续期 |
| GET | `/api/v1/agent-sync/my-ip` | 返回 Server 所见来源 IP（双栈探测用） |
| GET | `/api/v1/agent-sync/binary/:id` | 流式下载 Agent 二进制 |

### Agent 管理（主端口，JWT + 管理员）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/agents` · `/agents/summary` | 分页列表 · 健康汇总 |
| PUT/DELETE | `/agents/:agent_id` | 修改（hostname/SourceIP/分组）/ 删除（`?purge=true` 连带清探测记录） |
| POST | `/agents/:agent_id/revoke` | 作废证书（保留历史数据） |
| GET/POST | `/agents/ca-cert` `/agents/ca/status` `/agents/ca/rotate` `/agents/ca/finalize` | CA 查看 / 轮换 / 终结 |
| CRUD | `/agent-groups` `/agent-tasks` `/agent-tokens` | 分组 / 任务（POST 支持多类型批量创建）/ 注册码 |
| GET/POST/DELETE | `/agent-releases` 及 `/:id/set-active` `/:id/progress` | OTA 版本上传 / 激活 / 进度 |

### 探测结果 `/api/v1/probe-results`（JWT，仅需登录）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 分页历史（`?type=&agent_id=&q=&success=&start=&end=`） |
| GET | `/latest` | 快照视图：每个 (Agent, Target) 只取最新一条 |
| GET | `/meshping-matrix` | NxN 透视矩阵（`?group_id=&q=`） |
| GET | `/latency-series` | 延迟趋势序列（`?agent_id=&target=&type=&start=&end=`）：在原始点与归档层间自动选源，聚合到 ≤500 个显示点（avg/min/max/丢包） |
| DELETE | `/` · `/pair` | 清理（管理员）：按天数全量 / 按 (agent, target, type) 组合 |

### 其他

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/overview?range=1h\|24h\|7d` | NOC 看板聚合（登录即可） |
| GET | `/api/v1/asn?ips=a,b,c` | 批量 IP→ASN（`asndb.enabled` 时注册） |
| POST | `/api/v1/admin/asndb/download` · `/reload` | ASN 数据管理（管理员） |
| GET | `/api/health` | 存活 + DB 连通性（无需认证） |

---

## 🎨 前端设计系统

**"Direction A / Clarity"** —— 纯表现层设计系统，业务逻辑（分页/防抖/请求序号守卫/校验）与视觉完全解耦：

- **字体**：UI 用 Plus Jakarta Sans；IP/ID/指标/时间戳统一 IBM Plex Mono（`--cion-mono`）
- **主题**：`theme/theme.ts` 的 `buildTheme(mode)` 注入 antd 6 令牌，亮/暗双主题 + 跟随系统；偏好持久化到服务端用户档案（跨设备同步），登录页可预选，会话内手动切换优先。注意 antd 6 `cssVar` 变量只在组件子树内生效——组件树外的裸 DOM（登录页、加载屏）直接取 `palette` 原始 hex
- **国际化**：EN/ZH 全量翻译（`i18n/translations.ts`），antd locale 联动切换
- **导航**：侧边栏分组 Overview / Infrastructure / Monitoring / Administration；登录后默认落地 `/dashboard`
- **看板**：KPI 卡（mono 大数字 + sparkline）、探测量时序（1H/24H/7D 分桶）、设备状态环图、分组健康度、活跃告警；30s 轮询 + 请求序号守卫；`@ant-design/charts` 较重，Dashboard 路由懒加载
- **通用组件**：`PageHeader` / `StatusTag`（主题化状态药丸）/ `StatTile` / `MetricCard` / `RelativeTime`（全局相对时间，随语言，悬停显示绝对时间）

---

## 🧩 数据模型与模块隔离

所有模块共存于 `nms_db`，以**表名前缀**隔离命名空间：

| 模块 | 前缀 | 数据表 |
|------|------|--------|
| IPAM | `ipam_` | root_prefixes · subnets · groups · types · vrfs · audit_logs |
| System | `sys_` | groups · users · refresh_tokens · settings · audit_logs |
| Devices | `device_` | sites · pops · roles · vendors · devices · snmp_states · mibs · audit_logs |
| Agent | `agent_` | groups · agents · tokens · tasks · releases · audit_logs（+ `probe_results`） |

关键关系与删除策略：

- **IPAM**：禁止单独删除 L1/L2 子网，只能通过 Split/Merge 重组；删除根前缀在同一事务 + `FOR UPDATE` 行锁内级联清理全部子网
- **Devices**：删站点须先清空其 PoP；删 PoP/角色/厂商时关联设备外键置 NULL；PoP 迁站在事务内级联更新所属设备；删设备连带清理 SNMP 状态快照
- **Agent**：删分组时组内 Agent/Task 的 `group_id` 置 NULL；删 Agent 为硬删除（可选连带清探测记录，并解绑其名下设备的 SNMP 采集），只想断连请用「作废证书」；注册码 `unused → used` 经原子条件 UPDATE 转换
- 敏感凭据（用户密码 bcrypt、Refresh Token、注册码）一律**只存哈希**；SNMP Community 明文存库但 `json:"-"` 永不出现在任何 API 响应（前端以 `snmp_credential_set` 布尔感知）

---

## 📦 版本发布

打 tag 即发版：

```bash
git tag v1.19.0 && git push origin v1.19.0
```

GitHub Actions 自动：错误码一致性检查（`scripts/check-error-codes.mjs`）→ 前端 `npm run build` 打包 `dist.tar.gz` → 后端 `go test ./...` + 交叉编译 Linux amd64 `nms-server` → 提取自上个 tag 以来的 commit 生成 Changelog → 创建 GitHub Release。

---

## 📄 License

MIT License © 2026 CION
