# 🌐 NMS Enterprise System（网络管理系统）

企业级生产标准的**网络管理系统 (NMS)**，采用彻底的前后端分离与模块化架构。现已完成：

- ✅ **IPAM 模块**：IP 地址管理（IPv4 / IPv6 双栈，根前缀 CRUD + L1/L2 子网拆分/合并）
- ✅ **System 模块**：用户 & 用户组权限管理，JWT 认证，首次登录强制改密

---

## ✨ 核心特性

| 特性 | 说明 |
|------|------|
| 🔐 **JWT 认证** | Bearer Token 保护全部 API，24 小时有效期 |
| 🔒 **首次登录强制改密** | 默认账号 `admin/admin`，登录后必须立即修改，后端双重拦截 |
| 👥 **细粒度权限** | `admin` 组拥有完整管理权；其他组仅限自助改密 |
| 🛡️ **严格 CIDR 校验** | Go `net/netip` 深度拦截含主机位的非标准地址 |
| ⚡ **O(N) 树形重组** | 内存级一次遍历将扁平数据还原为 Root→L1→L2 嵌套树 |
| 🧩 **业务约束** | 严禁单独删除 L1/L2 子网；仅允许通过 Split/Merge 生成与重组 |
| 📦 **安全级联删除** | 删除根前缀时，同一事务 + FOR UPDATE 行锁彻底清理所有衍生子网 |
| 🪵 **生产级日志** | `slog + lumberjack` 结构化 JSON 日志，按大小/天数自动轮转 |
| 🧱 **模块化前缀** | `ipam_` / `sys_` 表前缀，安全共存于 `nms_db` 统一数据库 |

---

## 📋 前置环境依赖（本地开发）

| 依赖 | 版本 | 说明 |
|------|------|------|
| **Go** | ≥ 1.26 | 后端编译，本地开发需要 |
| **Node.js** | ≥ 22 LTS | 前端编译，npm 随附 |
| **MySQL** | ≥ 8.0 | 生产/开发数据库 |
| **Git** | 最新版 | 代码管理与 push |
| **Nginx** | ≥ 1.18 | 生产部署：前端静态托管 + API 反代 |

> 💡 **仅需发布不需本地调试时**：只需安装 Git，推送代码后 GitHub Actions 自动完成编译。

---

## 📂 完整目录结构

```text
NMS/
├── README.md
├── .github/
│   └── workflows/
│       └── release.yml            # CI：打 v* tag 自动编译并发布 Release
│
├── backend/                       # Go 后端
│   ├── go.mod / go.sum
│   ├── config.example.yaml        # 配置模板（部署时复制为 config.yaml）
│   ├── main.go                    # 服务入口：配置/DB/迁移/Seed/路由
│   ├── core/
│   │   └── ipam_calc.go           # 纯算法：CIDR 校验、拆分、合并
│   ├── models/
│   │   ├── ipam_models.go         # IPAM 数据模型（ipam_root_prefixes, ipam_subnets）
│   │   └── sys_models.go          # System 数据模型（sys_groups, sys_users）
│   ├── middleware/
│   │   └── auth.go                # JWT 认证中间件 + AdminRequired
│   └── controllers/
│       ├── ipam_api.go            # IPAM REST API（受 JWT 保护）
│       ├── auth_api.go            # 登录 / 改密 / 当前用户
│       ├── system_api.go          # 用户 & 用户组 CRUD（仅管理员）
│       └── seed.go                # 数据库初始化（幂等写入默认 admin）
│
└── frontend/                      # React + TypeScript 前端
    ├── package.json
    ├── vite.config.ts
    └── src/
        ├── api/
        │   ├── client.ts          # 共享 Axios 实例（自动携带 Token + 401 处理）
        │   ├── auth.ts            # 登录 / 改密 API
        │   ├── ipam.ts            # IPAM API
        │   └── system.ts          # 用户 / 用户组 API
        ├── types/
        │   ├── auth.ts            # AuthUser、LoginResp 等
        │   ├── ipam.ts            # RootPrefix、SubnetNode 等
        │   └── system.ts          # SysUser、SysGroup 等
        ├── contexts/
        │   └── AuthContext.tsx    # 全局认证状态（localStorage 持久化）
        ├── components/
        │   └── ChangePasswordModal.tsx  # 自愿/强制改密 Modal
        ├── layouts/
        │   └── MainLayout.tsx     # 侧边栏（含 System 菜单）+ 顶栏用户信息
        └── pages/
            ├── Login/             # 登录页
            ├── IPAM/              # IPAM 页面（Root Prefix + Subnet Tree）
            └── System/
                ├── User/          # 用户管理（管理员可见）
                └── Group/         # 用户组管理（管理员可见）
```

---

## 🚀 生产部署指南（Debian 12/13 · Ubuntu 24/26）

### 1. 准备 MySQL 数据库

```bash
# Debian / Ubuntu 通用安装
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
# 创建部署目录
sudo mkdir -p /opt/nms/backend && cd /opt/nms/backend
sudo chmod +x nms-server

# 复制配置模板并编辑
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

jwt:
  # ⚠️ 必须替换为随机字符串（至少 32 位），切勿泄露
  secret: "REPLACE_WITH_RANDOM_SECRET_AT_LEAST_32_CHARS"
  # Refresh Token 有效期（天）；Access Token 有效期由用户在"会话时长设置"中自定义（默认 24h）
  refresh_token_days: 7
```

> **服务首次启动会自动建表并写入默认账号 `admin/admin`（MustChangePassword=true）。**

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

### 4. 部署前端 + Nginx

```bash
# 安装 Nginx
sudo apt install -y nginx

# 解压前端静态包
sudo mkdir -p /var/www/nms
cd /var/www/nms
sudo tar -zxvf /path/to/dist.tar.gz   # 解压后产生 dist/ 目录
```

**步骤 A — HTTP 基础配置（可立即上线，无域名时使用 IP）：**

```bash
sudo tee /etc/nginx/sites-available/nms <<'EOF'
server {
    listen 80;
    server_name 你的服务器IP或域名;

    # 前端静态资源（支持 React Router 刷新不 404）
    location / {
        root /var/www/nms/dist;
        index index.html;
        try_files $uri $uri/ /index.html;
    }

    # API 反向代理
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

**步骤 B — 升级 HTTPS（推荐生产必选，需要已绑定域名）：**

```bash
# 1. 安装 Certbot
sudo apt install -y certbot python3-certbot-nginx

# 2. 自动获取 Let's Encrypt 证书并修改 Nginx 配置（替换 your-domain.com 为真实域名）
sudo certbot --nginx -d your-domain.com

# Certbot 会自动：
#   - 申请免费 TLS 证书
#   - 在 Nginx 配置中注入 ssl_certificate 等指令
#   - 添加 HTTP → HTTPS 301 重定向
#   - 配置 systemd timer 自动续期（可用 sudo systemctl status certbot.timer 确认）
```

升级后 Nginx 配置将类似：

```nginx
# HTTP → HTTPS 强制重定向
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$host$request_uri;
}

# HTTPS 主服务
server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate     /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;
    include             /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam         /etc/letsencrypt/ssl-dhparams.pem;

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
```

> 💡 **证书自动续期验证**：`sudo certbot renew --dry-run`
> 证书默认每 90 天自动更新一次，Certbot 安装时已通过 systemd timer 完成配置。

---

## 🛠️ 本地开发指南

### 后端

```bash
cd backend
go mod tidy
cp config.example.yaml config.yaml
# 编辑 config.yaml 填入本地数据库连接和 JWT secret
go run main.go        # 监听 :8080，自动建表+写入默认 admin
```

### 前端

```bash
cd frontend
npm install
npm run dev           # 监听 :5173，/api 请求自动代理到 :8080
```

访问 http://localhost:5173，使用 `admin` / `admin` 登录，首次登录会强制修改密码。

---

## 👤 用户与权限

| 角色 | 默认账号 | 权限 |
|------|---------|------|
| **管理员（admin 组）** | `admin` / `admin` | 查看全部内容；创建/编辑/删除所有用户；重置任意用户密码；管理用户组 |
| **普通用户（其他组）** | 由管理员创建 | 查看 IPAM 数据；仅可自助修改自己的密码（需提供旧密码） |

**首次登录流程：**
1. 用 `admin` / `admin` 登录 → 后端签发 `must_change_password=true` 的 Access Token + Refresh Token
2. 前端检测到标志 → 显示强制改密页面（无法跳过）
3. 输入旧密码 `admin` + 新密码（≥ 8 位）→ 修改成功
4. 后端签发新 Token 对（`must_change_password=false`）→ 自动进入系统

**Token 静默刷新机制：**
- **Access Token** 有效期：用户自定义（1-720 小时），默认 **24 小时**
- **Refresh Token** 有效期：服务器配置（`refresh_token_days`），默认 **7 天**
- 前端在 Access Token 过期前 **5 分钟**自动调用 `/auth/refresh`，无感知换取新 Token 对（Token 旋转）
- 用户可在右上角菜单 → **会话时长设置** 中调整 Access Token 有效期

---

## 🗂️ API 接口速查

**认证接口**（Base: `/api/v1/auth`；`/login` 和 `/refresh` 无需 JWT，其余需要）

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/login` | 登录，返回 access_token + refresh_token + expires_at + user |
| `POST` | `/refresh` | 用 Refresh Token 静默换取新 Token 对（Token 旋转） |
| `GET` | `/me` | 获取当前登录用户信息 |
| `POST` | `/change-password` | 自助改密（需提供旧密码），返回新 Token 对 |
| `PUT` | `/settings` | 更新当前用户的会话令牌有效期（1-720 小时） |

**IPAM 接口**（Base: `/api/v1/ipam`，全部需要 JWT）

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/root-prefixes` | 创建根前缀（严格 CIDR 校验） |
| `GET` | `/root-prefixes` | 获取所有根前缀 |
| `PUT` | `/root-prefixes/:id` | 更新根前缀（仅 Group / Type） |
| `DELETE` | `/root-prefixes/:id` | 删除根前缀（事务级联清理所有子网） |
| `GET` | `/root-prefixes/:id/tree` | 获取 L1→L2 完整层级树 |
| `POST` | `/split` | 拆分/重新拆分子网 |
| `POST` | `/merge` | 合并子网（2ⁿ 校验 + Re-parenting） |

**System 接口**（Base: `/api/v1/system`，全部需要 JWT + 管理员权限）

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/users` | 用户列表 |
| `POST` | `/users` | 创建用户（初始密码 + 首次强制改密） |
| `PUT` | `/users/:id` | 修改用户分组 / 重置密码 |
| `DELETE` | `/users/:id` | 删除用户（不能删最后一个管理员） |
| `GET` | `/groups` | 用户组列表 |
| `POST` | `/groups` | 创建用户组 |
| `PUT` | `/groups/:id` | 修改用户组（名称 / 权限） |
| `DELETE` | `/groups/:id` | 删除用户组（组内有用户时拒绝） |

**健康检查**

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/health` | 服务存活检测（无需认证） |

---

## 🧩 模块化架构

所有模块共享 `nms_db` 数据库，通过**表名前缀**隔离命名空间：

| 模块 | 表前缀 | 当前表 | 状态 |
|------|--------|--------|------|
| **IPAM** | `ipam_` | `ipam_root_prefixes`, `ipam_subnets` | ✅ 已完成 |
| **System** | `sys_` | `sys_groups`, `sys_users`, `sys_refresh_tokens` | ✅ 已完成 |
| 设备台账 | `device_` | — | 🔜 规划中 |
| 网络拓扑 | `topo_` | — | 🔜 规划中 |

---

## 📄 License

MIT License © 2026
