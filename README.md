# tiny_agent_ts
本项目基于https://github.com/wp931120/tiny_agent 转写为typescript版的tiny_agent项目。
一个基于 TypeScript 的轻量级 Agent 项目，项目使用 `Express` 提供服务能力，并集成了 Agent 循环、上下文、记忆与工具加载等基础模块，便于后续扩展。
目前前端部分未完成。

## 项目结构

```text
tiny_agent_ts/
├─ backend/
│  ├─ src/
│  ├─ package.json
│  └─ tsconfig.json
├─ frontend/static/
└─ README.md
```

## 环境要求

- Node.js 18+（建议使用较新的 LTS 版本）
- npm（随 Node.js 安装）

## 安装依赖

在 `backend/` 目录执行：

```bash
npm install
```

## 启动方式

### 1. 开发模式（推荐）

支持热更新，适合本地开发调试：

```bash
cd backend
npm run dev
```

### 2. 生产模式

先编译再启动：

```bash
cd backend
npm run build
npm run start
```

