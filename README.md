# 🌐 NMS Enterprise System（网络管理系统）

企业级生产标准的**网络管理系统 (NMS)**，采用彻底的前后端分离与模块化架构。现已完成：

- ✅ **IPAM 模块**：IP 地址管理（IPv4 / IPv6 双栈，根前缀 CRUD + L1/L2 子网拆分/合并）
- ✅ **System 模块**：用户 & 用户组权限管理，JWT 认证，首次登录强制改密，登录防爆破
- ✅ **Devices 模块**：设备台账管理（Site → PoP → Device 三层结构，角色、厂商、全操作审计日志）
- ✅ **Agent 模块**：基于内置 CA + mTLS 自动引导注册的分布式探针体系，中心化任务调度，MeshPing 互测矩阵

---

## ✨ 核心特性

| 特性 | 说明 |
|------|------|
| 🔐 **JWT 认证** | Bearer Token 保护全部 API，Access Token 有效期用户自定义（默认 24 h） |
| 🔒 **首次登录强制改密** | 默认账号 `admin/admin`，登录后必须立即修改，后端双重拦截 |
| 🔄 **Token 静默刷新** | Access Token 到期前 5 分钟自动换取新 Token 对（Token 旋转），无感知续期 |
| 👥 **细粒度权限** | `admin` 组拥有完整管理权；其他组仅限自助改密 |
| 🛡️ **严格 CIDR 校验** | Go `net/netip` 深度拦截含主机位的非标准地址 |
| ⚡ **O(N) 树形重组** | 内存级一次遍历将扁平数据还原为 Root→L1→L2 嵌套树 |
| 🧩 **业务约束** | 严禁单独删除 L1/L2 子网；仅允许通过 Split/Merge 生成与重组 |
| 📦 **安全级联删除** | 删除根前缀时，同一事务 + FOR UPDATE 行锁彻底清理所有衍生子网 |
| 🖧 **双栈 IP 管理** | 设备同时支持 IPv4 + IPv6 管理地址，至少填一项，全局唯一约束 |
| 🗂️ **三层物理层级** | Site → PoP → Device；PoP 名称在 Site 内唯一（DB 复合索引），变更 PoP 所属 Site 时级联更新所有关联设备 |
| 📊 **状态台账** | 设备状态枚举：Active / Offline / Maintenance / Planned，Tag 高亮显示 |
| 📋 **操作审计日志** | IPAM / Devices / Agent 三个模块全部写操作自动记录，支持分页检索及按保留天数自动清理 |
| 🪵 **生产级日志** | `slog + lumberjack` 结构化 JSON 日志，按大小/天数自动轮转 |
| 🧱 **模块化前缀** | `ipam_` / `sys_` / `device_` / `agent_` 表前缀，安全共存于 `nms_db` 统一数据库 |
| 🔐 **mTLS 双向认证** | 启动时自动生成/加载内置 Root CA；Agent 与 Server 双向验证证书，序列号 + 吊销状态实时校验 |
| 🎫 **一次性注册码自动引导** | Token 原子条件消费（杜绝并发重复使用），到期/已用/已吊销均拒绝，来源 IP 滑动窗口防爆破 |
| 🔁 **证书自助续期 + CA 轮换** | Agent 用现有有效证书自助换发新证书；CA 轮换支持新旧双 CA 过渡期，平滑迁移 |
| 📡 **中心化任务调度** | Server 按全局 / 分组 / 单 Agent 三级下发 ping / tcpping / httpcheck / dnscheck / traceroute / mtr / meshping 任务 |
| 🕸️ **MeshPing 互测矩阵** | 同组存活 Agent 互相探测延迟，前端渲染 NxN 交叉矩阵，支持按分组/关键字过滤 |
| 💓 **心跳即任务拉取** | mTLS 调用本身即心跳；离线 Agent 由后台扫描自动翻转状态，无需独立心跳接口 |

---

## 📋 前置环境依赖（本地开发）

| 依赖 | 版本 | 说明 |
|------|------|------|
| **Go** | ≥ 1.22 | 后端编译，本地开发需要（mTLS/CA 全部基于标准库，无需额外依赖） |
| **Node.js** | ≥ 22 LTS | 前端编译，npm 随附 |
| **MySQL** | ≥ 8.0 | 生产/开发数据库 |
| **Git** | 最新版 | 代码管理与 push |
| **Nginx** | ≥ 1.18 | 生产部署：前端静态托管 + 主 API 反代（Agent mTLS 端口需直连，见下文） |

> 💡 **仅需发布不需本地调试时**：只需安装 Git，推送代码后 GitHub Actions 自动完成编译。

---

## 📂 完整目录结构

```text
NMS/
├── README.md
├── .github/
│   └── workflows/
│       └── release.yml                # CI：打 v* tag 自动编译并发布 Release
│
├── backend/                           # Go 后端
│   ├── go.mod / go.sum
│   ├── config.example.yaml            # 配置模板（部署时复制为 config.yaml）
│   ├── main.go                        # 服务入口：配置/DB/迁移/Seed/三个监听端口路由
│   ├── core/
│   │   ├── ipam_calc.go               # 纯算法：CIDR 校验、拆分、合并
│   │   └── pki.go                     # 内置 CA：生成/加载/轮换、签发服务端与客户端证书
│   ├── models/
│   │   ├── ipam_models.go             # IPAM 数据模型
│   │   ├── device_models.go           # Devices 数据模型（Site/PoP/Role/Vendor/Device/AuditLog）
│   │   ├── sys_models.go              # System 数据模型（sys_groups, sys_users）
│   │   └── agent_models.go            # Agent 数据模型（Group/Agent/Token/Task/ProbeResult/AuditLog）
│   ├── middleware/
│   │   ├── auth.go                    # JWT 认证中间件 + AdminRequired
│   │   ├── recovery.go                # panic 统一恢复中间件
│   │   └── mtls.go                    # mTLS 客户端证书校验中间件（agent-sync 端口）
│   └── controllers/
│       ├── ipam_api.go                # IPAM REST API（受 JWT 保护）
│       ├── device_api.go              # Devices REST API（Sites/PoPs/Roles/Vendors/Devices/Audit）
│       ├── auth_api.go                # 登录 / 改密 / 当前用户
│       ├── system_api.go              # 用户 & 用户组 CRUD（仅管理员）
│       ├── login_protection.go        # 登录防爆破 + 锁定列表
│       ├── audit_retention.go         # 审计日志 + 探测结果自动保留清理
│       ├── seed.go                    # 数据库初始化（幂等写入默认 admin）
│       ├── agent_enroll_api.go        # Agent 注册引导（单向 HTTPS）+ 来源 IP 防爆破
│       ├── agent_sync_api.go          # Agent 任务拉取 / 结果上报 / 证书续期（mTLS）+ 离线扫描
│       ├── agent_admin_api.go         # Agent/Group/Task/Token 管理 + CA 状态/轮换 + 健康汇总（JWT）
│       └── probe_results_api.go       # 探测结果查询 / 最新快照 / MeshPing 矩阵（JWT）
│
├── agent-skeleton/                    # 独立 Go 模块（不参与 backend 构建/CI）
│   ├── go.mod
│   └── main.go                        # Agent 协议参考骨架：引导/mTLS/任务拉取/SourceIP 绑定/续期
│
└── frontend/                          # React + TypeScript 前端
    ├── package.json
    ├── vite.config.ts
    └── src/
        ├── api/
        │   ├── client.ts              # 共享 Axios 实例（自动携带 Token + 401 处理）
        │   ├── auth.ts / ipam.ts / device.ts / system.ts
        │   └── agent.ts               # Agent / Probe Results 全部 API
        ├── types/
        │   ├── auth.ts / ipam.ts / device.ts / system.ts
        │   └── agent.ts               # Agent / AgentTask / ProbeResult / PKIStatus 等类型
        ├── i18n/
        │   └── translations.ts        # 全局 EN/ZH 双语翻译键值
        ├── contexts/
        │   └── AuthContext.tsx        # 全局认证状态（localStorage 持久化）
        ├── components/
        │   └── ChangePasswordModal.tsx
        ├── layouts/
        │   └── MainLayout.tsx         # 侧边栏（Devices / Agent / System 菜单）+ 顶栏
        └── pages/
            ├── Login/
            ├── IPAM/
            ├── Devices/
            ├── System/
            │   ├── User/ Group/
            │   └── Settings/                   # 安全设置（Tab：防护配置 / 锁定列表）
            ├── Agent/                           # 管理员可见
            │   ├── index.tsx                    # 4 标签页容器
            │   └── components/
            │       ├── TabAgentList.tsx         # 健康汇总卡片 + 列表（搜索/分页/批量删除·作废）
            │       ├── TabGroups.tsx            # 分组 CRUD
            │       ├── TabProbeConfig.tsx        # 任务下发（多选类型/Scope联动/多行Target）
            │       └── TabTokens.tsx            # CA 状态/轮换面板 + 注册码生成（倒计时展示）
            └── ProbeResults/                    # 任何已登录用户可见
                ├── index.tsx                    # 5 标签页容器
                └── components/
                    ├── TabGenericResults.tsx    # ping/tcpping/httpcheck/mtr 复用（历史/最新快照切换）
                    └── TabMeshPingMatrix.tsx     # NxN 交叉延迟矩阵
```

---

## 🚀 生产部署指南（Debian 12/13 · Ubuntu 24/26）

### 1. 准备 MySQL 数据库

```bash
sudo apt update && sudo apt install -y default-mysql-server
sudo systemctl enable --now mysql

sudo mysql <<'EOF'
CREATE DATABASE IF NOT EXISTS nms_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'nms_user'@'localhost' IDENTIFIED BY 'StrongPassword123!';
GRANT ALL PRIVILEGES ON nms_db.* TO 'nms_user'@'localhost';
FLUSH PRIVILEGES;
EOF
```

### 2. 部署后端二进制

从 [GitHub Releases](../../releases) 下载 `nms-server`，上传到服务器：

```bash
sudo mkdir -p /opt/nms/backend && cd /opt/nms/backend
sudo chmod +x nms-server

cp config.example.yaml config.yaml
nano config.yaml
```

**`config.yaml` 完整示例：**

```yaml
server:
  port: 8080

database:
  host: "127.0.0.1"
  port: 3306
  user: "nms_user"
  password: "StrongPassword123!"   # ← 替换为真实密码
  dbname: "nms_db"
  # 连接池（可省略）
  max_open_conns: 25               # 最大并发连接数
  max_idle_conns: 10               # 最大空闲连接数
  conn_max_lifetime_minutes: 60    # 连接最长存活（须小于 MySQL wait_timeout）
  conn_max_idle_time_minutes: 10   # 空闲连接最长保留

jwt:
  # ⚠️ 必须替换为随机字符串（至少 32 位），切勿泄露
  secret: "REPLACE_WITH_RANDOM_SECRET_AT_LEAST_32_CHARS"
  # Refresh Token 有效期（天）
  refresh_token_days: 7

# 审计日志 / 探测结果自动保留（可省略；0 = 永久保留）
audit:
  max_age_days: 180                      # IPAM / Devices / Agent 审计日志
  probe_results_max_age_days: 30         # Agent 自动周期探测写入的结果，量级更高，默认更短

# Agent PKI：内置 CA + mTLS 自动引导注册（整个 agent_pki 块可省略，使用下列默认值）
agent_pki:
  enabled: true
  dir: "data/pki"                  # Root CA 持久化目录，务必纳入备份，不要纳入版本控制
  enroll_port: 8443                # Agent 首次注册引导（单向 HTTPS）
  sync_port: 8444                  # Agent 任务拉取/结果上报/证书续期（mTLS）
  server_san:                      # ⚠️ 必须覆盖 Agent 实际拨号使用的主机名/IP，否则握手失败
    - "your-nms-host.example.com"
    - "10.0.0.1"
  client_cert_days: 365            # 签发给 Agent 的客户端证书有效期
  server_cert_days: 730            # enroll/sync 端口服务端叶子证书有效期（每次启动自动重签）
  ca_cert_days: 3650               # Root CA 有效期

# 日志（整个 log 块可省略，省略时使用下列默认值）
log:
  dir: "logs"          # 日志目录，支持绝对路径（如 /var/log/nms）
  max_age_days: 30     # 保留最近 N 天，0 = 不限制
  max_backups: 30      # 最多保留 N 个旧文件，0 = 不限制
  compress: true       # gzip 压缩历史日志
  level: "info"        # debug | info | warn | error
  format: "json"       # json（适合 ELK/Loki） | text（适合直接 grep）
  stdout: false        # 同时输出到标准输出（Docker / journald 推荐开启）
  access_log: true     # HTTP 访问日志；Nginx/LB 层已采集时可关闭
```

> **服务首次启动会自动建表、生成 Root CA、并写入默认账号 `admin/admin`（MustChangePassword=true）。**
>
> 日志按天轮转，文件名格式 `nms-server-2026-06-11.log`，历史文件自动压缩为 `.log.gz` 并按保留策略清理。

**⚠️ Agent PKI 防火墙/反代注意事项：**

- `enroll_port`（8443）与 `sync_port`（8444）由 Go 进程自己用内置 CA 终结 mTLS，**必须放行 Agent 直连**，不要走 Nginx 反代——Nginx 不知道这套内置 CA，反代会破坏证书校验。
- `server_san` 必须包含 Agent 实际拨号使用的主机名/IP；否则 Agent 侧 TLS 校验会因证书 SAN 不匹配而失败。
- `data/pki/` 目录里的 `ca.key` 是整套信任体系的根密钥，**务必加入服务器备份**，且**绝不能提交进 Git**（仓库 `.gitignore` 已排除 `data/`）。

### 3. 配置 systemd 服务常驻

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
sudo systemctl status nms-backend
```

> CA 轮换（见下文「Agent / mTLS 探针体系」）等操作只落盘、不热生效，需要 `sudo systemctl restart nms-backend` 才会真正生效。

### 4. 部署前端 + Nginx

```bash
sudo apt install -y nginx
sudo mkdir -p /var/www/nms && cd /var/www/nms
sudo tar -zxvf /path/to/dist.tar.gz
```

**步骤 A — HTTP 基础配置：**

```bash
sudo tee /etc/nginx/sites-available/nms <<'EOF'
server {
    listen 80;
    server_name 你的服务器IP或域名;

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

> 注意：上面只反代主 API 端口（8080）。Agent 的 `enroll_port`/`sync_port` 不在 Nginx 配置里——它们需要在云厂商安全组/服务器防火墙上单独放行，让 Agent 主机能直连。

**步骤 B — 升级 HTTPS（推荐生产必选，需要已绑定域名）：**

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

Certbot 会自动申请 Let's Encrypt 证书、注入 SSL 配置并添加 HTTP → HTTPS 重定向。证书每 90 天自动续期（`sudo certbot renew --dry-run` 可验证）。这与 Agent PKI 的内置 CA 是两套完全独立的体系，互不影响。

---

## 🛠️ 本地开发指南

### 后端

```bash
cd backend
go mod tidy
cp config.example.yaml config.yaml
# 编辑 config.yaml 填入本地数据库连接和 JWT secret
go run main.go        # 监听 :8080（主 API）+ :8443（Agent enroll）+ :8444（Agent sync）
```

首次启动会在 `backend/data/pki/` 下自动生成 Root CA，自动建表并写入默认 admin。

### 前端

```bash
cd frontend
npm install
npm run dev           # 监听 :5173，/api 请求自动代理到 :8080
```

访问 http://localhost:5173，使用 `admin` / `admin` 登录，首次登录会强制修改密码。

### Agent 参考骨架（仅用于验证协议，不是生产 Agent）

```bash
cd agent-skeleton
go run . -server 127.0.0.1 -token <在 NMS 前端 Token 页生成的注册码>
```

---

## 👤 用户与权限

| 角色 | 默认账号 | 权限 |
|------|---------|------|
| **管理员（admin 组）** | `admin` / `admin` | 查看全部内容；创建/编辑/删除所有用户；重置任意用户密码；管理用户组；管理 Agent/Group/Probe Config/Token |
| **普通用户（其他组）** | 由管理员创建 | 查看 IPAM / Devices / Probe Results 数据；仅可自助修改自己的密码（需提供旧密码） |

**首次登录流程：**
1. 用 `admin` / `admin` 登录 → 后端签发 `must_change_password=true` 的 Token 对
2. 前端检测到标志 → 显示强制改密页面（无法跳过）
3. 输入旧密码 `admin` + 新密码（≥ 8 位）→ 修改成功
4. 后端签发新 Token 对（`must_change_password=false`）→ 自动进入系统

**Token 静默刷新机制：**
- **Access Token** 有效期：用户自定义（1–720 小时），默认 **24 小时**
- **Refresh Token** 有效期：服务器配置（`refresh_token_days`），默认 **7 天**
- 前端在 Access Token 到期前 **5 分钟**自动调用 `/auth/refresh`，无感知换取新 Token 对（Token 旋转）
- 用户可在右上角菜单 → **会话时长设置** 中调整 Access Token 有效期

**登录防爆破（可在 系统 → 安全设置 中配置）：**
- 同一「用户名 + IP」在统计窗口内登录失败达到阈值后临时锁定，锁定期间直接返回 429
- 默认：5 分钟窗口内失败 5 次 → 锁定 15 分钟；阈值、窗口、时长均可由管理员在界面调整
- 用户不存在与密码错误同样计数，避免通过响应差异枚举用户名
- 安全设置页内置**锁定列表**：实时查看被锁定的「用户名 + IP」及剩余时长，支持搜索、单条/批量手动解除
- 锁定状态保存在内存中：服务重启即清零（不会出现重启后误锁）；多实例部署时各实例独立计数

---

## 🤖 Agent / mTLS 探针体系

一套基于内置 CA 与双向 TLS（mTLS）的分布式探针架构。NMS 本身只负责 Agent 的**注册引导、任务调度、结果存储与展示**；真正执行 ping/tcpping/httpcheck 等探测的独立 Agent 程序是单独的项目（`agent-skeleton/` 只是一份演示协议交互的参考骨架，不是生产可用的完整实现）。

### 架构总览

NMS 后端进程同时监听三个端口：

| 端口 | 配置项 | TLS 模式 | 用途 |
|------|--------|----------|------|
| `8080`（默认） | `server.port` | 普通 HTTP（一般由 Nginx 反代为 HTTPS） | 浏览器前端 JWT API（含 Agent 后台管理 CRUD） |
| `8443`（默认） | `agent_pki.enroll_port` | 单向 HTTPS（`tls.NoClientCert`） | `POST /api/v1/agents/enroll`、`GET /api/v1/agents/ca-cert` |
| `8444`（默认） | `agent_pki.sync_port` | 双向 mTLS（`tls.RequireAndVerifyClientCert`） | `/api/v1/agent-sync/*`（任务拉取/结果上报/证书续期） |

Go 的 `tls.Config.ClientAuth` 是按监听器全局生效的，无法在同一端口对不同路径区分"是否要求客户端证书"，因此 enroll 与 sync 必须分开监听；这两个端口需要 Agent 直连，不能走现有的 Nginx 反代。

### IPv4 / IPv6 双栈

Agent 体系全链路双栈，IPv4 与 IPv6 同等支持，不存在"主栈/备用栈"的区分：

- **监听**：`enroll_port`/`sync_port` 绑定地址留空主机部分（`:8443` 而非 `0.0.0.0:8443`），系统支持双栈套接字时会同时接受 IPv4 与 IPv6 连接；纯 IPv4 环境会自动回退，无需任何配置区分。
- **服务端证书 SAN**：`server_san` 列表里 IPv4/IPv6 字面地址与域名可以混填，签发时自动识别（`net.ParseIP`），按需要同时列出 Agent 会用到的两种地址（参见 `config.example.yaml` 注释示例）。
- **Source IP（出口绑定）**：`Agent.SourceIPOverride` 是不限制格式的字符串字段，管理端校验用 `netip.ParseAddr`，IPv4/IPv6 地址都接受；Agent 拨号时用 `net.Dialer.LocalAddr` 绑定，地址族必须与目标一致（用 IPv6 Source IP 探测纯 IPv4 目标必然失败，这是路由层面的限制，不是 bug）。
- **Probe Config 的 Target**：每行必须是合法的 IPv4 或 IPv6 地址（后端用 `netip.ParseAddr` 校验，非法格式直接拒绝），meshping 类型的 Target 由 Server 动态解析，不受此校验约束。
- **Agent 侧寻址 Server**：若把 NMS Server 的地址配置成裸 IPv6 字面量（如 `2001:db8::1`），构造 URL 时必须加方括号（`https://[2001:db8::1]:8443/...`）才是合法形式——`agent-skeleton` 已内置这一处理（见 `formatHost`），独立 Agent 项目实现时也需要同样处理，否则会拼出无法解析的 URL。

### 注册引导（Enrollment）

1. 管理员在前端 **Agent → Token** 页生成一次性注册码（可预设有效期、预设分组），明文只在生成时显示一次，数据库只持久化其 SHA-256 哈希。
2. Agent 调用 `POST /api/v1/agents/enroll`（单向 HTTPS）携带该注册码 + 自己的 hostname。
3. 后端用一条带条件的原子 UPDATE 校验并"认领"该 token（`WHERE status='unused' AND expires_at>now()`，检查 `RowsAffected`），杜绝并发请求重复消费同一个注册码；通过来源 IP 滑动窗口（10 分钟内 10 次失败 → 锁定 15 分钟）防止 token 被暴力枚举。
4. 后端分配全局唯一的 `AgentID`（如 `AGT-3F2A9B7C`），用内置 Root CA 签发 1 年期客户端证书（CN=AgentID），返回证书/私钥/CA 公钥给 Agent。
5. Agent 落地证书到本地文件，后续所有 `/agent-sync/*` 调用都用这张证书做 mTLS 双向认证——`PeerCertificates[0].Subject.CommonName` 即 AgentID，无需再传任何 Token。

### 任务调度与 MeshPing

Agent 定时调用 `GET /api/v1/agent-sync/tasks` 拉取当前生效任务（同一次调用本身就是心跳，会刷新该 Agent 的 `ConnectionIP`/`LastSeenAt`/`Status`，无需单独的心跳接口）。后端按三级规则组装任务：

- **Global**：下发给所有 Agent。
- **Group**：仅下发给指定分组内的 Agent。
- **Agent**：仅下发给指定的单个 Agent。

`meshping` 类型任务比较特殊：配置时填的 Target 会被忽略，后端动态查询同分组内其他"存活"（`LastSeenAt` 在 5 分钟阈值内、未被吊销）Agent 的 `ConnectionIP`，实时组装成 Target 列表下发——前端 **Probe Results → MeshPing** 页会把结果渲染成 NxN 交叉延迟矩阵（已知限制：矩阵按各 Agent *当前* `ConnectionIP` 反查历史结果归属的列，若该 IP 在两次探测之间发生变化，个别历史单元格可能短暂错位，这是协议只传 IP、不传 AgentID 的固有取舍）。

一台没有失联超过 5 分钟仍未刷新心跳的 Agent，会被后台扫描任务自动从 `online` 翻转为 `offline`（每分钟扫描一次），不需要等到管理员手动操作。

### 证书续期与 CA 轮换

- **续期**：证书快到期时，Agent 可直接调用 `POST /api/v1/agent-sync/renew-cert`（用现有仍有效的证书做 mTLS 认证）换发一张新证书，不需要重新申请注册码。`agent-skeleton` 默认在剩余有效期不足 30 天时自动触发。
- **CA 轮换**：管理员在 **Agent → Token** 页的 Root CA 面板可以「轮换 CA」——生成一份新 CA 并立即用于签发新证书，旧 CA 的公钥证书保留在磁盘（`data/pki/ca-previous.crt`），过渡期内仍被信任，旧证书的 Agent 不会被立刻断开。等所有 Agent 都续期到新 CA 后，再点「终结轮换」彻底停止信任旧 CA。
  **⚠️ 轮换/终结操作只落盘，必须重启 NMS 服务进程才会真正生效**——这是有意为之的设计：避免在一个正被并发 TLS 握手读取的信任池上做无锁热切换引入数据竞争，与本项目其他配置变更（端口、SAN 等）的生效方式保持一致。

### 健康监控

- **Agent → Agent List** 顶部展示健康汇总卡片（在线/离线/已吊销数量、近 1 小时探测次数与失败率），以及每台 Agent 自报的软件版本号（通过请求头 `X-Agent-Version`，可选）。
- **Probe Results** 下 ping/tcpping/httpcheck/mtr 四个 Tab 共用同一套组件：默认是按时间倒序的完整历史日志，支持按 Agent / 成功失败 / 时间范围 / 关键字组合过滤；打开「仅看最新」开关可切换为"每个 Agent+Target 只看最新一条"的当前状态快照视图。

---

## 🗂️ API 接口速查

### 认证接口（Base: `/api/v1/auth`）

`/login` 和 `/refresh` 无需 JWT，其余需要 Bearer Token。

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/login` | 登录，返回 access_token + refresh_token + expires_at + user |
| `POST` | `/refresh` | 用 Refresh Token 静默换取新 Token 对（Token 旋转） |
| `GET` | `/me` | 获取当前登录用户信息 |
| `POST` | `/change-password` | 自助改密（需提供旧密码），返回新 Token 对 |
| `PUT` | `/settings` | 更新当前用户的会话令牌有效期（1–720 小时） |

### IPAM 接口（Base: `/api/v1/ipam`，全部需要 JWT）

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/root-prefixes` | 创建根前缀（严格 CIDR 校验） |
| `GET` | `/root-prefixes` | 获取所有根前缀 |
| `PUT` | `/root-prefixes/:id` | 更新根前缀（仅 Group / Type） |
| `DELETE` | `/root-prefixes/:id` | 删除根前缀（事务级联清理所有子网） |
| `GET` | `/root-prefixes/:id/tree` | 获取 L1→L2 完整层级树 |
| `POST` | `/split` | 拆分/重新拆分子网 |
| `POST` | `/merge` | 合并子网（2ⁿ 校验 + Re-parenting） |

### Devices 接口（Base: `/api/v1/devices`，全部需要 JWT）

**设备**

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/` | 服务端分页查询设备（`?page=&page_size=&hostname=&ip=&ipv6=&status=&site_id=&pop_id=&role_id=&vendor_id=`），返回 `{total, items, page, page_size}` |
| `POST` | `/` | 创建设备（IPv4 / IPv6 至少填一项；Status 默认 active） |
| `PUT` | `/:id` | 更新设备（同上约束；IP/Hostname 重复返回友好提示） |
| `DELETE` | `/:id` | 删除设备（硬删除；审计日志保留） |

**站点 / PoP / 角色 / 厂商 / 审计日志**

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET/POST/PUT/DELETE` | `/sites`, `/pops`, `/roles`, `/vendors` | 各自的标准 CRUD（命名唯一性校验 + 关联设备外键置 NULL，不级联删设备） |
| `GET` | `/audit-logs` | 分页查询审计日志（`?page=&page_size=&username=&action=&resource_type=`） |
| `DELETE` | `/audit-logs` | 清理日志（`?days=N`，保留最近 N 天） |

### System 接口（Base: `/api/v1/system`，全部需要 JWT + 管理员权限）

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET/POST/PUT/DELETE` | `/users`, `/groups` | 用户 / 用户组 CRUD（不能删最后一个管理员/管理员组） |
| `GET` | `/settings/security` | 读取登录安全配置（防爆破阈值） |
| `PUT` | `/settings/security` | 更新登录安全配置 |
| `GET` | `/security/lockouts` | 锁定列表，服务端分页（`?page=&page_size=&q=`） |
| `POST` | `/security/lockouts/unlock` | 手动解除锁定（`{keys: [...]}`，支持单条/批量） |

### Agent 接口

**注册引导（Base: `/api/v1/agents`，独立 `enroll_port`，单向 HTTPS，无需任何认证）**

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/enroll` | `{provisioning_token, hostname}` → 分配 AgentID + 签发 1 年期客户端证书 |
| `GET` | `/ca-cert` | 获取 Root CA 公钥证书（PEM），供 Agent 首次引导建立信任 |

**任务同步（Base: `/api/v1/agent-sync`，独立 `sync_port`，强制 mTLS）**

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/tasks` | 拉取当前生效任务（全局/分组/专属 + MeshPing 动态解析），本次调用即心跳 |
| `POST` | `/results` | `{results: [...]}` 批量上报探测结果 |
| `POST` | `/renew-cert` | 用当前有效证书换发新证书，无需 provisioning token |

**管理 API（Base: `/api/v1/agents` 等，主 JWT 端口，需管理员权限）**

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/agents` | 服务端分页查询 Agent（`?page=&page_size=&q=&group_id=&status=`） |
| `GET` | `/agents/summary` | 健康汇总：在线/离线/已吊销数量 + 近 1 小时探测失败率 |
| `PUT` | `/agents/:agent_id` | 修改 Source IP / 归属 Group |
| `DELETE` | `/agents/:agent_id` | 删除 Agent 记录 |
| `POST` | `/agents/:agent_id/revoke` | 作废证书（保留历史数据，仅阻止后续 mTLS 调用） |
| `GET` | `/agents/ca-cert` | 同上，镜像在主 JWT 端口，便于浏览器端展示/下载 |
| `GET` | `/agents/ca/status` | 当前 CA 到期时间 + 是否有待终结的轮换 |
| `POST` | `/agents/ca/rotate` | 生成新 Root CA（需重启进程生效） |
| `POST` | `/agents/ca/finalize` | 终结轮换，停止信任旧 CA（需重启进程生效） |
| `GET/POST/PUT/DELETE` | `/agent-groups` | 分组 CRUD |
| `GET/POST/PUT/DELETE` | `/agent-tasks` | 任务下发配置 CRUD（POST 支持多选类型批量创建） |
| `GET/POST` | `/agent-tokens` | 注册码列表（分页）/ 生成（返回明文，仅此一次） |
| `POST` | `/agent-tokens/:id/revoke` | 作废未使用的注册码 |

**探测结果（Base: `/api/v1/probe-results`，主 JWT 端口，仅需登录）**

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/` | 分页历史查询（`?type=&q=&agent_id=&success=&start=&end=`） |
| `GET` | `/latest` | "当前状态"快照：每个 Agent+Target 只返回最新一条 |
| `GET` | `/meshping-matrix` | MeshPing 透视矩阵（`?group_id=&q=`） |

### 健康检查

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/health` | 存活 + 数据库连通性检测（无需认证）；DB 故障时返回 503 `{"status":"degraded"}` |

---

## 🧩 模块化架构

所有模块共享 `nms_db` 数据库，通过**表名前缀**隔离命名空间：

| 模块 | 表前缀 | 数据表 | 状态 |
|------|--------|--------|------|
| **IPAM** | `ipam_` | `ipam_root_prefixes`, `ipam_subnets`, `ipam_groups`, `ipam_types`, `ipam_vrfs`, `ipam_audit_logs` | ✅ 已完成 |
| **System** | `sys_` | `sys_groups`, `sys_users`, `sys_refresh_tokens`, `sys_settings` | ✅ 已完成 |
| **Devices** | `device_` | `device_sites`, `device_pops`, `device_roles`, `device_vendors`, `devices`, `device_audit_logs` | ✅ 已完成 |
| **Agent** | `agent_` | `agent_groups`, `agents`, `agent_tokens`, `agent_tasks`, `probe_results`, `agent_audit_logs` | ✅ 已完成 |
| 网络拓扑 | `topo_` | — | 🔜 规划中 |

### Devices 模块数据关系

```
DeviceSite (站点)
  └── DevicePoP (PoP 节点，复合唯一索引 site_id+name)
        └── Device (设备，IPv4/IPv6 管理地址，Status，Role，Vendor)
```

- **删除站点**：须先清除该站点下所有 PoP，否则拒绝（友好提示 PoP 数量）
- **删除 PoP**：关联设备的 `pop_id` 置 NULL，设备本身保留
- **PoP 迁站**：变更 PoP 的 `site_id` 时，数据库事务内同步更新所有属于该 PoP 的设备的 `site_id`
- **删除角色/厂商**：关联设备的外键置 NULL，设备本身保留

### Agent 模块数据关系

```
AgentGroup (分组，如 HKG/SIN/LAX)
  ├── Agent (探针，证书序列号/到期时间/SourceIP/在线状态)
  │     └── ProbeResult (探测结果，AgentID + Target + Type)
  └── AgentTask (任务配置：Type/Targets/Interval/Scope=global|group|agent)

AgentToken (一次性注册码，TokenHash + Status + ExpiresAt，可预设 Group)
```

- **删除分组**：组内 Agent / Task 的 `group_id` 置 NULL（退化为未分组），不级联删除
- **删除 Agent**：硬删除记录及其证书登记信息；如只是想阻止其继续连接而保留历史数据，应使用「作废证书」而非删除
- **Token 一次性**：`status` 在 `unused → used` 之间通过原子条件 UPDATE 转换，杜绝并发重复消费；`revoked` 仅适用于尚未使用的 Token

---

## 📄 License

MIT License © 2026
