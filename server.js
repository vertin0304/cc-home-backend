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

// ---------- 健康检查接口 ----------
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'cc-home 后端运行中' });
});

// ---------- 测试数据库连接接口 ----------
app.get('/test-db', async (req, res) => {
  try {
    const { data, error } = await supabase.from('settings').select('*');
    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------- 对话接口（/chat） ----------
app.post('/chat', async (req, res) => {
  const { message, sessionId } = req.body;
  
  // 简单校验
  if (!message) {
    return res.status(400).json({ error: '消息内容不能为空' });
  }

  // 如果没有传 sessionId，生成一个临时 ID（前端会传，这里做兜底）
  const finalSessionId = sessionId || Date.now();

  try {
    // 1. 从数据库加载该会话的历史消息（只取最近20条可见消息）
    const { data: history, error } = await supabase
      .from('messages')
      .select('role, content')
      .eq('session_id', finalSessionId)
      .eq('visible', true)
      .order('created_at', { ascending: true })
      .limit(20);

    if (error) {
      console.error('加载历史消息失败:', error);
      // 不影响主流程，继续执行
    }

    // 2. 组装上下文
    const systemPrompt = '你是一个温柔、体贴的AI助手，说话简洁自然，像朋友一样陪伴。';
    const messages = [
      { role: 'system', content: systemPrompt },
      ...(history || []).map(msg => ({ role: msg.role, content: msg.content })),
      { role: 'user', content: message }
    ];

    // 3. 调用 DeepSeek API（需要配置 DEEPSEEK_API_KEY）
    const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
    let reply = '';

    if (!DEEPSEEK_API_KEY) {
      // 如果没有配置 API Key，返回模拟回复（便于测试前端连通性）
      const mockReplies = [
        '我听到了，你想说什么呢？',
        '嗯，我在听你说话。',
        '今天过得怎么样？',
        '有时候不说话也很好。',
        '我在这里陪你。'
      ];
      reply = mockReplies[Math.floor(Math.random() * mockReplies.length)];
      console.warn('⚠️ 未配置 DEEPSEEK_API_KEY，使用模拟回复');
    } else {
      // 真实调用 DeepSeek API
      const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: messages,
          temperature: 0.7,
          max_tokens: 1000
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error('DeepSeek API 错误:', response.status, errText);
        throw new Error(`DeepSeek API 错误: ${response.status}`);
      }

      const data = await response.json();
      reply = data.choices?.[0]?.message?.content || '抱歉，我没有理解你的意思。';
    }

    // 4. 保存消息到数据库（可选，但建议保留）
    try {
      await supabase.from('messages').insert([
        { session_id: finalSessionId, role: 'user', content: message },
        { session_id: finalSessionId, role: 'ai', content: reply }
      ]);
    } catch (saveError) {
      console.error('保存消息失败:', saveError);
      // 不影响回复返回
    }

    // 5. 返回回复给前端
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