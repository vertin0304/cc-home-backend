require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const port = process.env.PORT || 3000;

// 中间件
app.use(cors());
app.use(express.json());

// 初始化 Supabase 客户端
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// ---------- 健康检查 ----------
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'cc-home 后端运行中' });
});

// ---------- 测试数据库连接 ----------
app.get('/test-db', async (req, res) => {
  try {
    const { data, error } = await supabase.from('settings').select('*');
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------- 对话接口（完全环境变量驱动） ----------
app.post('/chat', async (req, res) => {
  const { message, sessionId } = req.body;
  if (!message) {
    return res.status(400).json({ error: '消息内容不能为空' });
  }

  const finalSessionId = sessionId || Date.now();

  // 从环境变量读取 AI 配置（万能适配）
  const API_BASE_URL = process.env.BASE_URL;      // 如 https://api.deepseek.com/v1
  const API_KEY = process.env.API_KEY;            // 你的密钥
  const MODEL_NAME = process.env.MODEL_NAME;      // 模型名称，如 deepseek-chat

  try {
    // 1. 加载历史消息
    const { data: history, error } = await supabase
      .from('messages')
      .select('role, content')
      .eq('session_id', finalSessionId)
      .eq('visible', true)
      .order('created_at', { ascending: true })
      .limit(20);

    if (error) console.error('加载历史消息失败:', error);

    // 2. 组装上下文
    const systemPrompt = '你是一个温柔、体贴的AI助手，说话简洁自然，像朋友一样陪伴。';
    const messages = [
      { role: 'system', content: systemPrompt },
      ...(history || []).map(msg => ({ role: msg.role, content: msg.content })),
      { role: 'user', content: message }
    ];

    let reply = '';

    // 3. 检查是否配置了完整的 AI 信息
    if (!API_BASE_URL || !API_KEY || !MODEL_NAME) {
      // 缺少配置 → 返回模拟回复（方便测试链路）
      const mockReplies = [
        '我听到了，你想说什么呢？',
        '嗯，我在听你说话。',
        '今天过得怎么样？',
        '有时候不说话也很好。',
        '我在这里陪你。'
      ];
      reply = mockReplies[Math.floor(Math.random() * mockReplies.length)];
      console.warn('⚠️ 缺少 AI 配置（BASE_URL/API_KEY/MODEL_NAME），使用模拟回复');
    } else {
      // 4. 调用真实 AI（OpenAI 兼容格式）
      const response = await fetch(`${API_BASE_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${API_KEY}`
        },
        body: JSON.stringify({
          model: MODEL_NAME,
          messages: messages,
          temperature: 0.7,
          max_tokens: 1000
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error('AI API 错误:', response.status, errText);
        throw new Error(`AI API 错误: ${response.status}`);
      }

      const data = await response.json();
      reply = data.choices?.[0]?.message?.content || '抱歉，我没有理解你的意思。';
    }

    // 5. 保存消息到数据库
    try {
      await supabase.from('messages').insert([
        { session_id: finalSessionId, role: 'user', content: message },
        { session_id: finalSessionId, role: 'ai', content: reply }
      ]);
    } catch (saveError) {
      console.error('保存消息失败:', saveError);
    }

    res.json({ reply });

  } catch (error) {
    console.error('/chat 接口错误:', error);
    res.status(500).json({
      error: '服务器内部错误',
      reply: '抱歉，我现在有点不在状态，请稍后再试试。'
    });
  }
});

// ---------- 启动服务器 ----------
app.listen(port, () => {
  console.log(`✅ 后端服务已启动，端口: ${port}`);
  console.log(`   /health  - 健康检查`);
  console.log(`   /test-db - 数据库连接测试`);
  console.log(`   /chat    - 对话接口 (POST)`);
});