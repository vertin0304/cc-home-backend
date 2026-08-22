# CC Home Backend

## 聊天鉴权

浏览器调用 `POST /chat` 和 `GET /chat/history` 时，必须在
`Authorization: Bearer <access-token>` 中发送 Supabase Auth 用户 access token。
服务端通过 `supabase.auth.getUser(token)` 向 Supabase Auth 验证 token 和用户身份，
不会依据未验证的 JWT payload 授权。只有验证所得 `user.id` 与
`CHAT_ALLOWED_USER_ID` 完全一致时才允许访问；授权依据是 Supabase 用户 UUID，
不是邮箱字符串。

`CHAT_ACCESS_TOKEN` 是临时保留的服务端烟雾测试凭证，只能通过
`X-CC-Home-Internal-Token` 发送。它不能用于浏览器登录，也不得进入 Vite 环境变量、
前端源码、构建产物、浏览器存储、响应或日志。`Authorization` header 不接受该内部凭证，
从而避免它与用户 JWT 混淆。

第一版每个允许用户只有一个服务端主聊天。`POST /chat` 只接受 `{ "message": "..." }`，
`GET /chat/history` 不接受 session ID。服务端使用已验证的 `user.id` 查询或创建唯一
`sessions(user_id, session_kind = 'main')`，并把服务端生成的 `conversation_id` 作为
Gateway session。客户端提交 `sessionId` 会被拒绝，也不会收到服务端 conversation ID。

内部烟测使用 `CC_HOME_SMOKE_SESSION_ID`，不读取或保存 Supabase 用户消息；内部凭证不能
访问历史接口，因此烟测数据与用户主聊天完全隔离。

## 账号模型偏好

`GET /chat/models` 与 `PUT /chat/preferences/model` 只接受 Supabase 用户 JWT。前者只返回
`CC_HOME_ALLOWED_MODEL_ALIASES` 中、且 Haven `/models` 当前实际提供的安全公开别名；后者
只接受 `{ "model": "<公开别名>" }`。供应商 URL、密钥和真实上游模型名不会返回浏览器。
公开别名统一以 `cc-home-` 开头，服务端默认模型也必须使用这类 Haven 别名。

迁移 `migrations/20260823_add_chat_preferences.sql` 创建仅供 service role 使用的
`chat_preferences` 表。偏好按 Supabase `user_id` 保存，因此同一账号可跨浏览器和设备共享；
没有偏好、旧值已从允许列表移除或聊天时偏好读取暂时失败时，继续使用
`OMBRE_GATEWAY_MODEL`。`POST /chat` 仍只接受 `{ "message": "..." }`，客户端不能逐轮指定模型。

## 聊天历史

`GET /chat/history` 根据已验证用户解析主聊天，并复用 UUID 到 PostgreSQL bigint 的
确定性映射。接口只查询可见消息，限量后按时间正序返回：

```json
{
  "messages": [
    {
      "role": "user",
      "content": "你好",
      "createdAt": "2026-08-09T01:00:00.000Z"
    }
  ]
}
```

响应角色只包含 `user` 和 `assistant`，不会返回数据库 session ID 或其他内部字段。
前端刷新后应通过该接口恢复消息，不应把消息正文保存到 `localStorage`。

## 聊天诊断（第一阶段）

`POST /chat` 的每次请求都由后端生成随机 `request_id`。成功响应保留 `reply`，并增加
`request_id` 与脱敏 `diagnostics`；错误响应增加 `request_id`、`error_stage` 和
`error_code`，不返回原始上游错误、凭证、请求头、消息正文、提示词或记忆正文。

诊断记录鉴权、主会话、最近历史、Gateway 往返和消息保存的状态与毫秒耗时。Usage
只接受 Gateway 响应中实际存在的非负安全整数；缺失或无效字段为 `null`，服务端不估算、
不根据输入输出补算总 token，也不推测缓存命中。

迁移 `migrations/20260815_add_chat_requests.sql` 创建仅供 service role 使用的
`chat_requests` 表，并为成功 assistant 消息增加 nullable `messages.request_id`。
现有消息保持 `NULL`。`GET /chat/history` 会为能够安全关联的成功 assistant 消息附加
已有诊断；旧消息和旧客户端保持兼容。诊断保存或读取失败不会阻止聊天和历史正文返回。

必须先执行 additive migration，再部署读取 `messages.request_id` 的后端版本；本仓库不会
自动连接或修改线上 Supabase。

## 单用户限制

迁移 `migrations/20260809_add_owned_main_sessions.sql` 为 `sessions` 增加 nullable 的
`user_id`、`session_kind`、`conversation_id`。现有行三列保持 `NULL`，作为不可访问的
legacy 数据；迁移不会更新、删除、合并或回填旧 sessions/messages。只有已验证用户首次
访问时，应用才创建一条新的 owned main session。

将来支持多个聊天或多个授权用户时，仍需审查 messages 所有权和 RLS，不能允许任意
已登录用户凭 session ID 访问会话。

## 本地验证

测试通过依赖注入使用本地 Supabase Auth、数据库和 Gateway mock，不连接真实服务：

```sh
npm test
```
