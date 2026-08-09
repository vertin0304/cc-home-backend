require('dotenv').config();

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const net = require('net');
const { createClient } = require('@supabase/supabase-js');

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function secureTokenEquals(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string') return false;
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  return candidateBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(candidateBuffer, expectedBuffer);
}

function isPrivateHostname(hostname) {
  const normalized = hostname.toLowerCase();
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true;

  const ipVersion = net.isIP(normalized);
  if (ipVersion === 4) {
    const parts = normalized.split('.').map(Number);
    return parts[0] === 10
      || parts[0] === 127
      || (parts[0] === 169 && parts[1] === 254)
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168);
  }
  if (ipVersion === 6) {
    return normalized === '::1'
      || normalized.startsWith('fc')
      || normalized.startsWith('fd')
      || normalized.startsWith('fe8')
      || normalized.startsWith('fe9')
      || normalized.startsWith('fea')
      || normalized.startsWith('feb');
  }
  return false;
}

// ---------- Gateway 地址验证 ----------
function validateGatewayBaseUrl(value, isProduction = false) {
  if (typeof value !== 'string' || !value.trim()) {
    return { valid: false, error: 'Gateway 地址未配置' };
  }

  try {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol)
      || url.username
      || url.password
      || url.search
      || url.hash
    ) {
      return { valid: false, error: 'Gateway 地址格式无效' };
    }
    if (isProduction && (url.protocol !== 'https:' || isPrivateHostname(url.hostname))) {
      return { valid: false, error: '生产环境只允许公开的 HTTPS Gateway 地址' };
    }
    return { valid: true, url };
  } catch {
    return { valid: false, error: 'Gateway 地址格式无效' };
  }
}

function normalizeSessionId(value, fallback) {
  let candidate = value;
  if (candidate === undefined || candidate === null || candidate === '') {
    candidate = fallback;
  }
  if (typeof candidate !== 'string' && typeof candidate !== 'number') {
    return null;
  }

  const normalized = String(candidate).trim();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(normalized)) {
    return null;
  }
  return normalized;
}

function isUuid(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

// PostgreSQL bigint 的正数高位区间用于字符串 session 的确定性映射。
// 以十进制字符串交给 PostgREST，避免 JavaScript Number 丢失 64 位整数精度。
const POSTGRES_BIGINT_MAX = 9_223_372_036_854_775_807n;
const HASHED_SESSION_ID_BASE = 1n << 62n;
const HASHED_SESSION_ID_MASK = HASHED_SESSION_ID_BASE - 1n;

function toSupabaseSessionId(sessionId) {
  const normalized = String(sessionId);

  // 兼容数据库中已经存在的纯数字 bigint session ID，并去掉无意义的前导零。
  if (/^\d+$/.test(normalized)) {
    const numericId = BigInt(normalized);
    if (numericId <= POSTGRES_BIGINT_MAX) {
      return numericId.toString();
    }
  }

  // 域分隔字符串固定为 v1；修改它会破坏已有字符串 session 的映射连续性。
  const digest = crypto
    .createHash('sha256')
    .update('cc-home:supabase-session:v1\0', 'utf8')
    .update(normalized, 'utf8')
    .digest();
  const hashPrefix = digest.readBigUInt64BE(0);
  return (HASHED_SESSION_ID_BASE + (hashPrefix & HASHED_SESSION_ID_MASK)).toString();
}

function normalizeHistory(history) {
  const roleMap = {
    user: 'user',
    ai: 'assistant',
    assistant: 'assistant'
  };

  return (Array.isArray(history) ? history : [])
    .slice()
    .reverse()
    .filter(item => item && roleMap[item.role] && typeof item.content === 'string')
    .map(item => ({ role: roleMap[item.role], content: item.content }));
}

function normalizeClientHistory(history) {
  const roleMap = {
    user: 'user',
    ai: 'assistant',
    assistant: 'assistant'
  };

  return (Array.isArray(history) ? history : [])
    .slice()
    .reverse()
    .filter(item => item && roleMap[item.role] && typeof item.content === 'string')
    .map(item => ({
      role: roleMap[item.role],
      content: item.content,
      createdAt: typeof item.created_at === 'string' ? item.created_at : null
    }));
}

function createApp(options = {}) {
  const env = options.env || process.env;
  const isProduction = env.NODE_ENV === 'production';
  const gatewayFetch = options.gatewayFetch || global.fetch;
  const supabase = options.supabaseClient || createClient(
    env.SUPABASE_URL,
    env.SUPABASE_KEY
  );
  const supabaseAuth = options.supabaseAuth || supabase.auth;
  const randomUUID = options.randomUUID || crypto.randomUUID;

  if (typeof gatewayFetch !== 'function') {
    throw new Error('当前 Node.js 环境不支持 fetch');
  }

  const app = express();
  app.set('trust proxy', 1);

  // ---------- CORS 与请求体限制 ----------
  const configuredOrigins = (env.FRONTEND_ORIGIN || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean);
  const developmentOrigins = [
    'http://localhost:3000',
    'http://localhost:4173',
    'http://localhost:5173',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:4173',
    'http://127.0.0.1:5173'
  ];
  const allowedOrigins = new Set([
    ...configuredOrigins,
    ...(isProduction ? [] : developmentOrigins)
  ]);

  app.use(cors({
    origin(origin, callback) {
      // 无 Origin 的服务端请求仍由接口自身鉴权。
      if (!origin || allowedOrigins.has(origin)) {
        return callback(null, true);
      }
      const error = new Error('不允许的跨域来源');
      error.code = 'CORS_NOT_ALLOWED';
      return callback(error);
    }
  }));
  app.use(express.json({ limit: '64kb' }));

  // ---------- 管理员验证 ----------
  function requireAdmin(req, res, next) {
    const adminToken = env.ADMIN_TOKEN;
    if (!adminToken) {
      console.error('管理员接口不可用：未配置 ADMIN_TOKEN');
      return res.status(503).json({ error: '管理员功能未配置' });
    }

    const authorization = req.get('authorization') || '';
    const bearerToken = authorization.startsWith('Bearer ')
      ? authorization.slice(7).trim()
      : '';
    const candidate = bearerToken || req.get('x-admin-token');

    if (!secureTokenEquals(candidate, adminToken)) {
      return res.status(401).json({ error: '管理员验证失败' });
    }
    return next();
  }

  // ---------- 聊天访问验证 ----------
  async function requireChatAccess(req, res, next) {
    // 长期内部烟测凭证使用独立 header，绝不与浏览器 Supabase JWT 混用。
    const internalCandidate = req.get('x-cc-home-internal-token') || '';
    if (internalCandidate) {
      const chatAccessToken = env.CHAT_ACCESS_TOKEN;
      if (!chatAccessToken) {
        console.error('内部聊天烟测不可用：未配置 CHAT_ACCESS_TOKEN');
        return res.status(503).json({ error: '内部聊天烟测未配置' });
      }
      if (!secureTokenEquals(internalCandidate, chatAccessToken)) {
        return res.status(401).json({ error: '聊天访问验证失败' });
      }
      req.chatPrincipal = { type: 'internal' };
      return next();
    }

    // Authorization 仅接受 Supabase Auth 签发的用户 access token。
    const authorization = req.get('authorization') || '';
    const bearerToken = authorization.startsWith('Bearer ')
      ? authorization.slice(7).trim()
      : '';
    if (!bearerToken) {
      return res.status(401).json({ error: '聊天访问验证失败' });
    }

    const allowedUserId = typeof env.CHAT_ALLOWED_USER_ID === 'string'
      ? env.CHAT_ALLOWED_USER_ID.trim()
      : '';
    if (!allowedUserId) {
      console.error('聊天接口不可用：未配置 CHAT_ALLOWED_USER_ID');
      return res.status(503).json({ error: '聊天访问功能未配置' });
    }
    if (!supabaseAuth || typeof supabaseAuth.getUser !== 'function') {
      console.error('聊天接口不可用：Supabase Auth 客户端未配置');
      return res.status(503).json({ error: '聊天访问功能未配置' });
    }

    try {
      // getUser 会向 Supabase Auth 验证 token；不能用仅解码 JWT 的结果授权。
      const { data, error } = await supabaseAuth.getUser(bearerToken);
      const userId = data?.user?.id;
      if (error || typeof userId !== 'string' || !userId) {
        return res.status(401).json({ error: '聊天访问验证失败' });
      }
      if (userId !== allowedUserId) {
        return res.status(403).json({ error: '无权访问聊天功能' });
      }

      req.chatPrincipal = { type: 'user', userId };
      return next();
    } catch {
      return res.status(401).json({ error: '聊天访问验证失败' });
    }
  }

  // ---------- /chat 基础频率限制 ----------
  const chatRateLimitWindowMs = positiveInteger(env.CHAT_RATE_LIMIT_WINDOW_MS, 60_000);
  const chatRateLimitMax = positiveInteger(env.CHAT_RATE_LIMIT_MAX, 20);
  const chatMaxMessageLength = positiveInteger(env.CHAT_MAX_MESSAGE_LENGTH, 4_000);
  const chatHistoryMaxMessages = Math.min(
    positiveInteger(env.CHAT_HISTORY_MAX_MESSAGES, 100),
    200
  );
  const chatRateLimits = new Map();

  function chatRateLimit(req, res, next) {
    const now = Date.now();
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    let entry = chatRateLimits.get(key);

    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + chatRateLimitWindowMs };
    }
    entry.count += 1;
    chatRateLimits.set(key, entry);

    if (chatRateLimits.size > 10_000) {
      for (const [storedKey, storedEntry] of chatRateLimits) {
        if (now >= storedEntry.resetAt) chatRateLimits.delete(storedKey);
      }
    }

    res.set('RateLimit-Limit', String(chatRateLimitMax));
    res.set('RateLimit-Remaining', String(Math.max(0, chatRateLimitMax - entry.count)));
    res.set('RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > chatRateLimitMax) {
      res.set('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
      return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
    }
    return next();
  }

  function gatewayConnectionConfig() {
    const validation = validateGatewayBaseUrl(env.OMBRE_GATEWAY_BASE_URL, isProduction);
    if (!validation.valid) {
      const error = new Error(validation.error);
      error.code = 'GATEWAY_CONFIG_ERROR';
      throw error;
    }
    if (typeof env.OMBRE_GATEWAY_TOKEN !== 'string' || !env.OMBRE_GATEWAY_TOKEN.trim()) {
      const error = new Error('Gateway token 未配置');
      error.code = 'GATEWAY_CONFIG_ERROR';
      throw error;
    }
    return {
      baseUrl: validation.url.toString().replace(/\/+$/, ''),
      token: env.OMBRE_GATEWAY_TOKEN.trim(),
      timeoutMs: positiveInteger(env.OMBRE_GATEWAY_TIMEOUT_MS, 30_000)
    };
  }

  function gatewayChatConfig() {
    const config = gatewayConnectionConfig();
    if (typeof env.OMBRE_GATEWAY_MODEL !== 'string' || !env.OMBRE_GATEWAY_MODEL.trim()) {
      const error = new Error('Gateway 模型未配置');
      error.code = 'GATEWAY_CONFIG_ERROR';
      throw error;
    }
    return { ...config, model: env.OMBRE_GATEWAY_MODEL.trim() };
  }

  function normalizeMainSessionRow(row, expectedUserId) {
    if (
      !row
      || String(row.user_id) !== expectedUserId
      || row.session_kind !== 'main'
      || !isUuid(row.conversation_id)
    ) {
      return null;
    }
    return {
      // 不读取 PostgREST 返回的 bigint，避免 JSON Number 导致 64 位精度丢失。
      databaseId: toSupabaseSessionId(row.conversation_id),
      gatewaySessionId: row.conversation_id,
      persist: true
    };
  }

  async function findMainSession(userId) {
    const { data, error } = await supabase
      .from('sessions')
      .select('user_id, session_kind, conversation_id')
      .eq('user_id', userId)
      .eq('session_kind', 'main')
      .maybeSingle();

    if (error) {
      const queryError = new Error('主聊天查询失败');
      queryError.code = 'MAIN_SESSION_ERROR';
      throw queryError;
    }
    if (!data) return null;

    const session = normalizeMainSessionRow(data, userId);
    if (!session) {
      const shapeError = new Error('主聊天记录格式无效');
      shapeError.code = 'MAIN_SESSION_ERROR';
      throw shapeError;
    }
    return session;
  }

  async function resolveMainSession(userId) {
    const existing = await findMainSession(userId);
    if (existing) return existing;

    // 唯一索引负责并发收敛；冲突后重新读取胜出的同一 main session。
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const conversationId = randomUUID();
      if (!isUuid(conversationId)) {
        const randomError = new Error('主聊天 UUID 生成失败');
        randomError.code = 'MAIN_SESSION_ERROR';
        throw randomError;
      }
      const databaseId = toSupabaseSessionId(conversationId);
      const { error } = await supabase.from('sessions').insert({
        id: databaseId,
        name: '主聊天',
        user_id: userId,
        session_kind: 'main',
        conversation_id: conversationId
      });

      const resolved = await findMainSession(userId);
      if (resolved) return resolved;
      if (!error || error.code !== '23505') break;
    }

    const createError = new Error('主聊天创建失败');
    createError.code = 'MAIN_SESSION_ERROR';
    throw createError;
  }

  async function resolveRequestSession(req) {
    if (req.chatPrincipal?.type === 'internal') {
      const gatewaySessionId = normalizeSessionId(
        env.CC_HOME_SMOKE_SESSION_ID || 'cc-home-smoke',
        null
      );
      if (
        !gatewaySessionId
        || !/^cc-home-smoke(?:[:._-][A-Za-z0-9._:-]+)?$/.test(gatewaySessionId)
      ) {
        const smokeError = new Error('内部烟测 session 配置无效');
        smokeError.code = 'MAIN_SESSION_ERROR';
        throw smokeError;
      }
      return { databaseId: null, gatewaySessionId, persist: false };
    }

    const userId = req.chatPrincipal?.userId;
    if (!isUuid(userId)) {
      const principalError = new Error('用户身份格式无效');
      principalError.code = 'MAIN_SESSION_ERROR';
      throw principalError;
    }
    return resolveMainSession(userId);
  }

  async function requestGateway(path, requestOptions = {}) {
    const config = gatewayConnectionConfig();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);

    try {
      return await gatewayFetch(`${config.baseUrl}${path}`, {
        ...requestOptions,
        headers: {
          Authorization: `Bearer ${config.token}`,
          ...(requestOptions.headers || {})
        },
        redirect: 'error',
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // ---------- 被动健康检查 ----------
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', message: 'cc-home 后端运行中（Gateway 模式）' });
  });

  // ---------- 测试数据库连接（仅管理员，不返回数据） ----------
  app.get('/test-db', requireAdmin, async (req, res) => {
    try {
      const { error } = await supabase
        .from('messages')
        .select('session_id', { head: true, count: 'exact' })
        .limit(1);
      if (error) throw error;
      return res.json({ connected: true });
    } catch (error) {
      console.error('数据库连接测试失败:', error.message);
      return res.status(503).json({ connected: false });
    }
  });

  async function testGatewayConnection(req, res) {
    try {
      const response = await requestGateway('/models', { method: 'GET' });
      if (!response.ok) {
        console.error('Gateway 连接测试失败:', { status: response.status });
        return res.status(503).json({ connected: false });
      }
      return res.json({ connected: true });
    } catch (error) {
      console.error('Gateway 连接测试失败:', error.message);
      return res.status(503).json({ connected: false });
    }
  }

  // 保留旧路径作为兼容别名，但不再调用 Ombre MCP 或读取记忆。
  app.get('/test-ombre', requireAdmin, testGatewayConnection);
  app.get('/test-gateway', requireAdmin, testGatewayConnection);

  // ---------- 获取 Gateway 模型列表（仅管理员，不接收客户端密钥） ----------
  app.post('/models', requireAdmin, async (req, res) => {
    if (req.body?.base_url !== undefined || req.body?.api_key !== undefined) {
      return res.status(400).json({ error: '不再接受客户端 Gateway 地址或密钥' });
    }

    try {
      const response = await requestGateway('/models', { method: 'GET' });
      if (!response.ok) {
        console.error('获取 Gateway 模型列表失败:', { status: response.status });
        return res.status(502).json({ success: false, error: '无法获取模型列表' });
      }
      const data = await response.json();
      const models = Array.isArray(data?.data)
        ? data.data.map(item => item?.id).filter(Boolean)
        : [];
      return res.json({ success: true, models });
    } catch (error) {
      console.error('获取 Gateway 模型列表失败:', error.message);
      return res.status(error.code === 'GATEWAY_CONFIG_ERROR' ? 503 : 502).json({
        success: false,
        error: '无法获取模型列表'
      });
    }
  });

  // ---------- AI 配置只允许通过部署环境管理 ----------
  app.post('/admin/config', requireAdmin, (req, res) => {
    return res.status(410).json({
      success: false,
      error: 'AI 配置已改为仅通过服务端环境变量管理'
    });
  });

  // ---------- 聊天历史：只按已验证用户解析 owned main session ----------
  // 客户端不能选择 session；三列所有权元数据均为 NULL 的 legacy 行永不参与查询。
  app.get('/chat/history', chatRateLimit, requireChatAccess, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.chatPrincipal?.type !== 'user') {
      return res.status(403).json({ error: '内部烟测不能读取用户聊天历史' });
    }
    if (req.query.sessionId !== undefined) {
      return res.status(400).json({ error: '客户端不能指定主聊天 sessionId' });
    }

    try {
      const session = await resolveRequestSession(req);
      const { data, error } = await supabase
        .from('messages')
        .select('role, content, created_at')
        .eq('session_id', session.databaseId)
        .eq('visible', true)
        // 同一次批量 insert 的 created_at 可能相同；用自增 id 稳定选取最近消息。
        .order('id', { ascending: false })
        .limit(chatHistoryMaxMessages);

      if (error) {
        console.error('加载聊天历史失败');
        return res.status(503).json({ error: '聊天记录暂时不可用' });
      }
      return res.json({ messages: normalizeClientHistory(data) });
    } catch (error) {
      if (error.code === 'MAIN_SESSION_ERROR') {
        console.error('解析主聊天失败');
      } else {
        console.error('加载聊天历史失败');
      }
      return res.status(503).json({ error: '聊天记录暂时不可用' });
    }
  });

  // ---------- 对话接口：CC Home → Haven-Ombre Gateway ----------
  app.post('/chat', chatRateLimit, requireChatAccess, async (req, res) => {
    const { message, sessionId } = req.body || {};
    if (sessionId !== undefined) {
      return res.status(400).json({ error: '客户端不能指定主聊天 sessionId' });
    }
    if (typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: '消息内容不能为空' });
    }
    if (message.length > chatMaxMessageLength) {
      return res.status(413).json({
        error: `消息内容不能超过 ${chatMaxMessageLength} 个字符`
      });
    }

    try {
      const config = gatewayChatConfig();
      const session = await resolveRequestSession(req);

      // Supabase 仅保存 CC Home 界面历史；按自增 id 取最近 20 条后恢复正序。
      const { data: history, error: historyError } = session.persist
        ? await supabase
          .from('messages')
          .select('role, content')
          .eq('session_id', session.databaseId)
          .eq('visible', true)
          .order('id', { ascending: false })
          .limit(20)
        : { data: [], error: null };

      if (historyError) {
        console.error('加载历史消息失败');
      }

      const messages = [
        ...normalizeHistory(historyError ? [] : history),
        { role: 'user', content: message }
      ];

      const response = await requestGateway('/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Ombre-Session-Id': session.gatewaySessionId
        },
        body: JSON.stringify({
          model: config.model,
          messages,
          temperature: 0.7,
          max_tokens: 1000,
          stream: false
        })
      });

      if (!response.ok) {
        console.error('Gateway 对话请求失败:', { status: response.status });
        return res.status(502).json({
          error: '上游服务暂时不可用',
          reply: '抱歉，我现在有点不在状态，请稍后再试试。'
        });
      }

      const data = await response.json();
      const reply = data?.choices?.[0]?.message?.content;
      if (typeof reply !== 'string' || !reply.trim()) {
        console.error('Gateway 返回格式无效');
        return res.status(502).json({
          error: '上游服务返回无效',
          reply: '抱歉，我现在有点不在状态，请稍后再试试。'
        });
      }

      if (session.persist) {
        try {
          const { error: saveError } = await supabase.from('messages').insert([
            { session_id: session.databaseId, role: 'user', content: message },
            { session_id: session.databaseId, role: 'ai', content: reply }
          ]);
          if (saveError) {
            console.error('保存消息失败');
          }
        } catch {
          console.error('保存消息失败');
        }
      }

      return res.json({ reply });
    } catch (error) {
      if (error.name === 'AbortError') {
        console.error('/chat Gateway 请求超时');
        return res.status(504).json({
          error: '上游服务响应超时',
          reply: '抱歉，回复等得有点久，请稍后再试试。'
        });
      }

      if (error.code === 'GATEWAY_CONFIG_ERROR') {
        console.error('/chat Gateway 配置错误:', error.message);
        return res.status(503).json({
          error: '对话服务尚未配置',
          reply: '抱歉，对话服务暂时不可用。'
        });
      }

      if (error.code === 'MAIN_SESSION_ERROR') {
        console.error('解析主聊天失败');
        return res.status(503).json({
          error: '聊天记录暂时不可用',
          reply: '抱歉，聊天记录暂时不可用。'
        });
      }

      console.error('/chat 接口错误');
      return res.status(502).json({
        error: '上游服务暂时不可用',
        reply: '抱歉，我现在有点不在状态，请稍后再试试。'
      });
    }
  });

  // ---------- 统一错误响应 ----------
  app.use((error, req, res, next) => {
    if (error.code === 'CORS_NOT_ALLOWED') {
      return res.status(403).json({ error: '不允许的跨域来源' });
    }
    if (error.type === 'entity.too.large') {
      return res.status(413).json({ error: '请求内容过大' });
    }
    console.error('未处理的请求错误');
    return res.status(500).json({ error: '服务器内部错误' });
  });

  return app;
}

function startServer() {
  const app = createApp();
  const port = process.env.PORT || 3000;
  return app.listen(port, () => {
    console.log(`✅ 后端服务已启动，端口: ${port}`);
    console.log('   /health       - 健康检查');
    console.log('   /test-db      - 数据库连接测试');
    console.log('   /test-gateway - Gateway 连接测试');
    console.log('   /models       - 获取 Gateway 模型列表 (POST)');
    console.log('   /chat         - 对话接口（Gateway 模式）');
    console.log('   /chat/history - 获取聊天历史');
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  createApp,
  normalizeClientHistory,
  normalizeHistory,
  normalizeSessionId,
  toSupabaseSessionId,
  validateGatewayBaseUrl
};
