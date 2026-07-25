# Project: cc-home-backend（后端）

## 简介
私人AI对话平台后端，负责调用大模型API、管理配置、连接Ombre Brain记忆库。

## 技术栈
- Node.js + Express
- Supabase（数据库）
- Ombre Brain MCP（记忆库，通过HTTP JSON-RPC调用）
- 部署在 Render

## 项目结构
- server.js — 唯一入口文件，包含所有路由和逻辑

## 核心接口
- GET /health — 健康检查
- POST /chat — AI对话（流式SSE）
- POST /models — 获取可用模型列表
- POST /admin/config — 更新AI配置（需token验证）
- GET /test-ombre — 测试记忆库连接

## 环境变量
- SUPABASE_URL / SUPABASE_KEY
- BASE_URL / API_KEY / MODEL_NAME（AI模型配置）
- OMBRE_BRAIN_URL（记忆库地址）
- ADMIN_TOKEN（管理员密码）

## 规范
- 保持单文件结构（暂不拆分）
- 不要修改环境变量的值
- 中文注释
- 错误处理要有 console.error 输出
