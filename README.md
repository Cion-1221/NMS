# 🌐 NMS Enterprise System (网络管理系统 - IPAM 模块)

本项目是一个企业级生产标准的**网络管理系统 (NMS)**。现阶段已完成核心的 **IP 地址管理 (IPAM) 模块**，完美支持 **IPv4 与 IPv6 双栈计算**，采用彻底的前后端分离与模块化架构设计，便于未来横向扩展其他 NMS 业务组件（如设备台账、网络拓扑等）。

## ✨ 核心特性

- 🔒 **严格标准化输入**：利用 Go 原生 `net/netip` 深度拦截不标准的含主机位网络地址输入。
- ⚡ **高性能树形重组**：后端的内存级 O(N) 一次性遍历，将扁平数据高效还原为顶级嵌套树。
- 🛡️ **安全的网段重组与合并**：支持从 L1 至 L2 级别的"覆盖拆分"，合并时自动执行严格的 2 次幂相邻网段校验与 Re-parenting（节点智能重归属）。
- 🪵 **生产级基础设施**：内置 Viper 配置热加载与 `slog + lumberjack` 安全日志按大小/时间轮转切割。
- 🧩 **NMS 模块化防冲突**：所有 GORM 数据表均带 `ipam_` 模块前缀，数据库统一为 `nms_db`，安全共存于 NMS 大基座。

---

## 📋 前置环境依赖

在开始部署前，请确保目标主机已安装以下软件：

| 依赖 | 最低版本 | 说明 |
|------|---------|------|
| **Go** | ≥ 1.21 | 后端编译，需支持 `log/slog` 标准库 |
| **Node.js** | ≥ 18 LTS | 前端编译运行时 |
| **npm** | ≥ 9 | 前端包管理器（随 Node.js 一同安装） |
| **MySQL / MariaDB** | ≥ 8.0 / ≥ 10.5 | 生产数据库 |
| **Nginx** | ≥ 1.18 | 生产环境前端静态托管与反向代理（可选，开发环境不需要） |

---

## 📂 完整目录树结构

```text
NMS/
├── README.md                     # 本文档
│
├── backend/                      # Go + Gin + GORM 后端服务
│   ├── .gitignore                # Go 编译产物与敏感文件过滤
│   ├── go.mod                    # Go 模块声明 (module: ipam-backend)
│   ├── go.sum                    # 依赖校验锁定文件
│   ├── config.example.yaml       # 配置模板 (部署时 cp 为 config.yaml)
│   ├── main.go                   # 服务总入口：日志初始化、DB 连接、路由挂载
│   ├── core/                     # 核心算法层 (纯计算，零 IO 依赖)
│   │   └── ipam_calc.go          # CIDR 校验、子网拆分、合并算法
│   ├── models/                   # 数据模型层
│   │   └── ipam_models.go        # GORM 模型定义 (表名: ipam_root_prefixes, ipam_subnets)
│   └── controllers/              # 路由控制层
│       └── ipam_api.go           # RESTful API：CRUD、树形组装、拆分合并事务
│
└── frontend/                     # React + TypeScript + Vite 前端应用
    ├── .gitignore                # Node 依赖与构建产物过滤
    ├── package.json              # 依赖声明与脚本 (dev / build / preview)
    ├── vite.config.ts            # Vite 配置 (含 /api 开发代理)
    └── src/
        ├── api/                  # Axios 请求封装 (按模块隔离)
        │   └── ipam.ts           # IPAM 模块全部 API 调用
        ├── types/                # TypeScript 强类型契约
        │   └── ipam.ts           # RootPrefix、SubnetNode 等接口定义
        ├── layouts/              # 全局骨架布局
        │   └── MainLayout.tsx    # 侧边栏 + 顶栏 + 内容区骨架
        └── pages/                # 业务页面视图
            └── IPAM/             # IPAM 独立业务包
                ├── index.tsx     # IPAM 页面入口 (Tab 切换容器)
                └── components/
                    ├── TabRootPrefix.tsx   # Tab1: 根前缀 CRUD 与防呆拦截
                    └── TabSubnetTree.tsx   # Tab2: 树形网段拆分 / 合并交互
```

---

## 🚀 生产部署指南 (基于 Debian 13)

### 1. 准备 MySQL 数据库环境

连接您的 Debian 13 云主机，执行以下 CLI 命令安装并初始化 NMS 统一数据库：

```bash
sudo apt update
sudo apt install default-mysql-server -y
sudo systemctl enable --now mariadb

# 登录本地数据库执行授权
sudo mysql
```

进入 MySQL 终端后执行以下 SQL：

```sql
-- 创建 NMS 统一数据库 (所有模块共享此库)
CREATE DATABASE nms_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 创建 NMS 专用服务账号
CREATE USER 'nms_user'@'localhost' IDENTIFIED BY 'StrongPassword123!';
GRANT ALL PRIVILEGES ON nms_db.* TO 'nms_user'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```

> ⚠️ **安全提醒**：请务必将 `StrongPassword123!` 替换为您自己的强密码，并妥善保存。

---

### 2. 后端部署 (Backend)

```bash
cd backend

# 1. 下载 Go 依赖
go mod tidy

# 2. 编译为独立二进制文件
go build -o nms-server .

# 3. 准备配置文件 (基于模板创建)
cp config.example.yaml config.yaml
nano config.yaml
# ↑ 修改 database 下的 password 为您的实际数据库密码
```

**`config.yaml` 配置项说明：**

```yaml
server:
  port: 8080              # 后端 HTTP 监听端口

database:
  host: "127.0.0.1"       # 数据库地址
  port: 3306              # MySQL 端口
  user: "nms_user"        # 数据库用户名
  password: "YourPassword" # ← 替换为真实密码
  dbname: "nms_db"         # NMS 统一数据库名
```

**启动服务：**

```bash
# 方式 A：nohup 简易后台 (适合测试)
nohup ./nms-server > /dev/null 2>&1 &

# 方式 B：systemd 服务常驻 (推荐生产使用，见下方)
```

> 💡 **日志说明**：服务启动后，结构化 JSON 日志将自动写入 `logs/ipam.log`，按 **10MB 大小** 自动切割，保留 **5 个备份**，最长 **7 天**，确保磁盘安全。

---

### 3. 前端编译构建 (Frontend)

```bash
cd frontend

# 1. 安装依赖
npm install

# 2A. 本地联调开发 (热更新，自动代理 /api → 后端 8080)
npm run dev
# → 浏览器访问 http://localhost:5173

# 2B. 生产上线打包
npm run build
# → 产物输出到 dist/ 目录，交由 Nginx 托管
```

---

### 4. Nginx 生产配置 (前端静态托管 + API 反向代理)

将构建出的 `dist/` 目录部署到服务器后，创建以下 Nginx 站点配置：

```bash
sudo nano /etc/nginx/sites-available/nms
```

```nginx
server {
    listen 80;
    server_name your-domain.com;  # ← 替换为您的域名或 IP

    # 前端静态文件托管
    root /var/www/nms/dist;
    index index.html;

    # SPA 路由回退：所有前端路由交给 index.html 处理
    location / {
        try_files $uri $uri/ /index.html;
    }

    # API 反向代理：将 /api 请求转发到 Go 后端
    location /api/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
# 启用站点并重载 Nginx
sudo ln -s /etc/nginx/sites-available/nms /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

---

### 5. Systemd 服务文件 (推荐生产常驻方式)

创建一个 systemd service 单元，让 `nms-server` 开机自启、崩溃自动重启：

```bash
sudo nano /etc/systemd/system/nms-backend.service
```

```ini
[Unit]
Description=NMS Backend Server (IPAM Module)
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
```

```bash
# 启用并启动服务
sudo systemctl daemon-reload
sudo systemctl enable --now nms-backend

# 查看服务状态
sudo systemctl status nms-backend

# 查看实时日志
sudo journalctl -u nms-backend -f
```

> 💡 **路径提示**：请将 `WorkingDirectory` 和 `ExecStart` 中的路径替换为您服务器上的实际部署路径。`config.yaml` 必须位于 `WorkingDirectory` 同级目录中。

---

## 🌐 前端本地开发跨域代理 (Proxy)

开发时由于前后端端口不同（前端 `5173` / 后端 `8080`），Vite 会将 `/api` 的请求透明代理到后端，实现**零 CORS 侵入**的完美联调。

`vite.config.ts` 核心配置：

```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8080',
        changeOrigin: true
      }
    }
  }
})
```

---

## 🗂️ API 接口速查表

所有接口前缀：`/api/v1/ipam`

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/root-prefixes` | 创建根前缀（含 CIDR 严格校验） |
| `GET` | `/root-prefixes` | 获取全部根前缀列表 |
| `PUT` | `/root-prefixes/:id` | 更新根前缀（仅允许修改 Group、Type） |
| `DELETE` | `/root-prefixes/:id` | 删除根前缀（级联删除所有子网） |
| `GET` | `/subnet-tree/:root_prefix_id` | 获取指定根前缀下的完整层级树 |
| `POST` | `/subnets/split` | 拆分/重新拆分子网（支持 L1→L2、L2→L2） |
| `POST` | `/subnets/merge` | 合并相邻子网（含 2 次幂校验 + Re-parenting） |

---

## 🧩 模块化架构说明

本项目采用 **NMS 统一基座** 设计理念，所有模块共享 `nms_db` 数据库，通过**表名前缀**隔离命名空间：

| 模块 | 表前缀 | 当前表名 | 状态 |
|------|--------|---------|------|
| **IPAM** | `ipam_` | `ipam_root_prefixes`, `ipam_subnets` | ✅ 已完成 |
| 设备台账 | `device_` | — | 🔜 规划中 |
| 网络拓扑 | `topo_` | — | 🔜 规划中 |

新增模块时，只需遵循相同的 `模块名_` 表前缀约定，即可安全共存，无任何冲突风险。

---

## 📄 License

MIT License © 2026
