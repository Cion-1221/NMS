# 🌐 NMS IPAM Enterprise System (双栈 IP 地址管理系统)

本项目是 NMS (Network Management System) 的核心基石模块，提供企业级生产标准 IP 地址管理功能。完美支持 **IPv4 与 IPv6 双栈计算**，采用彻底的前后端分离架构设计。

## ✨ 核心特性
- 🔒 **严格标准化输入**：利用 Go 原生 `net/netip` 深度拦截不标准的含主机位网络地址输入。
- ⚡ **高性能树形重组**：后端的内存级 O(N) 一次性遍历，将扁平数据还原为顶级树。
- 🛡️ **安全的网段重组与合并**：支持从 L1 至 L2 级别的“覆盖拆分”，合并时自动执行严格的 2 次幂校验与 `Re-parenting` (节点智能重归属)。
- 🪵 **生产级基础实施**：内置 Viper 配置热加载与 `slog + lumberjack` 安全日志轮转。
- 🧩 **基座防御设计**：数据库表名自动添加 `ipam_` 前缀，连接统一采用 `nms_user` 和 `nms_db`，防止与其他 NMS 模块冲突。

---

## 📂 完整目录树结构

```text
NMS/
├── backend/                  # Go + Gin 后端
│   ├── config.example.yaml   # 配置模板文件
│   ├── core/                 # 纯 IP 计算逻辑 (拆分、合并、验证算法)
│   ├── models/               # GORM 模型与级联关系 (带防冲突前缀)
│   ├── controllers/          # 复杂路由与事务逻辑
│   ├── main.go               # 日志、DB、服务启动总入口
│   └── go.mod
│
└── frontend/                 # React + Vite 前端
    ├── src/
    │   ├── api/              # Axios 请求封装集合
    │   ├── types/            # Typescript 强类型契约
    │   ├── layouts/          # 全局骨架与侧边栏控制
    │   └── pages/
    │       └── IPAM/
    │           ├── components/
    │           │   ├── TabRootPrefix.tsx  # 根前缀管理与危险拦截 UI
    │           │   └── TabSubnetTree.tsx  # 树形动态计算、网段合并 UI
    │           └── index.tsx
    ├── package.json
    └── vite.config.ts        # 本地开发 Proxy 跨域配置
```

---

## 🚀 生产部署指南 (基于 Debian 13)

### 1. 准备 MySQL 数据库环境
```bash
sudo apt update
sudo apt install default-mysql-server -y
sudo systemctl enable --now mariadb

sudo mysql
```
```sql
CREATE DATABASE nms_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'nms_user'@'localhost' IDENTIFIED BY 'StrongPassword123!';
GRANT ALL PRIVILEGES ON nms_db.* TO 'nms_user'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```

### 2. 后端部署与后台常驻
```bash
cd backend
go build -o ipam-server main.go
cp config.example.yaml config.yaml
nano config.yaml 
nohup ./ipam-server > /dev/null 2>&1 &
```

### 3. 前端编译构建
```bash
cd frontend
npm install
npm run dev # 本地联调
npm run build # 生产构建打包到 dist/ 供 Nginx 托管
```
