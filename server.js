require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const net = require('net');
const { createClient } = require('@supabase/supabase-js');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';

// 中间件
app.set('trust proxy', 1);

const configuredOrigins = (process.env.FRONTEND_ORIGIN || '')
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
    // 无 Origin 的服务端请求不受浏览器 CORS 限制，仍由接口自身鉴权。
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
function secureTokenEquals(candidate, expected) {
  if (typeof candidate !== 'string' || typeof expected !== 'string') return false;
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  return candidateBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(candidateBuffer, expectedBuffer);
}

function requireAdmin(req, res, next) {
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) {
    console.error('管理员接口不可用：未配置 ADMIN_TOKEN');
    return res.status(503).json({ error: '管理员功能未配置' });
  }

  const authorization = req.get('authorization') || '';
  const bearerToken = authorization.startsWith('Bearer ')
    ? authorization.slice(7).trim()
    : '';
  const candidate = bearerToken || req.get('x-admin-token') || req.body?.token;

  if (!secureTokenEquals(candidate, adminToken)) {
    return res.status(401).json({ error: '管理员验证失败' });
  }
  return next();
}

// ---------- 外部 AI 地址验证 ----------
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

function validateBaseUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return { valid: false, error: 'base_url 不能为空' };
  }

  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      return { valid: false, error: 'base_url 格式无效' };
    }
    if (isProduction && (url.protocol !== 'https:' || isPrivateHostname(url.hostname))) {
      return { valid: false, error: '生产环境只允许公开的 HTTPS 地址' };
    }

    const allowlist = (process.env.AI_BASE_URL_ALLOWLIST || '')
      .split(',')
      .map(item => item.trim())
      .filter(Boolean);
    if (allowlist.length > 0) {
      const allowed = allowlist.some(item => {
        try {
          return new URL(item).origin === url.origin;
        } catch {
          return false;
        }
      });
      if (!allowed) {
        return { valid: false, error: 'base_url 不在允许列表中' };
      }
    }
    return { valid: true, url };
  } catch {
    return { valid: false, error: 'base_url 格式无效' };
  }
}

// ---------- 对话频率限制 ----------
function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const chatRateLimitWindowMs = positiveInteger(process.env.CHAT_RATE_LIMIT_WINDOW_MS, 60_000);
const chatRateLimitMax = positiveInteger(process.env.CHAT_RATE_LIMIT_MAX, 20);
const chatMaxMessageLength = positiveInteger(process.env.CHAT_MAX_MESSAGE_LENGTH, 4_000);
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

// 初始化 Supabase 客户端
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ---------- Ombre Brain MCP 连接配置 ----------
const OMBRE_BRAIN_URL = process.env.OMBRE_BRAIN_URL || 'https://cc-home.zeabur.app';
let ombreSessionId = null;
let ombreCallId = 0;

// ---------- SSE 响应解析器 ----------
function parseSSEResponse(text) {
  const lines = text.split('\n');
  for (const line of lines) {
    if (line.startsWith('data: ')) {
      try {
        return JSON.parse(line.substring(6));
      } catch (e) { /* ignore */ }
    }
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

// ---------- MCP 会话初始化 ----------
async function initOmbreSession() {
  try {
    const response = await axios.post(
      `${OMBRE_BRAIN_URL}/mcp`,
      {
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "cc-home-backend", version: "1.0" }
        },
        id: ++ombreCallId
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream'
        }
      }
    );

    if (response.headers['mcp-session-id']) {
      ombreSessionId = response.headers['mcp-session-id'];
    } else {
      const parsed = parseSSEResponse(response.data);
      if (parsed?.result?.sessionId) {
        ombreSessionId = parsed.result.sessionId;
      }
    }

    if (!ombreSessionId) {
      console.error('❌ 无法获取 MCP session ID');
      return false;
    }

    await axios.post(
      `${OMBRE_BRAIN_URL}/mcp`,
      {
        jsonrpc: "2.0",
        method: "notifications/initialized"
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'Mcp-Session-Id': ombreSessionId
        }
      }
    );

    console.log('✅ Ombre Brain MCP 会话已建立');
    return true;
  } catch (err) {
    console.error('❌ MCP 会话初始化失败:', err.message);
    ombreSessionId = null;
    return false;
  }
}

// ---------- 调用 Ombre Brain 工具 ----------
async function callOmbreTool(toolName, args = {}) {
  if (!OMBRE_BRAIN_URL) return null;

  try {
    if (!ombreSessionId) {
      const ok = await initOmbreSession();
      if (!ok) return null;
    }

    const response = await axios.post(
      `${OMBRE_BRAIN_URL}/mcp`,
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: toolName,
          arguments: args
        },
        id: ++ombreCallId
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'Mcp-Session-Id': ombreSessionId
        },
        transformResponse: [(data) => data]
      }
    );

    const parsed = parseSSEResponse(response.data);
    if (parsed?.result?.content) {
      return parsed.result.content
        .filter(c => c.type === 'text')
        .map(c => c.text)
        .join('\n');
    }
    return parsed ? JSON.stringify(parsed) : null;
  } catch (err) {
    console.error(`❌ MCP 工具 ${toolName} 调用失败:`, err.message);
    return null;
  }
}

// ---------- 从数据库读取 AI 配置（如果数据库有值则使用，否则 fallback 到环境变量） ----------
async function getAIConfig() {
  try {
    const { data, error } = await supabase
      .from('settings')
      .select('base_url, api_key, model_name')
      .eq('id', 1)
      .single();

    if (error || !data) {
      // 如果数据库没有记录，返回环境变量
      return {
        base_url: process.env.BASE_URL,
        api_key: process.env.API_KEY,
        model_name: process.env.MODEL_NAME
      };
    }

    // 数据库有值，使用数据库，但若某个字段为空则 fallback 到环境变量
    return {
      base_url: data.base_url || process.env.BASE_URL,
      api_key: data.api_key || process.env.API_KEY,
      model_name: data.model_name || process.env.MODEL_NAME
    };
  } catch (e) {
    console.warn('读取数据库配置失败，使用环境变量:', e.message);
    return {
      base_url: process.env.BASE_URL,
      api_key: process.env.API_KEY,
      model_name: process.env.MODEL_NAME
    };
  }
}

// ---------- 健康检查 ----------
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'cc-home 后端运行中（已接入 Ombre Brain）' });
});

// ---------- 测试数据库连接（仅管理员） ----------
app.get('/test-db', requireAdmin, async (req, res) => {
  try {
    const { error } = await supabase
      .from('settings')
      .select('id', { head: true, count: 'exact' })
      .limit(1);
    if (error) throw error;
    res.json({ connected: true });
  } catch (err) {
    console.error('数据库连接测试失败:', err.message);
    res.status(503).json({ connected: false });
  }
});

// ---------- 测试 Ombre Brain 连接（仅管理员，不读取记忆） ----------
app.get('/test-ombre', requireAdmin, async (req, res) => {
  const connected = await initOmbreSession();
  res.status(connected ? 200 : 503).json({ connected });
});

// ---------- 获取模型列表（仅管理员） ----------
app.post('/models', requireAdmin, async (req, res) => {
  const { base_url, api_key } = req.body;
  if (typeof base_url !== 'string' || typeof api_key !== 'string' || !base_url || !api_key) {
    return res.status(400).json({ error: '缺少 base_url 或 api_key' });
  }

  const validation = validateBaseUrl(base_url);
  if (!validation.valid) {
    return res.status(400).json({ error: validation.error });
  }

  try {
    // 拼接 /models 接口（OpenAI 兼容标准）
    const normalizedBaseUrl = validation.url.toString();
    const url = normalizedBaseUrl.endsWith('/')
      ? `${normalizedBaseUrl}models`
      : `${normalizedBaseUrl}/models`;
    const response = await axios.get(url, {
      headers: {
        'Authorization': `Bearer ${api_key}`
      },
      timeout: 15_000,
      maxRedirects: 0
    });

    // 标准返回格式：{ data: [ { id: 'model-name', ... }, ... ] }
    const models = response.data?.data?.map(m => m.id) || [];
    res.json({ success: true, models });
  } catch (err) {
    console.error('获取模型列表失败:', {
      message: err.message,
      status: err.response?.status
    });
    res.status(502).json({
      success: false,
      error: '无法获取模型列表'
    });
  }
});

// ---------- 更新 AI 配置（需要管理员 token） ----------
app.post('/admin/config', requireAdmin, async (req, res) => {
  const { base_url, api_key, model_name } = req.body;

  if (api_key !== undefined && typeof api_key !== 'string') {
    return res.status(400).json({ error: 'api_key 格式无效' });
  }
  if (model_name !== undefined && typeof model_name !== 'string') {
    return res.status(400).json({ error: 'model_name 格式无效' });
  }

  let validatedBaseUrl;
  if (base_url !== undefined) {
    validatedBaseUrl = validateBaseUrl(base_url);
    if (!validatedBaseUrl.valid) {
      return res.status(400).json({ error: validatedBaseUrl.error });
    }
  }

  try {
    // 只更新提供的字段，缺失则不更新
    const updates = {};
    if (validatedBaseUrl) updates.base_url = validatedBaseUrl.url.toString();
    if (api_key !== undefined) updates.api_key = api_key;
    if (model_name !== undefined) updates.model_name = model_name;
    updates.updated_at = new Date();

    const { error } = await supabase
      .from('settings')
      .update(updates)
      .eq('id', 1);

    if (error) throw error;
    res.json({ success: true, message: '配置已更新，下次对话生效' });
  } catch (err) {
    console.error('更新 AI 配置失败:', err.message);
    res.status(500).json({ success: false, error: '配置更新失败' });
  }
});

// ---------- 对话接口（已接入记忆，并从数据库读取 AI 配置） ----------
app.post('/chat', chatRateLimit, async (req, res) => {
  const { message, sessionId } = req.body;
  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: '消息内容不能为空' });
  }
  if (message.length > chatMaxMessageLength) {
    return res.status(413).json({
      error: `消息内容不能超过 ${chatMaxMessageLength} 个字符`
    });
  }

  const finalSessionId = sessionId || Date.now();

  try {
    // 1. 从数据库读取 AI 配置
    const config = await getAIConfig();
    const { base_url, api_key, model_name } = config;

    // 2. 从 Ombre Brain 检索相关记忆
    let memories = '';
    try {
      const memoryResult = await callOmbreTool('breath', { query: message });
      if (memoryResult) {
        memories = memoryResult;
        console.log('🧠 检索到相关记忆:', memories.substring(0, 100) + '...');
      }
    } catch (memErr) {
      console.warn('⚠️ 记忆检索失败（继续对话）:', memErr.message);
    }

    // 3. 加载数据库历史消息
    const { data: history, error } = await supabase
      .from('messages')
      .select('role, content')
      .eq('session_id', finalSessionId)
      .eq('visible', true)
      .order('created_at', { ascending: true })
      .limit(20);

    if (error) console.error('加载历史消息失败:', error);

    // 4. 组装上下文（包含记忆）
    const systemPrompt = `你是一个温柔、体贴的AI助手，说话简洁自然，像朋友一样陪伴。

【关于我们的记忆】
${memories || '（这是我们的第一次对话，还没有共同记忆。）'}

请基于以上记忆和当前的对话，自然地回应。`;

    const messages = [
      { role: 'system', content: systemPrompt },
      ...(history || []).map(msg => ({ role: msg.role, content: msg.content })),
      { role: 'user', content: message }
    ];

    // 5. 调用 AI 模型（优先使用数据库配置）
    let reply = '';
    if (!base_url || !api_key || !model_name) {
      const mockReplies = ['我听到了，你想说什么呢？', '嗯，我在听你说话。', '今天过得怎么样？'];
      reply = mockReplies[Math.floor(Math.random() * mockReplies.length)];
      console.warn('⚠️ 缺少 AI 配置，使用模拟回复');
    } else {
      const url = base_url.endsWith('/') ? `${base_url}chat/completions` : `${base_url}/chat/completions`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${api_key}`
        },
        body: JSON.stringify({
          model: model_name,
          messages: messages,
          temperature: 0.7,
          max_tokens: 1000
        })
      });

      if (!response.ok) {
        throw new Error(`AI API 请求失败，状态码: ${response.status}`);
      }

      const data = await response.json();
      reply = data.choices?.[0]?.message?.content || '抱歉，我没有理解你的意思。';
    }

    // 6. 保存消息到数据库
    try {
      await supabase.from('messages').insert([
        { session_id: finalSessionId, role: 'user', content: message },
        { session_id: finalSessionId, role: 'ai', content: reply }
      ]);
    } catch (saveError) {
      console.error('保存消息失败:', saveError);
    }

    // 7. 存储对话到 Ombre Brain 记忆
    try {
      const memoryText = `用户说：${message}\nAI说：${reply}`;
      await callOmbreTool('hold', { content: memoryText });
      console.log('💾 对话已存入 Ombre Brain 记忆');
    } catch (holdErr) {
      console.warn('⚠️ 记忆存储失败（不影响回复）:', holdErr.message);
    }

    res.json({ reply });

  } catch (error) {
    console.error('/chat 接口错误:', error.message);
    res.status(500).json({
      error: '服务器内部错误',
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
  console.error('未处理的请求错误:', error.message);
  return res.status(500).json({ error: '服务器内部错误' });
});

// ---------- 启动服务器 ----------
app.listen(port, async () => {
  console.log(`✅ 后端服务已启动，端口: ${port}`);
  console.log(`   /health    - 健康检查`);
  console.log(`   /test-db   - 数据库连接测试`);
  console.log(`   /test-ombre - Ombre Brain 连接测试`);
  console.log(`   /models    - 获取模型列表 (POST)`);
  console.log(`   /admin/config - 更新 AI 配置 (POST)`);
  console.log(`   /chat      - 对话接口（已接入记忆）`);

  // 启动时预连接 Ombre Brain
  try {
    await initOmbreSession();
  } catch (e) {
    console.warn('⚠️ 首次 Ombre Brain 连接失败，将在首次调用时重试');
  }
});
