# 🌐 NMS Enterprise System（网络管理系统）

企业级生产标准的**网络管理系统 (NMS)**，采用彻底的前后端分离与模块化架构。现已完成：

- ✅ **IPAM 模块**：IP 地址管理（IPv4 / IPv6 双栈，根前缀 CRUD + L1/L2 子网拆分/合并）
- ✅ **System 模块**：用户 & 用户组权限管理，JWT 认证，首次登录强制改密
- ✅ **Devices 模块**：设备台账管理（Site → PoP → Device 三层结构，角色、厂商、全操作审计日志）

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
| 📋 **操作审计日志** | Devices 模块全部写操作自动记录，支持按操作者/动作/资源类型分页检索及按保留天数清理 |
| 🪵 **生产级日志** | `slog + lumberjack` 结构化 JSON 日志，按大小/天数自动轮转 |
| 🧱 **模块化前缀** | `ipam_` / `sys_` / `device_` 表前缀，安全共存于 `nms_db` 统一数据库 |

---

## 📋 前置环境依赖（本地开发）

| 依赖 | 版本 | 说明 |
|------|------|------|
| **Go** | ≥ 1.22 | 后端编译，本地开发需要 |
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
│       └── release.yml                # CI：打 v* tag 自动编译并发布 Release
│
├── backend/                           # Go 后端
│   ├── go.mod / go.sum
│   ├── config.example.yaml            # 配置模板（部署时复制为 config.yaml）
│   ├── main.go                        # 服务入口：配置/DB/迁移/Seed/路由
│   ├── core/
│   │   └── ipam_calc.go               # 纯算法：CIDR 校验、拆分、合并
│   ├── models/
│   │   ├── ipam_models.go             # IPAM 数据模型
│   │   ├── device_models.go           # Devices 数据模型（Site/PoP/Role/Vendor/Device/AuditLog）
│   │   └── sys_models.go              # System 数据模型（sys_groups, sys_users）
│   ├── middleware/
│   │   └── auth.go                    # JWT 认证中间件 + AdminRequired
│   └── controllers/
│       ├── ipam_api.go                # IPAM REST API（受 JWT 保护）
│       ├── device_api.go              # Devices REST API（Sites/PoPs/Roles/Vendors/Devices/Audit）
│       ├── auth_api.go                # 登录 / 改密 / 当前用户
│       ├── system_api.go              # 用户 & 用户组 CRUD（仅管理员）
│       └── seed.go                    # 数据库初始化（幂等写入默认 admin）
│
└── frontend/                          # React + TypeScript 前端
    ├── package.json
    ├── vite.config.ts
    └── src/
        ├── api/
        │   ├── client.ts              # 共享 Axios 实例（自动携带 Token + 401 处理）
        │   ├── auth.ts                # 登录 / 改密 API
        │   ├── ipam.ts                # IPAM API
        │   ├── device.ts              # Devices API
        │   └── system.ts              # 用户 / 用户组 API
        ├── types/
        │   ├── auth.ts                # AuthUser、LoginResp 等
        │   ├── ipam.ts                # RootPrefix、SubnetNode 等
        │   ├── device.ts              # DeviceSite、DevicePoP、Device 等
        │   └── system.ts              # SysUser、SysGroup 等
        ├── i18n/
        │   └── translations.ts        # 全局 EN/ZH 双语翻译键值（含 Devices 模块）
        ├── contexts/
        │   └── AuthContext.tsx        # 全局认证状态（localStorage 持久化）
        ├── components/
        │   └── ChangePasswordModal.tsx
        ├── layouts/
        │   └── MainLayout.tsx         # 侧边栏（含 Devices / System 菜单）+ 顶栏
        └── pages/
            ├── Login/
            ├── IPAM/
            ├── Devices/
            │   ├── index.tsx                  # 5 标签页容器（tab key 版本控制，切换强制刷新）
            │   └── components/
            │       ├── TabDeviceList.tsx       # 设备列表（服务端分页/筛选/CRUD Modal）
            │       ├── TabSites.tsx            # 站点表 + 内嵌 PoP 管理 Drawer
            │       ├── TabRoles.tsx            # 角色 CRUD
            │       ├── TabVendors.tsx          # 厂商 CRUD
            │       └── TabDeviceAuditLog.tsx   # 审计日志（分页/筛选/清理）
            └── System/
                ├── User/
                ├── Group/
                └── Settings/                   # 安全设置（Tab：防护配置 / 锁定列表）
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

# 审计日志保留（可省略，默认 180 天；0 = 永久保留）
audit:
  max_age_days: 180

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

> **服务首次启动会自动建表并写入默认账号 `admin/admin`（MustChangePassword=true）。**
>
> 日志按天轮转，文件名格式 `nms-server-2026-06-11.log`，历史文件自动压缩为 `.log.gz` 并按保留策略清理。

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

**步骤 B — 升级 HTTPS（推荐生产必选，需要已绑定域名）：**

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

Certbot 会自动申请 Let's Encrypt 证书、注入 SSL 配置并添加 HTTP → HTTPS 重定向。证书每 90 天自动续期（`sudo certbot renew --dry-run` 可验证）。

---

## 🛠️ 本地开发指南

### 后端

```bash
cd backend
go mod tidy
cp config.example.yaml config.yaml
# 编辑 config.yaml 填入本地数据库连接和 JWT secret
go run main.go        # 监听 :8080，自动建表 + 写入默认 admin
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
| **普通用户（其他组）** | 由管理员创建 | 查看 IPAM / Devices 数据；仅可自助修改自己的密码（需提供旧密码） |

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
| `GET` | `/` | 服务端分页查询设备（`?page=&page_size=&hostname=&ip=&ipv6=&status=&site_id=&pop_id=&role_id=&vendor_id=`，按 IP 数值排序，无 IP 设备置末），返回 `{total, items, page, page_size}` |
| `POST` | `/` | 创建设备（IPv4 / IPv6 至少填一项；Status 默认 active） |
| `PUT` | `/:id` | 更新设备（同上约束；IP/Hostname 重复返回友好提示） |
| `DELETE` | `/:id` | 删除设备（硬删除；审计日志保留） |

**站点（Sites）**

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/sites` | 获取全部站点（含 `pop_count` 字段，LEFT JOIN 聚合） |
| `POST` | `/sites` | 创建站点（名称全局唯一） |
| `PUT` | `/sites/:id` | 更新站点（名称重复返回友好提示） |
| `DELETE` | `/sites/:id` | 删除站点（站点下有 PoP 时拒绝，返回 PoP 数量提示） |

**PoP 节点（PoPs）**

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/pops` | 获取全部 PoP（可选 `?site_id=N` 过滤） |
| `POST` | `/pops` | 创建 PoP（名称在同 Site 内唯一，复合索引保护） |
| `PUT` | `/pops/:id` | 更新 PoP（变更 Site 时级联更新所有关联设备的 site_id） |
| `DELETE` | `/pops/:id` | 删除 PoP（关联设备的 pop_id 置 NULL，不删设备） |

**角色（Roles）**

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/roles` | 获取全部角色 |
| `POST` | `/roles` | 创建角色（名称全局唯一） |
| `PUT` | `/roles/:id` | 更新角色 |
| `DELETE` | `/roles/:id` | 删除角色（关联设备的 role_id 置 NULL） |

**厂商（Vendors）**

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/vendors` | 获取全部厂商 |
| `POST` | `/vendors` | 创建厂商（名称全局唯一） |
| `PUT` | `/vendors/:id` | 更新厂商 |
| `DELETE` | `/vendors/:id` | 删除厂商（关联设备的 vendor_id 置 NULL） |

**审计日志（Audit Log）**

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/audit-logs` | 分页查询审计日志（`?page=&page_size=&username=&action=&resource_type=`） |
| `DELETE` | `/audit-logs` | 清理日志（`?days=N`，保留最近 N 天，最小 1 天） |

### System 接口（Base: `/api/v1/system`，全部需要 JWT + 管理员权限）

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
| `GET` | `/settings/security` | 读取登录安全配置（防爆破阈值） |
| `PUT` | `/settings/security` | 更新登录安全配置（开关 / 失败次数 / 窗口 / 锁定时长） |
| `GET` | `/security/lockouts` | 锁定列表，服务端分页（`?page=&page_size=&q=`，q 模糊匹配用户名/IP），返回 `{total, items, page, page_size}` |
| `POST` | `/security/lockouts/unlock` | 手动解除锁定（`{keys: [...]}`，支持单条/批量） |

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

---

## 📄 License

MIT License © 2026
