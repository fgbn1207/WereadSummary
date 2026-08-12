// === 书籍快览 Worker ===
// GET / → 返回 HTML 页面
// POST / → 代理微信读书 API

const API_KEY = 'wrk-k3GuXDMlQmmo8Lhjlx6r6QAA';
const API_GATEWAY = 'https://i.weread.qq.com/api/agent/gateway';

const ACTION_MAP = {
  search: { api_name: '/store/search', skill_version: '1.0.4' },
  bookInfo: { api_name: '/book/info', skill_version: '1.0.4' },
  highlights: { api_name: '/book/bestbookmarks', skill_version: '1.0.4' },
  reviews: { api_name: '/book/readreviews', skill_version: '1.0.4' }
};

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// Gemini 模型降级列表（优先级从高到低）
const GEMINI_MODELS = ['gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-3.1-flash-lite'];

// 调用 Gemini API，支持模型自动降级
async function callGeminiWithFallback(apiKey, contents, generationConfig) {
  let lastError = null;
  for (let i = 0; i < GEMINI_MODELS.length; i++) {
    const model = GEMINI_MODELS[i];
    try {
      const resp = await fetch(
        'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + apiKey,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents, generationConfig })
        }
      );
      const data = await resp.json();
      if (data.error) {
        lastError = data.error.message;
        // 如果是 high demand 或资源耗尽错误，尝试下一个模型
        if (data.error.message && (
          data.error.message.includes('high demand') ||
          data.error.message.includes('resource') ||
          data.error.message.includes('overloaded') ||
          data.error.message.includes('quota') ||
          data.error.code === 429 ||
          data.error.code === 503
        )) {
          continue;
        }
        // 其他错误直接返回
        return { error: 'Gemini API 错误: ' + data.error.message };
      }
      const text = data.candidates && data.candidates[0] && data.candidates[0].content
        ? data.candidates[0].content.parts[0].text
        : null;
      if (!text) {
        return { error: '生成失败：未返回有效内容' };
      }
      return { text };
    } catch (e) {
      lastError = e.message;
      continue;
    }
  }
  return { error: '所有 Gemini 模型均不可用，最后错误: ' + lastError };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const GEMINI_API_KEY = env.GEMINI_API_KEY;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // GET / → 返回 HTML 页面
    if (request.method === 'GET' && url.pathname === '/') {
      return new Response(HTML_CONTENT, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS }
      });
    }

    // POST / → 代理 API
    if (request.method === 'POST' && url.pathname === '/') {
      try {
        const body = await request.json();
        const { action, params } = body;

        if (!ACTION_MAP[action]) {
          return new Response(JSON.stringify({ error: '未知 action: ' + action }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
          });
        }

        const { api_name, skill_version } = ACTION_MAP[action];
        const apiBody = { api_name, skill_version, ...params };

        const resp = await fetch(API_GATEWAY, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + API_KEY
          },
          body: JSON.stringify(apiBody)
        });

        const data = await resp.json();
        return new Response(JSON.stringify(data), {
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
        });
      }
    }

    // POST /ai → 调用 Gemini 生成深度分析
    if (request.method === 'POST' && url.pathname === '/ai') {
      try {
        const body = await request.json();
        const { prompt } = body;
        if (!prompt) {
          return new Response(JSON.stringify({ error: '缺少 prompt' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
          });
        }
        if (!GEMINI_API_KEY) {
          return new Response(JSON.stringify({ error: '请在 Cloudflare Worker Secrets 中配置 GEMINI_API_KEY' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
          });
        }
        const result = await callGeminiWithFallback(
          GEMINI_API_KEY,
          [{ parts: [{ text: prompt }] }],
          { temperature: 0.7, maxOutputTokens: 32768 }
        );
        if (result.error) {
          return new Response(JSON.stringify({ error: result.error }), {
            status: 500, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
          });
        }
        return new Response(JSON.stringify({ text: result.text }), {
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
        });
      }
    }

    // === KV 云端同步 ===
    // GET /kv/load → 从 KV 读取所有结果
    if (request.method === 'GET' && url.pathname === '/kv/load') {
      if (!env.WR_KV) {
        return new Response(JSON.stringify({ error: 'KV not configured', results: [] }), { status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
      }
      try {
        var raw = await env.WR_KV.get('wr_results', 'json');
        return new Response(JSON.stringify({ ok: true, results: raw || [] }), {
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
        });
      } catch(e) {
        return new Response(JSON.stringify({ error: e.message, results: [] }), {
          status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
        });
      }
    }

    // POST /kv/save → 保存结果到 KV（合并去重）
    if (request.method === 'POST' && url.pathname === '/kv/save') {
      if (!env.WR_KV) {
        return new Response(JSON.stringify({ error: 'KV not configured' }), { status: 503, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
      }
      try {
        var body = await request.json();
        var incoming = body.results || [];
        var existing = await env.WR_KV.get('wr_results', 'json') || [];
        var map = {};
        existing.forEach(function(r) { map[r.id] = r; });
        incoming.forEach(function(r) { map[r.id] = r; });
        var merged = Object.values(map);
        merged.sort(function(a, b) {
          return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
        });
        await env.WR_KV.put('wr_results', JSON.stringify(merged), { expirationTtl: 7776000 });
        return new Response(JSON.stringify({ ok: true, results: merged }), {
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
        });
      } catch(e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
        });
      }
    }

    // POST /kv/delete → 删除指定结果
    if (request.method === 'POST' && url.pathname === '/kv/delete') {
      if (!env.WR_KV) {
        return new Response(JSON.stringify({ error: 'KV not configured' }), { status: 503, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
      }
      try {
        var body = await request.json();
        var delId = body.id;
        var existing = await env.WR_KV.get('wr_results', 'json') || [];
        var filtered = existing.filter(function(r) { return r.id !== delId; });
        await env.WR_KV.put('wr_results', JSON.stringify(filtered), { expirationTtl: 7776000 });
        return new Response(JSON.stringify({ ok: true, results: filtered }), {
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
        });
      } catch(e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
        });
      }
    }


    // POST /kv/chat/load → 加载指定结果的聊天记录
    if (request.method === 'POST' && url.pathname === '/kv/chat/load') {
      if (!env.WR_KV) {
        return new Response(JSON.stringify({ ok: false, messages: [] }), { status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
      }
      try {
        var body = await request.json();
        var resultId = body.resultId;
        var key = 'wr_chat_' + resultId;
        var messages = await env.WR_KV.get(key, 'json') || [];
        return new Response(JSON.stringify({ ok: true, messages: messages }), {
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
        });
      } catch(e) {
        return new Response(JSON.stringify({ ok: false, messages: [], error: e.message }), {
          status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
        });
      }
    }

    // POST /kv/chat/save → 保存指定结果的聊天记录
    if (request.method === 'POST' && url.pathname === '/kv/chat/save') {
      if (!env.WR_KV) {
        return new Response(JSON.stringify({ ok: false, error: 'KV not configured' }), { status: 503, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
      }
      try {
        var body = await request.json();
        var resultId = body.resultId;
        var messages = body.messages || [];
        var key = 'wr_chat_' + resultId;
        await env.WR_KV.put(key, JSON.stringify(messages), { expirationTtl: 7776000 });
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
        });
      } catch(e) {
        return new Response(JSON.stringify({ ok: false, error: e.message }), {
          status: 500, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
        });
      }
    }

    // POST /chat → 多轮对话（基于生成内容的上下文）
    if (request.method === 'POST' && url.pathname === '/chat') {
      if (!env || !GEMINI_API_KEY) {
        return new Response(JSON.stringify({ error: 'API Key not configured' }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
        });
      }
      try {
        var body = await request.json();
        var messages = body.messages || [];
        var context = body.context || '';
        if (!messages.length) {
          return new Response(JSON.stringify({ error: 'No messages' }), {
            status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
          });
        }
        var contents = [];
        if (context) {
          contents.push({
            role: 'user',
            parts: [{ text: '以下是我之前让你生成的一篇深度分析内容，请基于此内容回答我的后续问题。\n\n---\n' + context + '\n---\n\n已收到以上内容，我会基于这篇分析来回答你的问题。' }]
          });
          contents.push({
            role: 'model',
            parts: [{ text: '好的，我已经仔细阅读了这篇分析内容。请随时提问，我会基于这篇内容和你感兴趣的方向进行深入探讨。' }]
          });
        }
        messages.forEach(function(m) {
          contents.push({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }]
          });
        });

        var result = await callGeminiWithFallback(
          GEMINI_API_KEY,
          contents,
          { temperature: 0.7, maxOutputTokens: 4096 }
        );
        if (result.error) {
          return new Response(JSON.stringify({ error: result.error }), {
            status: 500, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
          });
        }
        return new Response(JSON.stringify({ text: result.text }), {
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
        });
      } catch(e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
        });
      }
    }

    // POST /mp/accounts → 获取公众号列表（按分类）
    if (request.method === 'POST' && url.pathname === '/mp/accounts') {
      try {
        const resp = await fetch(API_GATEWAY, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + API_KEY
          },
          body: JSON.stringify({ api_name: '/shelf/sync', skill_version: '1.0.4', synckey: 0, count: 5 })
        });
        const data = await resp.json();
        const booksMap = {};
        (data.books || []).forEach(function(b) { booksMap[b.bookId] = b; });
        const categories = [];
        (data.archive || []).forEach(function(cat) {
          const mpIds = (cat.bookIds || []).filter(function(id) { return id.startsWith('MP_WXS_'); });
          if (mpIds.length > 0) {
            const accounts = mpIds.map(function(id) {
              const b = booksMap[id];
              if (!b) return null;
              var dl = b.deepLink || '';
              var readerUrl = '';
              if (dl) {
                var vMatch = dl.match(/[?&]v=([^&]+)/);
                if (vMatch) {
                  readerUrl = 'https://weread.qq.com/web/mp/reader/' + vMatch[1];
                }
              }
              return {
                bookId: id,
                title: b.title,
                cover: b.cover || '',
                updateTime: new Date(b.updateTime * 1000).toISOString().slice(0, 16).replace('T', ' '),
                updateTs: b.updateTime,
                deepLink: dl,
                readerUrl: readerUrl,
                intro: ''
              };
            }).filter(function(a) { return a !== null; });
            accounts.sort(function(a, b) { return b.updateTs - a.updateTs; });
            categories.push({ name: cat.name, accounts: accounts });
          }
        });
        categories.sort(function(a, b) { return b.accounts.length - a.accounts.length; });
        return new Response(JSON.stringify({ ok: true, categories: categories }), {
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message, categories: [] }), {
          status: 500, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
        });
      }
    }

    // GET /mp/star/get → 获取星标公众号列表
    if (request.method === 'GET' && url.pathname === '/mp/star/get') {
      if (!env.WR_KV) {
        return new Response(JSON.stringify({ ok: true, starred: [] }), {
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
        });
      }
      try {
        var starred = await env.WR_KV.get('mp_starred', 'json') || [];
        return new Response(JSON.stringify({ ok: true, starred: starred }), {
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message, starred: [] }), {
          status: 500, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
        });
      }
    }

    // POST /mp/star/set → 设置星标公众号列表
    if (request.method === 'POST' && url.pathname === '/mp/star/set') {
      if (!env.WR_KV) {
        return new Response(JSON.stringify({ error: 'KV not configured' }), {
          status: 503, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
        });
      }
      try {
        var body = await request.json();
        var starred = body.starred || [];
        await env.WR_KV.put('mp_starred', JSON.stringify(starred));
        return new Response(JSON.stringify({ ok: true }), {
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
        });
      }
    }

    // GET /bookshelf/load → 从 KV 读取书架数据
    if (request.method === 'GET' && url.pathname === '/bookshelf/load') {
      if (!env.WR_KV) {
        return new Response(JSON.stringify({ ok: true, cats: null }), {
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
        });
      }
      try {
        var raw = await env.WR_KV.get('shelf_books', 'json');
        return new Response(JSON.stringify({ ok: true, cats: raw, count: raw ? Object.values(raw).reduce(function(s, arr) { return s + arr.length; }, 0) : 0 }), {
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
        });
      } catch(e) {
        return new Response(JSON.stringify({ ok: false, cats: null, error: e.message }), {
          status: 500, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
        });
      }
    }

    // POST /bookshelf/sync → 从微信读书同步书架数据到 KV
    if (request.method === 'POST' && url.pathname === '/bookshelf/sync') {
      if (!env.WR_KV) {
        return new Response(JSON.stringify({ error: 'KV not configured' }), {
          status: 503, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
        });
      }
      try {
        // 调用微信读书 API 获取完整书架
        const resp = await fetch(API_GATEWAY, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + API_KEY
          },
          body: JSON.stringify({ api_name: '/shelf/sync', skill_version: '1.0.4', synckey: 0, count: 1000 })
        });
        const data = await resp.json();
        const booksMap = {};
        (data.books || []).forEach(function(b) { booksMap[b.bookId] = b; });

        // 按分类组织书籍（只取非公众号的普通书籍）
        const cats = {};
        (data.archive || []).forEach(function(cat) {
          const bookIds = (cat.bookIds || []).filter(function(id) { return !id.startsWith('MP_WXS_'); });
          if (bookIds.length > 0) {
            cats[cat.name] = bookIds.map(function(id) {
              const b = booksMap[id];
              if (!b) return null;
              return { t: b.title, a: b.author || '' };
            }).filter(function(b) { return b !== null; });
          }
        });

        // 存入 KV
        await env.WR_KV.put('shelf_books', JSON.stringify(cats));
        var totalBooks = Object.values(cats).reduce(function(s, arr) { return s + arr.length; }, 0);

        return new Response(JSON.stringify({ ok: true, total: totalBooks, cats: cats }), {
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
        });
      }
    }

    // POST /mp/articles → 获取公众号文章列表（Web Cookie API + KV 缓存）
    if (request.method === 'POST' && url.pathname === '/mp/articles') {
      try {
        const body = await request.json();
        const bookId = body.bookId;
        if (!bookId) {
          return new Response(JSON.stringify({ error: '缺少 bookId' }), {
            status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
          });
        }

        // 1. 检查 KV 缓存（1小时有效）
        const cacheKey = 'mp_articles_' + bookId;
        const cached = await env.WR_KV.get(cacheKey);
        if (cached) {
          const cachedData = JSON.parse(cached);
          return new Response(JSON.stringify({ ok: true, ...cachedData, _cached: true }), {
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
          });
        }

        // 2. 获取公众号基本信息和文章列表（Agent API）
        let bookInfo = {};
        try {
          const infoResp = await fetch(API_GATEWAY, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + API_KEY },
            body: JSON.stringify({ api_name: '/book/info', skill_version: '1.0.4', bookId: bookId })
          });
          bookInfo = await infoResp.json();
        } catch(e) {}

        // 4. 调用微信读书 Web API 获取文章列表
        const mpResp = await fetch(API_GATEWAY, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + API_KEY },
          body: JSON.stringify({ api_name: '/book/chapterinfo', bookId: bookId, synckey: 0 })
        });

        if (!mpResp.ok) {
          // API 调用失败，返回 fallback
          return new Response(JSON.stringify({
            ok: true,
            bookId: bookId,
            title: bookInfo.title || '',
            intro: bookInfo.intro || '',
            deepLink: bookInfo.deepLink || '',
            articles: []
          }), {
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
          });
        }

        const mpData = await mpResp.json();
        const rawChapters = mpData.chapters || [];
        const articles = rawChapters.map(function(ch) {
          var date = '';
          if (ch.updateTime) {
            var d = new Date(ch.updateTime * 1000);
            date = d.toISOString().substring(0, 10);
          }
          return {
            title: ch.title || '',
            url: '',
            deepLink: '',
            date: date,
            readCount: 0,
            likeCount: 0,
            cover: ''
          };
        });

        // 5. 缓存到 KV（1小时）
        const resultData = {
          bookId: bookId,
          title: bookInfo.title || '',
          intro: bookInfo.intro || '',
          deepLink: bookInfo.deepLink || '',
          articles: articles
        };
        await env.WR_KV.put(cacheKey, JSON.stringify(resultData), { expirationTtl: 3600 });

        return new Response(JSON.stringify({ ok: true, ...resultData }), {
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message, articles: [] }), {
          status: 500, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
        });
      }
    }

    return new Response('Not Found', { status: 404, headers: CORS_HEADERS });
  }
};

const HTML_CONTENT = "\u003c!DOCTYPE html\u003e\n\u003chtml lang=\"zh-CN\"\u003e\n\u003chead\u003e\n\u003cmeta charset=\"UTF-8\"\u003e\n\u003cmeta name=\"viewport\" content=\"width=device-width,initial-scale=1\"\u003e\n\u003ctitle\u003e书籍快览\u003c/title\u003e\n\u003cstyle\u003e\n*{margin:0;padding:0;box-sizing:border-box}\nbody{font-family:-apple-system,BlinkMacSystemFont,\"Segoe UI\",Roboto,sans-serif;background:#0d1117;color:#e6edf3;min-height:100vh}\n.container{padding:16px;max-width:900px;margin:0 auto}\nh1{font-size:22px;text-align:center;margin-bottom:4px;color:#58a6ff}\n.sub{text-align:center;font-size:13px;color:#8b949e;margin-bottom:20px}\n\n/* Channel Tabs */\n.channel-tabs{display:flex;gap:0;margin-bottom:20px;border-bottom:1px solid #30363d}\n.channel-tab{flex:1;text-align:center;padding:12px;font-size:15px;font-weight:600;cursor:pointer;color:#8b949e;border-bottom:2px solid transparent;transition:all .2s}\n.channel-tab:hover{color:#e6edf3}\n.channel-tab.active{color:#58a6ff;border-bottom-color:#58a6ff}\n\n/* Book Channel Styles */\n.controls{display:flex;gap:10px;margin-bottom:12px;flex-wrap:wrap}\n.controls select,.controls input{background:#161b22;border:1px solid #30363d;color:#e6edf3;padding:8px 12px;border-radius:8px;font-size:14px;flex:1;min-width:140px}\n.controls input{flex:2}\n.counter{font-size:13px;color:#8b949e;text-align:center;margin-bottom:8px}\n.book-list{max-height:30vh;overflow-y:auto;border:1px solid #30363d;border-radius:8px;background:#161b22;margin-bottom:12px}\n.book-item{display:flex;align-items:center;padding:10px 14px;border-bottom:1px solid #21262d;cursor:pointer}\n.book-item:hover{background:#1c2333}\n.book-item:last-child{border-bottom:none}\n.book-item input[type=checkbox]{margin-right:10px;accent-color:#58a6ff;width:16px;height:16px;flex-shrink:0}\n.book-item .info{flex:1;min-width:0}\n.book-item .title{font-size:14px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n.book-item .author{font-size:12px;color:#8b949e;margin-top:2px}\n.book-item .cat-tag{font-size:11px;color:#58a6ff;background:#1c2333;padding:2px 6px;border-radius:4px;margin-left:8px;flex-shrink:0}\n.actions{display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap;align-items:center}\n.btn{padding:10px 20px;border-radius:8px;border:none;font-size:14px;font-weight:600;cursor:pointer;transition:all .2s}\n.btn-primary{background:#238636;color:#fff}\n.btn-primary:hover:not(:disabled){background:#2ea043}\n.btn-secondary{background:#1f6feb;color:#fff}\n.btn-secondary:hover:not(:disabled){background:#388bfd}\n.btn:disabled{opacity:.4;cursor:not-allowed}\n.btn-loading{background:#484f58!important;color:#fff!important;pointer-events:none}\n.selected-info{font-size:13px;color:#8b949e;flex:1}\n\n/* MP Channel Styles */\n.mp-cat-tabs{display:flex;gap:8px;margin-bottom:16px;overflow-x:auto;padding-bottom:8px;-webkit-overflow-scrolling:touch}\n.mp-cat-tabs::-webkit-scrollbar{height:0}\n.mp-cat-tab{padding:8px 16px;border-radius:20px;font-size:13px;font-weight:500;cursor:pointer;white-space:nowrap;background:#161b22;border:1px solid #30363d;color:#8b949e;transition:all .2s}\n.mp-cat-tab:hover{color:#e6edf3;border-color:#58a6ff}\n.mp-cat-tab.active{background:#1f6feb33;border-color:#58a6ff;color:#58a6ff}\n\n.mp-layout{display:flex;gap:12px;height:65vh;min-height:400px}\n.mp-account-list{width:280px;flex-shrink:0;border:1px solid #30363d;border-radius:8px;background:#161b22;overflow-y:auto}\n.mp-account-item{display:flex;align-items:center;padding:12px;border-bottom:1px solid #21262d;cursor:pointer;transition:background .15s}\n.mp-account-item:hover{background:#1c2333}\n.mp-account-item.active{background:#1c2333;border-left:3px solid #58a6ff}\n.mp-account-item:last-child{border-bottom:none}\n.mp-account-cover{width:40px;height:40px;border-radius:8px;object-fit:cover;margin-right:10px;flex-shrink:0;background:#21262d}\n.mp-account-info{flex:1;min-width:0}\n.mp-account-name{font-size:14px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n.mp-star-btn{cursor:pointer;font-size:16px;margin-left:6px;flex-shrink:0;opacity:.3;transition:opacity .2s}\n.mp-star-btn.starred{opacity:1}\n.mp-account-update{font-size:11px;color:#8b949e;margin-top:2px}\n.mp-article-panel{flex:1;border:1px solid #30363d;border-radius:8px;background:#161b22;overflow-y:auto;padding:16px}\n.mp-empty{display:flex;align-items:center;justify-content:center;height:100%;color:#484f58;font-size:14px;text-align:center}\n.mp-account-header{display:flex;align-items:center;margin-bottom:16px;padding-bottom:12px;border-bottom:1px solid #21262d}\n.mp-account-header-cover{width:48px;height:48px;border-radius:10px;object-fit:cover;margin-right:12px;background:#21262d}\n.mp-account-header-name{font-size:16px;font-weight:600;color:#e6edf3}\n.mp-account-header-meta{font-size:12px;color:#8b949e;margin-top:2px}\n.article-item{display:flex;align-items:center;padding:14px 0;border-bottom:1px solid #21262d}\n.article-item:last-child{border-bottom:none}\n.article-date{font-size:12px;color:#8b949e;margin-bottom:4px}\n.article-title{font-size:14px;font-weight:500;color:#e6edf3;flex:1;margin-right:12px;line-height:1.4}\n.article-meta{font-size:12px;color:#8b949e;margin-top:4px}\n.btn-read{padding:6px 16px;background:#1f6feb;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:500;white-space:nowrap;flex-shrink:0;transition:background .2s}\n.btn-read:hover{background:#388bfd}\n.btn-read-inapp{padding:6px 16px;background:#238636;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;font-weight:500;white-space:nowrap;flex-shrink:0;transition:background .2s}\n.btn-read-inapp:hover{background:#2ea043}\n.article-list-scroll{max-height:calc(65vh - 100px);overflow-y:auto}\n\n/* MP Back Bar (mobile) */\n.mp-back-bar{display:none;align-items:center;padding:10px 16px;background:#161b22;border:1px solid #30363d;border-radius:8px;margin-bottom:12px;cursor:pointer}\n.mp-back-bar:active{background:#1c2333}\n.mp-back-arrow{font-size:18px;color:#58a6ff;margin-right:8px}\n.mp-back-text{font-size:14px;color:#e6edf3}\n\n/* Mobile Responsive */\n@media(max-width:768px){\n  .container{padding:12px}\n  h1{font-size:18px}\n  .mp-layout{flex-direction:column;height:auto}\n  .mp-account-list{width:100%;max-height:50vh;border:1px solid #30363d;border-radius:8px;background:#161b22}\n  .mp-article-panel{border:1px solid #30363d;border-radius:8px;background:#161b22;padding:12px;min-height:40vh}\n  .mp-back-bar{display:flex}\n  .mp-view-list .mp-account-list{display:block}\n  .mp-view-list .mp-article-panel{display:none}\n  .mp-view-article .mp-account-list{display:none}\n  .mp-view-article .mp-article-panel{display:block}\n  .article-list-scroll{max-height:60vh}\n  .mp-account-item{padding:14px}\n  .mp-account-name{font-size:15px}\n  .mp-account-header{flex-wrap:wrap}\n  .article-item{flex-direction:column;align-items:flex-start;gap:6px}\n  .btn-read,.btn-read-inapp{align-self:flex-end}\n}\n\n/* Results Section */\n.results-section{border-top:1px solid #30363d;padding-top:16px;margin-top:8px}\n.results-header{font-size:16px;font-weight:600;margin-bottom:12px;color:#58a6ff}\n.results-list{border:1px solid #30363d;border-radius:8px;background:#161b22;max-height:40vh;overflow-y:auto}\n.result-item{display:flex;align-items:center;padding:12px 14px;border-bottom:1px solid #21262d}\n.result-item:last-child{border-bottom:none}\n.result-info{flex:1;min-width:0}\n.result-title{font-size:14px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n.result-meta{font-size:12px;color:#8b949e;margin-top:2px}\n.result-type{display:inline-block;font-size:11px;padding:2px 6px;border-radius:4px;margin-right:6px}\n.type-overview{background:#1f6feb33;color:#58a6ff}\n.type-collision{background:#8957e533;color:#a371f7}\n.btn-view{padding:6px 12px;background:#30363d;color:#e6edf3;border:none;border-radius:6px;cursor:pointer;font-size:13px;margin-left:6px;flex-shrink:0}\n.btn-view:hover{background:#484f58}\n.btn-delete{padding:6px 10px;background:#da3633;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:12px;margin-left:4px;flex-shrink:0}\n.btn-delete:hover{background:#f85149}\n.empty{text-align:center;padding:30px;color:#8b949e;font-size:14px}\n\n/* Loading Overlay */\n.loading-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(13,17,23,.92);display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:1000}\n.loading-overlay.hidden{display:none}\n.spinner{width:40px;height:40px;border:3px solid #30363d;border-top-color:#58a6ff;border-radius:50%;animation:spin 1s linear infinite}\n@keyframes spin{to{transform:rotate(360deg)}}\n.loading-text{margin-top:16px;color:#8b949e;font-size:14px}\n.loading-detail{margin-top:8px;color:#484f58;font-size:12px}\n\n/* Reading Page */\n.reading-page{position:fixed;top:0;left:0;right:0;bottom:0;background:#0d1117;z-index:999;overflow-y:auto;display:none}\n.reading-header{position:sticky;top:0;background:#161b22;padding:12px 16px;border-bottom:1px solid #30363d;display:flex;align-items:center;z-index:10}\n.btn-back{padding:6px 12px;background:#30363d;color:#e6edf3;border:none;border-radius:6px;cursor:pointer;font-size:13px;margin-right:12px;flex-shrink:0}\n.btn-back:hover{background:#484f58}\n.reading-title{font-size:16px;font-weight:600;color:#58a6ff;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}\n.reading-content{padding:20px 16px;line-height:1.8;font-size:15px;max-width:800px;margin:0 auto;padding-bottom:60px}\n.reading-content h1{font-size:20px;color:#58a6ff;margin:24px 0 12px;border-bottom:1px solid #21262d;padding-bottom:8px}\n.reading-content h2{font-size:17px;color:#79c0ff;margin:20px 0 10px}\n.reading-content h3{font-size:15px;color:#a5d6ff;margin:16px 0 8px}\n.reading-content p{margin:10px 0}\n.reading-content blockquote{border-left:3px solid #58a6ff;padding:8px 16px;margin:12px 0;background:#161b22;border-radius:0 6px 6px 0;color:#8b949e}\n.reading-content strong{color:#f0f6fc}\n.reading-content hr{border:none;border-top:1px solid #21262d;margin:20px 0}\n.reading-content ul{margin:10px 0;padding-left:24px}\n.reading-content li{margin:4px 0}\n\n/* Chat Panel */\n.chat-panel{position:fixed;bottom:0;left:0;right:0;background:#161b22;border-top:1px solid #30363d;z-index:1001;transition:transform .3s ease;transform:translateY(calc(100% - 44px))}\n.chat-panel.expanded{transform:translateY(0)}\n.chat-toggle{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;cursor:pointer;user-select:none;border-bottom:1px solid #21262d}\n.chat-toggle-title{font-size:14px;font-weight:600;color:#58a6ff}\n.chat-toggle-hint{font-size:12px;color:#8b949e}\n.chat-messages{height:40vh;overflow-y:auto;padding:12px 16px;display:flex;flex-direction:column;gap:10px}\n.chat-msg{max-width:85%;padding:10px 14px;border-radius:12px;font-size:14px;line-height:1.6;word-break:break-word}\n.chat-msg.user{align-self:flex-end;background:#1f6feb;color:#fff;border-bottom-right-radius:4px}\n.chat-msg.assistant{align-self:flex-start;background:#21262d;color:#e6edf3;border-bottom-left-radius:4px}\n.chat-msg.assistant h1,.chat-msg.assistant h2,.chat-msg.assistant h3{font-size:14px;margin:8px 0 4px;color:#79c0ff}\n.chat-msg.assistant strong{color:#f0f6fc}\n.chat-msg.assistant p{margin:4px 0}\n.chat-msg.assistant ul{margin:4px 0;padding-left:18px}\n.chat-msg.loading{background:#21262d;color:#8b949e;font-style:italic}\n.chat-input-area{display:flex;gap:8px;padding:10px 16px;border-top:1px solid #21262d}\n.chat-input{flex:1;background:#0d1117;border:1px solid #30363d;color:#e6edf3;padding:10px 14px;border-radius:8px;font-size:14px;resize:none;outline:none;min-height:40px;max-height:80px;font-family:inherit}\n.chat-input:focus{border-color:#58a6ff}\n.chat-send{padding:10px 16px;background:#238636;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:14px;font-weight:600;flex-shrink:0}\n.chat-send:hover:not(:disabled){background:#2ea043}\n.chat-send:disabled{opacity:.4;cursor:not-allowed}\n.chat-clear{padding:10px 12px;background:#30363d;color:#e6edf3;border:none;border-radius:8px;cursor:pointer;font-size:13px;flex-shrink:0}\n.chat-clear:hover{background:#484f58}\n\n/* MP article card */\n.article-card{background:#0d1117;border:1px solid #21262d;border-radius:8px;padding:12px;margin-bottom:12px;cursor:pointer;transition:border-color .2s}\n.article-card:hover{border-color:#30363d}\n.article-card-cover{width:100%;height:160px;object-fit:cover;border-radius:6px;margin-bottom:8px;background:#161b22}\n.article-card-title{font-size:14px;font-weight:500;line-height:1.5;margin-bottom:6px}\n.article-card-meta{font-size:12px;color:#8b949e}\n\u003c/style\u003e\n\u003c/head\u003e\n\u003cbody\u003e\n\u003cdiv class=\"container\"\u003e\n  \u003c!-- Channel Tabs --\u003e\n  \u003cdiv class=\"channel-tabs\"\u003e\n    \u003cdiv class=\"channel-tab active\" data-channel=\"books\" onclick=\"switchChannel('books')\"\u003e📚 书籍\u003c/div\u003e\n    \u003cdiv class=\"channel-tab\" data-channel=\"mp\" onclick=\"switchChannel('mp')\"\u003e 公众号\u003c/div\u003e\n  \u003c/div\u003e\n\n  \u003c!-- Book Channel --\u003e\n  \u003cdiv id=\"bookChannel\"\u003e\n    \u003ch1\u003e📚 书籍快览\u003c/h1\u003e\n    \u003cp class=\"sub\"\u003e你的微信读书书架 · \u003cspan id=\"bookCountText\"\u003e677\u003c/span\u003e 本原生书籍\u003c/p\u003e\n    \u003cdiv class=\"controls\"\u003e\n      \u003cinput type=\"text\" id=\"search\" placeholder=\"搜索书名或作者...\" oninput=\"filterBooks()\"\u003e\n      \u003cselect id=\"catFilter\" onchange=\"filterBooks()\"\u003e\u003coption value=\"\"\u003e全部分类\u003c/option\u003e\u003c/select\u003e\n      \u003cbutton class=\"btn btn-secondary\" style=\"flex:0;min-width:auto;padding:8px 14px;font-size:13px\" onclick=\"syncBookshelf()\"\u003e同步书架\u003c/button\u003e\n    \u003c/div\u003e\n    \u003cdiv class=\"counter\" id=\"counter\"\u003e\u003c/div\u003e\n    \u003cdiv class=\"book-list\" id=\"bookList\"\u003e\u003c/div\u003e\n    \u003cdiv class=\"actions\"\u003e\n      \u003cbutton class=\"btn btn-primary\" id=\"btnOverview\" onclick=\"startOverview()\" disabled\u003e📖 生成速览\u003c/button\u003e\n      \u003cbutton class=\"btn btn-secondary\" id=\"btnCollision\" onclick=\"startCollision()\" disabled\u003e💥 书籍碰撞\u003c/button\u003e\n      \u003cspan class=\"selected-info\" id=\"selectedInfo\"\u003e选择书籍开始\u003c/span\u003e\n    \u003c/div\u003e\n    \u003cdiv class=\"results-section\"\u003e\n      \u003cdiv class=\"results-header\"\u003e📋 生成记录\u003c/div\u003e\n      \u003cdiv class=\"results-list\" id=\"resultsList\"\u003e\u003cdiv class=\"empty\"\u003e还没有生成记录\u003cbr\u003e选择书籍开始你的第一次速览或碰撞\u003c/div\u003e\u003c/div\u003e\n    \u003c/div\u003e\n  \u003c/div\u003e\n\n  \u003c!-- MP Channel --\u003e\n  \u003cdiv id=\"mpChannel\" style=\"display:none\"\u003e\n    \u003ch1\u003e 公众号速览\u003c/h1\u003e\n    \u003cp class=\"sub\"\u003e你的微信读书公众号 · \u003cspan id=\"mpCountText\"\u003e0\u003c/span\u003e 个\u003c/p\u003e\n    \u003cdiv class=\"mp-cat-tabs\" id=\"mpCatTabs\"\u003e\u003c/div\u003e\n    \u003cdiv class=\"mp-layout mp-view-list\" id=\"mpLayout\"\u003e\n      \u003cdiv class=\"mp-back-bar\" id=\"mpBackBar\" onclick=\"mpBackToList()\"\u003e\n        \u003cspan class=\"mp-back-arrow\"\u003e\u2039\u003c/span\u003e\n        \u003cspan class=\"mp-back-text\"\u003e\u8fd4\u56de\u5217\u8868\u003c/span\u003e\n      \u003c/div\u003e\n      \u003cdiv class=\"mp-account-list\" id=\"mpAccountList\"\u003e\n        \u003cdiv class=\"mp-empty\"\u003e请先选择一个分类\u003c/div\u003e\n      \u003c/div\u003e\n      \u003cdiv class=\"mp-article-panel\" id=\"mpArticlePanel\"\u003e\n        \u003cdiv class=\"mp-empty\"\u003e点击公众号名称\u003cbr\u003e查看最近文章\u003c/div\u003e\n      \u003c/div\u003e\n    \u003c/div\u003e\n  \u003c/div\u003e\n\u003c/div\u003e\n\n\u003c!-- Reading Page --\u003e\n\u003cdiv class=\"reading-page\" id=\"readingPage\"\u003e\n  \u003cdiv class=\"reading-header\"\u003e\n    \u003cbutton class=\"btn-back\" onclick=\"closeReading()\"\u003e← 返回\u003c/button\u003e\n    \u003cdiv class=\"reading-title\" id=\"readingTitle\"\u003e\u003c/div\u003e\n  \u003c/div\u003e\n  \u003cdiv class=\"reading-content\" id=\"readingContent\"\u003e\u003c/div\u003e\n  \u003cdiv class=\"chat-panel\" id=\"chatPanel\"\u003e\n    \u003cdiv class=\"chat-toggle\" onclick=\"toggleChat()\"\u003e\n      \u003cspan class=\"chat-toggle-title\"\u003e💬 与 AI 对话\u003c/span\u003e\n      \u003cspan class=\"chat-toggle-hint\" id=\"chatToggleHint\"\u003e▲ 展开\u003c/span\u003e\n    \u003c/div\u003e\n    \u003cdiv class=\"chat-messages\" id=\"chatMessages\"\u003e\n      \u003cdiv class=\"chat-msg assistant\"\u003e基于这篇分析内容，向我提问吧。可以继续深入探讨任何观点。\u003c/div\u003e\n    \u003c/div\u003e\n    \u003cdiv class=\"chat-input-area\"\u003e\n      \u003ctextarea class=\"chat-input\" id=\"chatInput\" placeholder=\"输入你的问题...\" rows=\"1\" onkeydown=\"chatKeydown(event)\"\u003e\u003c/textarea\u003e\n      \u003cbutton class=\"chat-clear\" onclick=\"clearChat()\"\u003e清空\u003c/button\u003e\n      \u003cbutton class=\"chat-send\" id=\"chatSendBtn\" onclick=\"sendChat()\"\u003e发送\u003c/button\u003e\n    \u003c/div\u003e\n  \u003c/div\u003e\n\u003c/div\u003e\n\n\u003c!-- Loading Overlay --\u003e\n\u003cdiv class=\"loading-overlay hidden\" id=\"loadingOverlay\"\u003e\n  \u003cdiv class=\"spinner\"\u003e\u003c/div\u003e\n  \u003cdiv class=\"loading-text\" id=\"loadingText\"\u003e正在生成...\u003c/div\u003e\n  \u003cdiv class=\"loading-detail\" id=\"loadingDetail\"\u003e\u003c/div\u003e\n\u003c/div\u003e\n\n\u003cscript\u003e\nvar WORKER_URL = location.origin;\nvar currentChannel = 'books';\n\n// ===== Channel Switching =====\nfunction saveState() {\n  try { localStorage.setItem('wr_channel', currentChannel); if (currentChannel === 'mp' && mpCurrentCat) { localStorage.setItem('wr_mp_cat', mpCurrentCat); } } catch(e) {}\n}\n\nfunction switchChannel(ch) {\n  currentChannel = ch;\n  document.querySelectorAll('.channel-tab').forEach(function(t) {\n    t.classList.toggle('active', t.dataset.channel === ch);\n  });\n  document.getElementById('bookChannel').style.display = ch === 'books' ? 'block' : 'none';\n  document.getElementById('mpChannel').style.display = ch === 'mp' ? 'block' : 'none';\n  saveState();\n  if (ch === 'mp' \u0026\u0026 !mpInitialized) {\n    loadMpAccounts();\n  }\n}\n\n// ===== Book Channel Data =====\nvar allBooks=[],selected=new Set(),results=JSON.parse(localStorage.getItem('wr_results')||'[]');\nvar _kvSyncTimer=null;\n\n// === KV Sync ===\nfunction kvLoadResults(){\n  return fetch(WORKER_URL+'/kv/load').then(function(r){return r.json()}).then(function(d){\n    if(d.ok \u0026\u0026 Array.isArray(d.results)){\n      var remote=d.results;\n      if(remote.length\u003e0){\n        results=remote;\n        localStorage.setItem('wr_results',JSON.stringify(results));\n        renderResults();\n      }\n    }\n  }).catch(function(){});\n}\nfunction kvSaveResults(){\n  if(_kvSyncTimer) clearTimeout(_kvSyncTimer);\n  _kvSyncTimer=setTimeout(function(){\n    fetch(WORKER_URL+'/kv/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({results:results})})\n    .then(function(r){return r.json()}).then(function(d){\n      if(d.ok \u0026\u0026 Array.isArray(d.results)){results=d.results;localStorage.setItem('wr_results',JSON.stringify(results));renderResults();}\n    }).catch(function(){});\n  },1000);\n}\nfunction kvDeleteResult(id){\n  return fetch(WORKER_URL+'/kv/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:id})})\n  .then(function(r){return r.json()}).then(function(d){\n    if(d.ok){results=d.results;localStorage.setItem('wr_results',JSON.stringify(results));renderResults();}\n  }).catch(function(){});\n}\nkvLoadResults();\n\n// Book categories\nvar CATS={\"个人成长-人在职场\":[{\"t\":\"中年觉醒：重塑生命与生活的力量\",\"a\":\"[美]阿瑟·C.布鲁克斯\"},{\"t\":\"精力管理\",\"a\":\"吉姆·洛尔 托尼·施瓦茨\"},{\"t\":\"麦肯锡思考工具\",\"a\":\"大岛祥誉\"},{\"t\":\"结构表达力：高频场景下的职场表达解决方案\",\"a\":\"李忠秋 齐海林 张学敏 等\"},{\"t\":\"远见（湛庐经典）\",\"a\":\"布赖恩·费瑟斯通豪\"}],\"个人成长-人生哲学\":[{\"t\":\"少有人走的路：心智成熟的旅程\",\"a\":\"M.斯科特·派克\"},{\"t\":\"你要如何衡量你的人生：舒适阅读版\",\"a\":\"[美]克莱顿·克里斯坦森等\"},{\"t\":\"成长的边界\",\"a\":\"大卫·爱泼斯坦\"},{\"t\":\"小学问：解决你的7种人生焦虑\",\"a\":\"黄执中等\"},{\"t\":\"静观自我关怀：勇敢爱自己的51项练习\",\"a\":\"[美]克里斯汀·内夫 [美]克里斯托弗·杰默\"},{\"t\":\"反脆弱：从不确定性中获益\",\"a\":\"纳西姆·尼古拉斯·塔勒布\"},{\"t\":\"隐藏的潜能\",\"a\":\"[美]亚当·格兰特\"},{\"t\":\"活出心花怒放的人生\",\"a\":\"彭凯平 闫伟\"},{\"t\":\"刻意练习：如何从新手到大师\",\"a\":\"[美]安德斯·艾利克森 [英]罗伯特·普尔\"},{\"t\":\"谢谢，但今天不行\",\"a\":\"科尔杜拉·努斯鲍姆\"},{\"t\":\"活明白的学问\",\"a\":\"姚洋\"},{\"t\":\"假装有趣：并购专家的\\\"并购\\\"生活法\",\"a\":\"劳阿毛\"},{\"t\":\"创意行为：存在即答案\",\"a\":\"[美]里克·鲁宾\"},{\"t\":\"越简单，越美好：北欧的极简主义生活\",\"a\":\"罗敷\"},{\"t\":\"最优解人生\",\"a\":\"比尔·帕金斯\"},{\"t\":\"向上生长\",\"a\":\"九边\"},{\"t\":\"断舍离\",\"a\":\"山下英子\"},{\"t\":\"离经叛道：不按常理出牌的人如何改变世界\",\"a\":\"亚当·格兰特\"},{\"t\":\"内在动机：自主掌控人生的力量\",\"a\":\"爱德华·L.德西 理查德·弗拉斯特\"}],\"个人成长-励志成长\":[{\"t\":\"自我决定的生活\",\"a\":\"[美]托马斯·斯坦利\"},{\"t\":\"宝贵的人生建议\",\"a\":\"[美]凯文·凯利\"},{\"t\":\"逆商：我们该如何应对坏事件\",\"a\":\"保罗·史托兹\"},{\"t\":\"终身成长（全新修订版）\",\"a\":\"卡罗尔·德韦克\"},{\"t\":\"穷查理宝典：查理·芒格智慧箴言录（全新增订本）\",\"a\":\"彼得·考夫曼\"},{\"t\":\"当下的力量（白金版）\",\"a\":\"埃克哈特·托利\"}],\"个人成长-情绪心灵\":[{\"t\":\"世界上最幸运的人\",\"a\":\"咏给·明就仁波切\"},{\"t\":\"正念：此刻是一枝花\",\"a\":\"卡巴金\"},{\"t\":\"自我关怀的力量\",\"a\":\"克里斯廷·内夫\"},{\"t\":\"高效休息法：世界精英这样放松大脑（实操练习版）\",\"a\":\"久贺谷亮\"},{\"t\":\"与神对话.1\",\"a\":\"尼尔·唐纳德·沃尔什\"},{\"t\":\"当下的力量实践手册（白金版）\",\"a\":\"埃克哈特·托利\"}],\"个人成长-沟通表达\":[{\"t\":\"亲密关系\",\"a\":\"克里斯多福·孟\"},{\"t\":\"李诞工作手册（万字全新增订）\",\"a\":\"李诞\"},{\"t\":\"哈佛经典谈判术：你一开口就赢麻了\",\"a\":\"[美]迪帕克·马尔霍特拉 [美]马克斯·巴泽曼\"},{\"t\":\"即兴表达\",\"a\":\"王达峰\"},{\"t\":\"好好说话2：简单有效的高情商沟通术\",\"a\":\"马薇薇 黄执中 周玄毅 邱晨 胡渐彪\"},{\"t\":\"好好说话：新鲜有趣的话术精进技巧\",\"a\":\"马东出品 马薇薇 黄执中 周玄毅等\"},{\"t\":\"关键对话：如何高效能沟通（原书第2版）\",\"a\":\"[美]科里·帕特森 [美]约瑟夫·格雷尼 [美]罗恩·麦克米兰 [美]艾尔·史威茨勒\"},{\"t\":\"非暴力沟通\",\"a\":\"马歇尔·卢森堡\"},{\"t\":\"学会提问（原书第12版）\",\"a\":\"尼尔·布朗 斯图尔特·基利\"},{\"t\":\"可复制的沟通力：樊登的10堂表达课\",\"a\":\"樊登\"},{\"t\":\"即兴演讲：掌控人生关键时刻\",\"a\":\"朱迪思·汉弗莱\"}],\"个人成长-认知思维\":[{\"t\":\"内向优势：性格内向者的潜在竞争力\",\"a\":\"神农祐树\"},{\"t\":\"学习学习：快速变强四步法\",\"a\":\"王专\"},{\"t\":\"高效能人士的七个习惯（30周年纪念版）（全新增订版）\",\"a\":\"史蒂芬·柯维\"},{\"t\":\"思考，快与慢\",\"a\":\"丹尼尔·卡尼曼\"},{\"t\":\"毛选的底层逻辑：看透本质的思维框架\",\"a\":\"周鸿仙\"},{\"t\":\"麦肯锡结构化战略思维：如何想清楚、说明白、做到位\",\"a\":\"周国元\"},{\"t\":\"模型思维：数学模型解构大模型黑箱\",\"a\":\"[美]斯科特·佩奇\"}],\"人物传记-传记综合\":[{\"t\":\"活过\",\"a\":\"[新加坡]蔡澜\"},{\"t\":\"天生有罪\",\"a\":\"特雷弗·诺亚\"},{\"t\":\"成为我自己：欧文·亚隆回忆录\",\"a\":\"[美]欧文·D.亚隆\"},{\"t\":\"我看见的世界：李飞飞自传\",\"a\":\"[美]李飞飞\"},{\"t\":\"编年史：鲍勃·迪伦\",\"a\":\"鲍勃·迪伦\"},{\"t\":\"颠覆者：周鸿祎自传\",\"a\":\"周鸿祎 范海涛\"},{\"t\":\"与爱同行：周冠宇的F1逐梦路（独家首发）\",\"a\":\"姜晓颖\"},{\"t\":\"我的世界观\",\"a\":\"阿尔伯特·爱因斯坦\"},{\"t\":\"趁着年轻，我偏要勉强\",\"a\":\"詹青云\"},{\"t\":\"我的职业是小说家\",\"a\":\"[日]村上春树\"},{\"t\":\"人生赛局\",\"a\":\"玛丽亚·康尼科娃\"},{\"t\":\"人类群星闪耀时（读客三个圈经典文库）\",\"a\":\"茨威格\"},{\"t\":\"人类群星闪耀时（果麦经典）\",\"a\":\"[奥]斯蒂芬·茨威格\"}],\"人物传记-军政领袖\":[{\"t\":\"丘吉尔传：与命运同行\",\"a\":\"安德鲁·罗伯茨\"},{\"t\":\"历史转折中的邓小平（同名电视剧原著）\",\"a\":\"龙平平 黄亚洲 张强 魏人\"}],\"人物传记-历史人物\":[{\"t\":\"李叔同传：从风华才子到云水高僧\",\"a\":\"汪兆骞\"},{\"t\":\"杜甫传\",\"a\":\"冯至\"}],\"人物传记-女性人物\":[{\"t\":\"人生由我\",\"a\":\"梅耶·马斯克\"},{\"t\":\"宋庆龄：20世纪的伟大女性（全2册）\",\"a\":\"伊斯雷尔·爱泼斯坦\"},{\"t\":\"向前一步\",\"a\":\"谢丽尔·桑德伯格\"}],\"人物传记-娱乐明星\":[{\"t\":\"生活的艺术家\",\"a\":\"李小龙\"},{\"t\":\"梅西传奇\",\"a\":\"张佳玮\"},{\"t\":\"乔丹传\",\"a\":\"罗兰·拉赞比\"},{\"t\":\"曼巴精神：科比自传\",\"a\":\"科比·布莱恩特\"}],\"人物传记-学者\":[{\"t\":\"陈寅恪的最后二十年\",\"a\":\"陆键东\"},{\"t\":\"王赓武回忆录（上下卷合集）\",\"a\":\"[新加坡]王赓武 林娉婷\"}],\"人物传记-文学家\":[{\"t\":\"苏东坡传（最新修订版）\",\"a\":\"林语堂\"},{\"t\":\"曾国藩传\",\"a\":\"张宏杰\"},{\"t\":\"王阳明大传：知行合一的心学智慧（全新修订版）\",\"a\":\"[日]冈田武彦\"}],\"人物传记-商业人物\":[{\"t\":\"鞋狗：耐克创始人菲尔·奈特亲笔自传\",\"a\":\"[美]菲尔·奈特\"},{\"t\":\"史蒂夫·乔布斯传\",\"a\":\"[美]沃尔特·艾萨克森\"},{\"t\":\"埃隆·马斯克传\",\"a\":\"[美]沃尔特·艾萨克森\"},{\"t\":\"滚雪球：巴菲特和他的财富人生（珍藏版）\",\"a\":\"[美]艾丽斯·施罗德\"},{\"t\":\"格鲁夫给经理人的第一课\",\"a\":\"[美]安迪·格鲁夫\"},{\"t\":\"创新者的窘境\",\"a\":\"[美]克莱顿·克里斯坦森\"},{\"t\":\"只有偏执狂才能生存：特种部队参谋的领导力秘诀\",\"a\":\"[美]安迪·格鲁夫\"},{\"t\":\"富甲美国：零售大王沃尔顿自传\",\"a\":\"[美]萨姆·沃尔顿 [美]约翰·林伊\"},{\"t\":\"一生的旅程：迪士尼CEO的自述\",\"a\":\"[美]罗伯特·艾格 [美]乔尔·洛弗尔\"},{\"t\":\"将心注入：星巴克之父舒尔茨自传\",\"a\":\"[美]霍华德·舒尔茨 [美]多里·琼斯·扬\"}],\"人物传记-科学家\":[{\"t\":\"别闹了，费曼先生：科学顽童的故事\",\"a\":\"[美]理查德·费曼\"}],\"商业财经-商业综合\":[{\"t\":\"定位：争夺用户心智的战争（经典重译版）\",\"a\":\"[美]艾·里斯 [美]杰克·特劳特\"},{\"t\":\"好战略，坏战略\",\"a\":\"[美]理查德·鲁梅尔特\"},{\"t\":\"竞争优势：透视企业护城河\",\"a\":\"[美]布鲁斯·格林沃尔德 [美]贾德·卡恩\"},{\"t\":\"竞争战略\",\"a\":\"[美]迈克尔·波特\"},{\"t\":\"从0到1：开启商业与未来的秘密\",\"a\":\"[美]彼得·蒂尔 [美]布莱克·马斯特斯\"},{\"t\":\"蓝海战略（扩展版）\",\"a\":\"[韩]W.钱·金 [美]勒妮·莫博涅\"},{\"t\":\"战略历程：纵览战略管理学派（原书第2版）\",\"a\":\"[加]亨利·明茨伯格 [美]布鲁斯·阿尔斯特兰德 [加]约瑟夫·兰佩尔\"},{\"t\":\"战略：一部历史（全2册）\",\"a\":\"[英]劳伦斯·弗里德曼\"}],\"商业财经-管理\":[{\"t\":\"卓有成效的管理者（德鲁克管理经典）\",\"a\":\"[美]彼得·德鲁克\"},{\"t\":\"管理的常识：陈春花管理经典（全新修订版）\",\"a\":\"陈春花\"},{\"t\":\"组织行为学（第18版）\",\"a\":\"[美]斯蒂芬·罗宾斯 [美]蒂莫西·贾奇\"},{\"t\":\"领导力21法则：追随这些法则，人们就会追随你\",\"a\":\"[美]约翰·C.麦克斯维尔\"},{\"t\":\"基业长青\",\"a\":\"[美]吉姆·柯林斯 [美]杰里·波勒斯\"},{\"t\":\"重新定义团队：谷歌如何工作\",\"a\":\"[美]拉斯洛·博克\"}],\"商业财经-营销广告\":[{\"t\":\"一个广告人的自白\",\"a\":\"[美]大卫·奥格威\"},{\"t\":\"文案创作完全手册：文案撰稿人从入门到进阶\",\"a\":\"[美]罗伯特·布莱\"},{\"t\":\"影响力（全新升级版）\",\"a\":\"[美]罗伯特·西奥迪尼\"},{\"t\":\"疯传：让你的产品、思想、行为像病毒一样入侵\",\"a\":\"[美]乔纳·伯杰\"},{\"t\":\"增长黑客：如何低成本实现爆发式成长\",\"a\":\"[美]肖恩·埃利斯 [美]摩根·布朗\"}],\"商业财经-投资理财\":[{\"t\":\"聪明的投资者（原书第4版）\",\"a\":\"[美]本杰明·格雷厄姆\"},{\"t\":\"巴菲特致股东的信：股份公司教程\",\"a\":\"[美]沃伦·巴菲特 [美]劳伦斯·坎宁安\"},{\"t\":\"原则：应对变化中的世界秩序\",\"a\":\"[美]瑞·达利欧\"},{\"t\":\"原则：生活和工作\",\"a\":\"[美]瑞·达利欧\"},{\"t\":\"穷爸爸富爸爸：最新修订版\",\"a\":\"[美]罗伯特·清崎 [美]莎伦·莱希特\"}],\"商业财经-经济\":[{\"t\":\"国富论\",\"a\":\"亚当·斯密\"},{\"t\":\"薛兆丰经济学讲义\",\"a\":\"薛兆丰\"},{\"t\":\"经济学原理（第8版）：微观经济学分册\",\"a\":\"[美]N.格里高利·曼昆\"},{\"t\":\"经济学原理（第8版）：宏观经济学分册\",\"a\":\"[美]N.格里高利·曼昆\"},{\"t\":\"小岛经济学：鱼、美元和经济的故事\",\"a\":\"[美]彼得·D.希夫 [美]安德鲁·J.希夫\"}],\"商业财经-创业\":[{\"t\":\"精益创业：新创企业的成长思维\",\"a\":\"[美]埃里克·莱斯\"},{\"t\":\"创业维艰：如何完成比难更难的事\",\"a\":\"[美]本·霍洛维茨\"},{\"t\":\"启示录：打造用户热爱的产品（第2版）\",\"a\":\"[美]马蒂·卡根\"}],\"商业财经-职场技能\":[{\"t\":\"金字塔原理：思考、表达和解决问题的逻辑\",\"a\":\"[美]芭芭拉·明托\"},{\"t\":\"PPT演示之道（原书第2版）：写给非设计人员的幻灯片指南\",\"a\":\"[美]Christopher Voss\"},{\"t\":\"用数据讲故事\",\"a\":\"[美]科尔·努斯鲍默·纳福利克\"}],\"历史-中国古代\":[{\"t\":\"万历十五年\",\"a\":\"黄仁宇\"},{\"t\":\"明朝那些事儿（全集）\",\"a\":\"当年明月\"},{\"t\":\"大秦帝国（全新校订版·全6部17册）\",\"a\":\"孙皓晖\"},{\"t\":\"史记（精注全译·全6册）\",\"a\":\"司马迁\"},{\"t\":\"资治通鉴（文白对照全译本·全4册）\",\"a\":\"司马光\"}],\"历史-中国近现代\":[{\"t\":\"天朝的崩溃：鸦片战争再研究（修订版）\",\"a\":\"茅海建\"},{\"t\":\"近代中国社会的新陈代谢\",\"a\":\"陈旭麓\"},{\"t\":\"邓小平时代\",\"a\":\"[美]傅高义\"}],\"历史-世界古代\":[{\"t\":\"人类简史：从动物到上帝\",\"a\":\"[以]尤瓦尔·赫拉利\"}],\"历史-世界近现代\":[{\"t\":\"枪炮、病菌与钢铁：人类社会的命运（修订版）\",\"a\":\"[美]贾雷德·戴蒙德\"},{\"t\":\"第三帝国的兴亡：纳粹德国史（全4册）\",\"a\":\"[美]威廉·夏伊勒\"},{\"t\":\"第二次世界大战史（全5册）\",\"a\":\"[英]利德尔·哈特\"},{\"t\":\"光荣与梦想：1932-1972年美国叙事史（精装套装共4册）\",\"a\":\"[美]威廉·曼彻斯特\"}],\"历史-历史综合\":[{\"t\":\"历史深处的忧虑：近距离看美国之一\",\"a\":\"林达\"},{\"t\":\"总统是靠不住的：近距离看美国之二\",\"a\":\"林达\"},{\"t\":\"我也有一个梦想：近距离看美国之三\",\"a\":\"林达\"},{\"t\":\"如彗星划过夜空：近距离看美国之四\",\"a\":\"林达\"}],\"哲学-哲学综合\":[{\"t\":\"苏菲的世界\",\"a\":\"[挪]乔斯坦·贾德\"},{\"t\":\"哲学·科学·常识\",\"a\":\"陈嘉映\"},{\"t\":\"中国哲学简史\",\"a\":\"冯友兰\"}],\"哲学-西方哲学\":[{\"t\":\"理想国\",\"a\":\"柏拉图\"},{\"t\":\"存在与时间\",\"a\":\"[德]马丁·海德格尔\"},{\"t\":\"查拉图斯特拉如是说\",\"a\":\"[德]弗里德里希·尼采\"},{\"t\":\"悲剧的诞生\",\"a\":\"[德]弗里德里希·尼采\"}],\"哲学-中国哲学\":[{\"t\":\"论语\",\"a\":\"孔子\"},{\"t\":\"道德经\",\"a\":\"老子\"},{\"t\":\"庄子\",\"a\":\"庄周\"},{\"t\":\"传习录\",\"a\":\"王阳明\"}],\"哲学-伦理学\":[{\"t\":\"公正：该如何做是好？\",\"a\":\"[美]迈克尔·桑德尔\"}],\"文学-小说\":[{\"t\":\"百年孤独\",\"a\":\"[哥伦比亚]加西亚·马尔克斯\"},{\"t\":\"活着\",\"a\":\"余华\"},{\"t\":\"围城\",\"a\":\"钱锺书\"},{\"t\":\"三体（全集）\",\"a\":\"刘慈欣\"},{\"t\":\"红楼梦\",\"a\":\"曹雪芹\"},{\"t\":\"1984\",\"a\":\"[英]乔治·奥威尔\"},{\"t\":\"动物农场\",\"a\":\"[英]乔治·奥威尔\"}],\"文学-散文随笔\":[{\"t\":\"朝花夕拾\",\"a\":\"鲁迅\"},{\"t\":\"我与地坛\",\"a\":\"史铁生\"}],\"文学-诗歌\":[{\"t\":\"海子的诗\",\"a\":\"海子\"}],\"文学-外国文学\":[{\"t\":\"挪威的森林\",\"a\":\"[日]村上春树\"},{\"t\":\"小王子\",\"a\":\"[法]安托万·德·圣-埃克苏佩里\"}],\"社科-社会学\":[{\"t\":\"乡土中国\",\"a\":\"费孝通\"},{\"t\":\"乌合之众：大众心理研究\",\"a\":\"[法]古斯塔夫·勒庞\"},{\"t\":\"社会学的想象力\",\"a\":\"[美]C.赖特·米尔斯\"}],\"社科-心理学\":[{\"t\":\"被讨厌的勇气：\\\"自我启发之父\\\"阿德勒的哲学课\",\"a\":\"[日]岸见一郎 [日]古贺史健\"},{\"t\":\"蛤蟆先生去看心理医生\",\"a\":\"[英]罗伯特·戴博德\"},{\"t\":\"也许你该找个人聊聊\",\"a\":\"[美]洛莉·戈特利布\"}],\"社科-政治学\":[{\"t\":\"论中国\",\"a\":\"[美]亨利·基辛格\"},{\"t\":\"旧制度与大革命\",\"a\":\"[法]托克维尔\"}],\"社科-人类学\":[{\"t\":\"菊与刀\",\"a\":\"[美]鲁思·本尼迪克特\"}],\"艺术-摄影\":[{\"t\":\"摄影笔记\",\"a\":\"宁思潇潇\"},{\"t\":\"新摄影笔记\",\"a\":\"宁思潇潇\"}],\"艺术-理论\":[{\"t\":\"世界现代设计史（第二版）\",\"a\":\"王受之\"},{\"t\":\"对立之美：西方艺术500年\",\"a\":\"严伯钧\"}],\"艺术-绘画\":[{\"t\":\"梵高手稿\",\"a\":\"文森特·梵高\"}],\"艺术-设计\":[{\"t\":\"写给大家看的设计书（第4版）\",\"a\":\"Robin Williams\"}],\"艺术-音乐\":[{\"t\":\"人人都该懂的古典音乐\",\"a\":\"朱利安·约翰逊\"}],\"计算机-人工智能\":[{\"t\":\"扣子（Coze）Skills+OpenClaw 实战：零基础玩转 AI 智能体\",\"a\":\"邢云阳 著\"}],\"计算机-图像视频\":[{\"t\":\"轻松玩转手机短视频：视频拍摄与剪辑必学的7堂课\",\"a\":\"杨精坤编著\"}],\"计算机-数据库\":[{\"t\":\"实现领域驱动设计\",\"a\":\"沃恩·弗农\"},{\"t\":\"在你身边为你设计Ⅲ：腾讯服务设计思维与实战\",\"a\":\"腾讯公司用户研究与体验设计部\"},{\"t\":\"精益数据分析\",\"a\":\"阿利斯泰尔·克罗尔 本杰明·尤科维奇\"}],\"计算机-理论知识\":[{\"t\":\"爱上单片机（第4版）\",\"a\":\"杜洋\"},{\"t\":\"Windows内核原理与实现\",\"a\":\"潘爱民著\"},{\"t\":\"推荐系统：产品与算法解析\",\"a\":\"王超\"}],\"计算机-编程设计\":[{\"t\":\"跟着项目学iOS应用开发：基于Swift 4\",\"a\":\"刘铭\"},{\"t\":\"Python大数据分析与机器学习商业案例实战\",\"a\":\"王宇韬 钱妍竹\"}],\"计算机-计算机综合\":[{\"t\":\"硅谷之火：个人计算机的诞生与衰落（第3版）\",\"a\":\"迈克尔·斯韦因  保罗·弗赖伯格\"},{\"t\":\"硬件产品经理方法论\",\"a\":\"林志平\"},{\"t\":\"硬件产品经理手册：手把手构建智能硬件产品\",\"a\":\"贾明华\"},{\"t\":\"推荐系统实践\",\"a\":\"项亮\"},{\"t\":\"游戏为什么好玩：游戏设计的奥秘\",\"a\":\"王亚晖\"}]};\nvar BOOK_COUNT=677;\n\nfunction initBookUI(cats){var keys=Object.keys(cats);catSel.innerHTML='\u003coption value=\"all\"\u003e全部分类 ('+keys.reduce(function(s,c){return s+cats[c].length},0)+')\u003c/option\u003e';allBooks=[];keys.forEach(function(c){var o=document.createElement('option');o.value=c;o.textContent=c+' ('+cats[c].length+')';catSel.appendChild(o)});keys.forEach(function(cat){cats[cat].forEach(function(b){allBooks.push({t:b.t,a:b.a,c:cat})})});document.getElementById('bookCountText').textContent=allBooks.length;filterBooks();}\nvar catSel=document.getElementById('catFilter');\ninitBookUI(CATS);\ntry { var savedCh = localStorage.getItem('wr_channel'); if (savedCh === 'mp') { switchChannel('mp'); var savedCat = localStorage.getItem('wr_mp_cat'); if (savedCat) { setTimeout(function(){ if (typeof selectMpCat === 'function') { selectMpCat(savedCat); } }, 100); } } } catch(e) {}\nfetch(location.origin+'/bookshelf/load').then(function(r){return r.json()}).then(function(d){if(d.ok\u0026\u0026d.cats\u0026\u0026d.count\u003e0){CATS=d.cats;BOOK_COUNT=d.count;initBookUI(CATS);}}).catch(function(){});\nfunction syncBookshelf(){var btn=event.target;btn.disabled=true;btn.textContent='同步中...';btn.classList.add('btn-loading');fetch(location.origin+'/bookshelf/sync',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})}).then(function(r){return r.json()}).then(function(d){btn.disabled=false;btn.classList.remove('btn-loading');btn.textContent='同步书架';if(d.ok){CATS=d.cats;BOOK_COUNT=d.total;initBookUI(CATS);alert('同步完成！共 '+d.total+' 本书');}else{alert('同步失败：'+d.error);}}).catch(function(e){btn.disabled=false;btn.classList.remove('btn-loading');btn.textContent='同步书架';alert('同步失败：'+e.message);});}\n\nfunction esc(s){return String(s).replace(/\\\u0026/g,'\\\u0026amp;').replace(/\u003c/g,'\\\u0026lt;').replace(/\u003e/g,'\\\u0026gt;').replace(/\"/g,'\\\u0026quot;')}\nfunction escA(s){return String(s).replace(/\\\\/g,'\\\\\\\\').replace(/'/g,\"\\\\'\")}\n\nfunction filterBooks(){\n  var q=document.getElementById('search').value.toLowerCase();\n  var cat=document.getElementById('catFilter').value;\n  var list=document.getElementById('bookList');\n  var filtered=allBooks.filter(function(b){\n    if(cat\u0026\u0026b.c!==cat)return false;\n    if(q\u0026\u0026b.t.toLowerCase().indexOf(q)\u003c0\u0026\u0026b.a.toLowerCase().indexOf(q)\u003c0)return false;\n    return true;\n  });\n  document.getElementById('counter').textContent='显示 '+filtered.length+' / '+BOOK_COUNT+' 本';\n  if(!filtered.length){list.innerHTML='\u003cdiv class=\"empty\"\u003e没有找到匹配的书籍\u003c/div\u003e';return}\n  var html='';\n  for(var i=0;i\u003cfiltered.length;i++){\n    var b=filtered[i],ck=selected.has(b.t)?'checked':'';\n    html+='\u003cdiv class=\"book-item\" onclick=\"tog(this,\\''+escA(b.t)+'\\')\"\u003e\u003cinput type=\"checkbox\" '+ck+' onclick=\"event.stopPropagation();tog(this.parentElement,\\''+escA(b.t)+'\\')\"\u003e\u003cdiv class=\"info\"\u003e\u003cdiv class=\"title\"\u003e'+esc(b.t)+'\u003c/div\u003e\u003cdiv class=\"author\"\u003e'+esc(b.a)+'\u003c/div\u003e\u003c/div\u003e\u003cspan class=\"cat-tag\"\u003e'+esc(b.c)+'\u003c/span\u003e\u003c/div\u003e';\n  }\n  list.innerHTML=html;\n}\n\nfunction tog(el,title){\n  var cb=el.querySelector('input');\n  if(selected.has(title)){selected.delete(title);cb.checked=false}\n  else{selected.add(title);cb.checked=true}\n  updBtn();\n}\n\nfunction updBtn(){\n  var n=selected.size;\n  document.getElementById('btnOverview').disabled=n!==1;\n  document.getElementById('btnCollision').disabled=n\u003c2;\n  var info=document.getElementById('selectedInfo');\n  if(n===0)info.textContent='选择书籍开始';\n  else if(n===1)info.textContent='已选1本 → 可生成速览';\n  else info.textContent='已选'+n+'本 → 可发起书籍碰撞';\n}\n\nfunction callWorker(action,params){\n  return fetch(WORKER_URL,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:action,params:params})}).then(function(r){return r.json()});\n}\n\nfunction getBookData(title){\n  return callWorker('search',{keyword:title,count:5}).then(function(res){\n    var d=res.data||res;\n    var books=[];\n    if(d.results\u0026\u0026d.results[0]\u0026\u0026d.results[0].books)books=d.results[0].books.map(function(b){return b.bookInfo||b});\n    else if(d.books)books=d.books;\n    if(!books.length)throw new Error('未找到《'+title+'》');\n    var matched=books.find(function(b){return b.title===title})||books[0];\n    var bookId=matched.bookId;\n    return Promise.all([\n      callWorker('bookInfo',{bookId:bookId}).catch(function(){return{data:{}}}),\n      callWorker('highlights',{bookId:bookId}).catch(function(){return{data:{}}}),\n      callWorker('reviews',{bookId:bookId,count:20,synckey:0}).catch(function(){return{data:{}}})\n    ]).then(function(arr){\n      var info=arr[0].data||arr[0]||{};\n      var hl=arr[1].data||arr[1]||{};\n      var rv=arr[2].data||arr[2]||{};\n      return{\n        title:matched.title||title,\n        author:matched.author||'',\n        intro:info.intro||matched.intro||'',\n        highlights:hl.items||[],\n        reviews:(rv.reviews||[]).map(function(r){return{user:r.user||{nickname:'匿名'},content:r.content||'',likes:r.likes||0}})\n      };\n    });\n  });\n}\n\nfunction renderMd(md){\n  return md.replace(/^### (.*$)/gm,'\u003ch3\u003e$1\u003c/h3\u003e').replace(/^## (.*$)/gm,'\u003ch2\u003e$1\u003c/h2\u003e').replace(/^# (.*$)/gm,'\u003ch1\u003e$1\u003c/h1\u003e').replace(/\\*\\*(.*?)\\*\\*/g,'\u003cstrong\u003e$1\u003c/strong\u003e').replace(/\\*(.*?)\\*/g,'\u003cem\u003e$1\u003c/em\u003e').replace(/^\u003e (.*$)/gm,'\u003cblockquote\u003e$1\u003c/blockquote\u003e').replace(/^- (.*$)/gm,'\u003cli\u003e$1\u003c/li\u003e').replace(/^---$/gm,'\u003chr\u003e').replace(/\\n\\n/g,'\u003c/p\u003e\u003cp\u003e').replace(/\\n/g,'\u003cbr\u003e');\n}\n\nfunction showLoad(t,d){document.getElementById('loadingText').textContent=t;document.getElementById('loadingDetail').textContent=d||'';document.getElementById('loadingOverlay').classList.remove('hidden')}\nfunction hideLoad(){document.getElementById('loadingOverlay').classList.add('hidden')}\n\nfunction startOverview(){\n  var title=[...selected][0];\n  var btn=document.getElementById('btnOverview');\n  btn.classList.add('btn-loading');btn.textContent='AI 分析中...';\n  showLoad('正在获取《'+title+'》的数据...','调用微信读书 API');\n  getBookData(title).then(function(bk){\n    showLoad('构建分析素材...','获取到 '+bk.highlights.length+' 条划线，'+bk.reviews.length+' 条点评');\n    var prompt=buildOverviewPrompt(bk);\n    return callAI(prompt).then(function(text){return{text:text,bk:bk}});\n  }).then(function(result){\n    var content='## 《'+result.bk.title+'》深度速览\\n\\n**作者**：'+result.bk.author+'\\n\\n---\\n\\n'+result.text;\n    results.unshift({id:Date.now(),type:'overview',title:'《'+title+'》深度速览',timestamp:new Date().toISOString(),content:content});\n    localStorage.setItem('wr_results',JSON.stringify(results));\n    renderResults();hideLoad();kvSaveResults();\n  }).catch(function(err){hideLoad();alert('生成失败：'+err.message)}).finally(function(){btn.classList.remove('btn-loading');btn.textContent='📖 生成速览'});\n}\n\nfunction startCollision(){\n  var titles=[...selected];\n  var btn=document.getElementById('btnCollision');\n  btn.classList.add('btn-loading');btn.textContent='AI 分析中...';\n  showLoad('正在获取 '+titles.length+' 本书的数据...','第 1/'+titles.length+' 本');\n  var promise=Promise.resolve();var booksList=[];\n  titles.forEach(function(t,i){\n    promise=promise.then(function(){\n      showLoad('正在获取数据...','第 '+(i+1)+'/'+titles.length+' 本：《'+t+'》');\n      return getBookData(t).then(function(bk){booksList.push(bk)});\n    });\n  });\n  promise.then(function(){\n    showLoad('构建碰撞分析素材...','共 '+booksList.reduce(function(s,b){return s+b.highlights.length},0)+' 条划线');\n    var prompt=buildCollisionPrompt(booksList);\n    return callAI(prompt).then(function(text){return{text:text,books:booksList}});\n  }).then(function(result){\n    var titlesStr=result.books.map(function(b){return '《'+b.title+'》';}).join(' × ');\n    var content='## 💥 '+titlesStr+' 思想碰撞\\n\\n'+result.text;\n    results.unshift({id:Date.now(),type:'collision',title:titlesStr+' 碰撞',timestamp:new Date().toISOString(),content:content});\n    localStorage.setItem('wr_results',JSON.stringify(results));\n    renderResults();hideLoad();kvSaveResults();\n  }).catch(function(err){hideLoad();alert('生成失败：'+err.message)}).finally(function(){btn.classList.remove('btn-loading');btn.textContent='💥 书籍碰撞'});\n}\n\nfunction callAI(prompt){\n  showLoad('AI 正在深度分析...','这通常需要 15-30 秒，请稍候');\n  return fetch(location.origin+'/ai',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:prompt})})\n  .then(function(r){return r.json()}).then(function(data){if(data.error)throw new Error(data.error);return data.text});\n}\n\nfunction buildOverviewPrompt(bk){\n  var data='《'+bk.title+'》\\n作者：'+bk.author+'\\n\\n';\n  if(bk.intro)data+='【书籍简介】\\n'+bk.intro+'\\n\\n';\n  if(bk.highlights\u0026\u0026bk.highlights.length){\n    data+='【读者热门划线（'+bk.highlights.length+'条）——这是最核心的原文素材，分析必须以此为基础】\\n';\n    bk.highlights.slice(0,40).forEach(function(h,i){\n      data+=(i+1)+'. '+(h.markText||'')+'\\n';\n      if(h.chapterName)data+='   ——第'+h.chapterName+'\\n';\n      if(h.thought)data+='   读者批注：'+h.thought+'\\n';\n      data+='\\n';\n    });\n  }\n  if(bk.reviews\u0026\u0026bk.reviews.length){\n    data+='【读者精选评论（'+bk.reviews.length+'条）】\\n';\n    bk.reviews.slice(0,15).forEach(function(r,i){\n      var nm=(r.user\u0026\u0026r.user.nickname)?r.user.nickname:'匿名';\n      data+=(i+1)+'. '+nm;if(r.likes\u003e0)data+='（'+r.likes+'人觉得有用）';\n      data+='：'+(r.content||'').substring(0,300)+'\\n\\n';\n    });\n  }\n  return '你是一位专业的阅读导师。请严格基于下方提供的【读者热门划线】和【读者精选评论】来撰写这篇速览内容。\\n'+\n    '这份速览是读者的\"阅读伴侣\"，读者会一边看这份速览，一边阅读原书，所以内容要尽可能丰富、详尽，帮助读者高效且深入地理解一本书。\\n\\n'+\n    '【写作铁律——违反任何一条都算不合格】\\n'+\n    '1. 所有分析必须扎根于提供的划线原文。严禁凭空演绎书中不存在的内容。\\n'+\n    '2. 引用划线原文时使用 \u003e 引用格式，标注章节。\\n'+\n    '3. 延展思考部分必须先完整呈现原文依据，再展开推理。区分\"书中说的\"和\"我的延伸\"。\\n'+\n    '4. 如果素材不足以支撑某个论点，宁可不写也不要编造。\\n'+\n    '5. **内容必须完整输出，严禁中途截断。所有章节的概览都要写完，不能只写部分章节就结束。**\\n\\n'+\n    '【文章结构与字数分配——严格遵守，总字数不少于10000字】\\n\\n'+\n    '## 一、中心思想与核心观点（约1000字，占全文10%）\\n'+\n    '用精炼有力的语言概括这本书的核心灵魂，并展开最重要的3-5个核心观点：\\n'+\n    '- 作者最核心的主张是什么？\\n'+\n    '- 这本书试图解决什么问题？\\n'+\n    '- 提炼3-5个核心观点，每个观点用2-3句话概括，并引用1-2条划线原文佐证\\n'+\n    '这部分要让读者一眼抓住全书精髓和主要论点。\\n\\n'+\n    '## 二、章节大纲与内容概览（约8000字，占全文80%）\\n'+\n    '这是整份速览的核心部分，也是读者阅读原书时最重要的参考。请按书籍的实际章节结构，逐章梳理，**不漏掉任何一个章节**：\\n\\n'+\n    '### 结构要求：\\n'+\n    '- 如果书有明确的分区（如上篇/中篇/下篇、第一部分/第二部分等），先列出分区，再在分区下展开各章\\n'+\n    '- 每个章节必须包含：\\n'+\n    '  1. 章节标题\\n'+\n    '  2. 核心内容总结（用500-800字详细总结该章的核心论点、关键概念、重要案例、论证过程）\\n'+\n    '  3. 引用2-3条该章的划线原文，用 \u003e 引用格式标注，并简要分析每条原文的含义\\n'+\n    '  4. 该章的关键概念或术语解释（如果有）\\n'+\n    '  5. 该章与全书中心思想的关系（1-2句话说明这章为什么重要）\\n\\n'+\n    '### 写作要求：\\n'+\n    '- 不要只列标题，每个章节都必须有深入详细的内容概览\\n'+\n    '- 要帮助读者在阅读前就知道这章讲什么，阅读后能回顾要点\\n'+\n    '- 章节之间的逻辑关系要清晰，让读者看到全书的论述脉络\\n'+\n    '- **必须覆盖全书所有章节，不能只写部分章节。内容要尽可能丰富详尽**\\n'+\n    '- 对于重要的案例、实验、故事等，要具体描述而不是泛泛而谈\\n\\n'+\n    '## 三、重要启示（约1000字，占全文10%）\\n'+\n    '展开延展思考。这部分要回答：\\n'+\n    '- 这本书对读者的实际生活/工作有什么启发？\\n'+\n    '- 书中哪些观点最值得深思？为什么？\\n'+\n    '- 如果要践行书中的某个理念，可以从哪里开始？\\n'+\n    '每个启示先引用原文依据，再展开分析。\\n\\n'+\n    '【字数要求】总字数10000字以上，各部分按上述比例分配。章节大纲部分必须占80%，每章概览要详尽。\\n'+\n    '【格式要求】使用markdown格式，层次清晰，便于阅读。\\n\\n'+\n    '【以下是书籍数据和读者内容】\\n\\n'+data;\n}\n\nfunction buildCollisionPrompt(list){\n  var data='';\n  list.forEach(function(bk,idx){\n    data+='\\n'+'='.repeat(40)+'\\n';\n    data+='第'+(idx+1)+'本书：《'+bk.title+'》\\n';\n    data+='作者：'+bk.author+'\\n\\n';\n    if(bk.intro)data+='【简介】'+bk.intro.substring(0,300)+'\\n\\n';\n    if(bk.highlights\u0026\u0026bk.highlights.length){\n      data+='【读者热门划线——核心原文素材】\\n';\n      bk.highlights.slice(0,20).forEach(function(h,i){\n        data+=(i+1)+'. '+(h.markText||'')+'\\n';\n        if(h.thought)data+='   批注：'+h.thought+'\\n';\n      });\n      data+='\\n';\n    }\n    if(bk.reviews\u0026\u0026bk.reviews.length){\n      data+='【读者评论】\\n';\n      bk.reviews.slice(0,10).forEach(function(r,i){\n        var nm=(r.user\u0026\u0026r.user.nickname)?r.user.nickname:'匿名';\n        data+=(i+1)+'. ['+nm+'] '+(r.content||'').substring(0,200)+'\\n';\n      });\n      data+='\\n';\n    }\n  });\n  var titles=list.map(function(b){return '《'+b.title+'》';}).join('、');\n  return '你是一位跨学科思想分析师。请严格基于下方提供的各书【读者热门划线】和【读者评论】进行深度思想碰撞分析。\\n\\n'+\n    '涉及书籍：'+titles+'\\n\\n'+\n    '【写作铁律】\\n'+\n    '1. 所有分析必须扎根于提供的划线原文，严禁凭空演绎。\\n'+\n    '2. 每次引用某本书的观点时，必须同时引用对应的划线原文（用 \u003e 引用格式），标注出自哪本书。\\n'+\n    '3. 对比不同书时，先列出各自的原文，再做比较分析。\\n'+\n    '4. 严禁编造书中不存在的观点或例子。\\n\\n'+\n    '【文章结构】\\n\\n'+\n    '## 一、思想共识（1500-2000字）\\n这些书在哪些核心问题上达成共识？\\n\\n'+\n    '## 二、根本分歧（1500-2000字）\\n这些书在哪些关键问题上存在分歧？\\n\\n'+\n    '## 三、最值得关注的原文观点（1500-2000字）\\n从所有书中选出最有冲击力的5-8条原文。\\n\\n'+\n    '## 四、思想合成（1500-2000字）\\n把各书原文放在一起，能产生什么新的洞见？\\n\\n'+\n    '## 五、点睛总结（300-500字）\\n用一段有态度的文字总结这次碰撞的核心收获。\\n\\n'+\n    '总字数不少于8000字。使用markdown格式。\\n\\n'+\n    '以下是书籍数据和读者内容：\\n'+data;\n}\n\nfunction renderResults(){\n  var list=document.getElementById('resultsList');\n  if(!results.length){list.innerHTML='\u003cdiv class=\"empty\"\u003e还没有生成记录\u003cbr\u003e选择书籍开始你的第一次速览或碰撞\u003c/div\u003e';return}\n  list.innerHTML=results.map(function(r){\n    var time=new Date(r.timestamp).toLocaleString('zh-CN');\n    var tc=r.type==='overview'?'type-overview':'type-collision';\n    var tn=r.type==='overview'?'速览':'碰撞';\n    return '\u003cdiv class=\"result-item\"\u003e\u003cdiv class=\"result-info\"\u003e\u003cdiv class=\"result-title\"\u003e'+esc(r.title)+'\u003c/div\u003e\u003cdiv class=\"result-meta\"\u003e\u003cspan class=\"result-type '+tc+'\"\u003e'+tn+'\u003c/span\u003e'+time+'\u003c/div\u003e\u003c/div\u003e\u003cbutton class=\"btn-view\" onclick=\"viewResult('+r.id+')\"\u003e查看\u003c/button\u003e\u003cbutton class=\"btn-delete\" onclick=\"delResult('+r.id+')\"\u003e删除\u003c/button\u003e\u003c/div\u003e';\n  }).join('');\n}\n\nfunction viewResult(id){\n  var r=results.find(function(x){return x.id===id});\n  if(!r)return;\n  document.getElementById('readingTitle').textContent=r.title;\n  document.getElementById('readingContent').innerHTML=renderMd(r.content);\n  document.getElementById('readingPage').style.display='block';\n  currentChatContext=r.content;currentChatResultId=id;chatHistory=[];\n  var messagesEl=document.getElementById('chatMessages');\n  messagesEl.innerHTML='\u003cdiv class=\"chat-msg assistant\"\u003e加载聊天记录中...\u003c/div\u003e';\n  var panel=document.getElementById('chatPanel');\n  panel.classList.remove('expanded');\n  document.getElementById('chatToggleHint').textContent='▲ 展开';\n  kvLoadChat(id);\n}\nfunction closeReading(){document.getElementById('readingPage').style.display='none'}\nfunction delResult(id){\n  if(!confirm('确定删除？'))return;\n  results=results.filter(function(r){return r.id!==id});\n  localStorage.setItem('wr_results',JSON.stringify(results));\n  renderResults();kvDeleteResult(id);\n}\n\nfilterBooks();renderResults();\n\n// ===== Chat =====\nvar chatHistory=[];var currentChatContext='';var currentChatResultId=null;\nfunction kvLoadChat(resultId){\n  fetch(location.origin+'/kv/chat/load',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({resultId:resultId})})\n  .then(function(r){return r.json()}).then(function(data){\n    var messagesEl=document.getElementById('chatMessages');\n    if(data.ok\u0026\u0026data.messages\u0026\u0026data.messages.length\u003e0){\n      chatHistory=data.messages;messagesEl.innerHTML='';\n      chatHistory.forEach(function(msg){\n        var div=document.createElement('div');div.className='chat-msg '+msg.role;\n        div.innerHTML=msg.role==='assistant'?renderMd(msg.content):esc(msg.content);\n        messagesEl.appendChild(div);\n      });\n    }else{messagesEl.innerHTML='\u003cdiv class=\"chat-msg assistant\"\u003e基于这篇分析内容，向我提问吧。\u003c/div\u003e';}\n  }).catch(function(){document.getElementById('chatMessages').innerHTML='\u003cdiv class=\"chat-msg assistant\"\u003e基于这篇分析内容，向我提问吧。\u003c/div\u003e'});\n}\nfunction kvSaveChat(){if(!currentChatResultId)return;fetch(location.origin+'/kv/chat/save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({resultId:currentChatResultId,messages:chatHistory})}).catch(function(){});}\nfunction toggleChat(){var panel=document.getElementById('chatPanel');var hint=document.getElementById('chatToggleHint');panel.classList.toggle('expanded');hint.textContent=panel.classList.contains('expanded')?'▼ 收起':'▲ 展开';}\nfunction clearChat(){chatHistory=[];document.getElementById('chatMessages').innerHTML='\u003cdiv class=\"chat-msg assistant\"\u003e对话已清空。\u003c/div\u003e';kvSaveChat();}\nfunction chatKeydown(e){if(e.key==='Enter'\u0026\u0026!e.shiftKey){e.preventDefault();sendChat();}}\nfunction sendChat(){\n  var input=document.getElementById('chatInput');var msg=input.value.trim();if(!msg)return;\n  var sendBtn=document.getElementById('chatSendBtn');sendBtn.disabled=true;input.value='';\n  var messagesEl=document.getElementById('chatMessages');\n  var userDiv=document.createElement('div');userDiv.className='chat-msg user';userDiv.textContent=msg;messagesEl.appendChild(userDiv);\n  var loadingDiv=document.createElement('div');loadingDiv.className='chat-msg assistant loading';loadingDiv.textContent='思考中...';messagesEl.appendChild(loadingDiv);\n  messagesEl.scrollTop=messagesEl.scrollHeight;chatHistory.push({role:'user',content:msg});\n  fetch(location.origin+'/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:chatHistory,context:currentChatContext})})\n  .then(function(r){return r.json()}).then(function(data){\n    messagesEl.removeChild(loadingDiv);\n    if(data.error){var errDiv=document.createElement('div');errDiv.className='chat-msg assistant';errDiv.textContent='❌ '+data.error;messagesEl.appendChild(errDiv);}\n    else{chatHistory.push({role:'assistant',content:data.text});kvSaveChat();var aiDiv=document.createElement('div');aiDiv.className='chat-msg assistant';aiDiv.innerHTML=renderMd(data.text);messagesEl.appendChild(aiDiv);}\n    messagesEl.scrollTop=messagesEl.scrollHeight;sendBtn.disabled=false;input.focus();\n  }).catch(function(err){messagesEl.removeChild(loadingDiv);var errDiv=document.createElement('div');errDiv.className='chat-msg assistant';errDiv.textContent=' 网络错误：'+err.message;messagesEl.appendChild(errDiv);messagesEl.scrollTop=messagesEl.scrollHeight;sendBtn.disabled=false;input.focus();});\n}\n\n// ===== MP (公众号) Channel =====\nvar mpInitialized = false;\nvar mpCategories = [];\nvar mpCurrentCat = '';\nvar mpCurrentAccount = null;\nvar mpAccountsMap = {};\nvar mpStarredIds = [];\nvar STARRED_TAB = String.fromCharCode(0x2B50) + ' 星标';\nvar ALL_TAB = '全部';\n\nfunction loadMpAccounts() {\n  showLoad('正在加载公众号列表...', '从微信读书获取数据');\n  fetch(location.origin + '/mp/accounts', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({})})\n  .then(function(r) { return r.json(); })\n  .then(function(data) {\n    hideLoad();\n    if (data.error) {\n      document.getElementById('mpAccountList').innerHTML = '\u003cdiv class=\"mp-empty\"\u003e加载失败：' + esc(data.error) + '\u003c/div\u003e';\n      return;\n    }\n    mpCategories = data.categories || [];\n    var total = mpCategories.reduce(function(s, c) { return s + c.accounts.length; }, 0);\n    document.getElementById('mpCountText').textContent = total;\n    fetch(location.origin + '/mp/star/get').then(function(r){return r.json()}).then(function(sd){\n      mpStarredIds = sd.starred || [];\n      renderMpCatTabs();\n      if (mpCategories.length \u003e 0) {\n        mpCurrentCat = ALL_TAB;\n        renderMpAccounts();\n      }\n      mpInitialized = true;\n    }).catch(function(){\n      renderMpCatTabs();\n      if (mpCategories.length \u003e 0) {\n        mpCurrentCat = ALL_TAB;\n        renderMpAccounts();\n      }\n      mpInitialized = true;\n    });\n  })\n  .catch(function(err) {\n    hideLoad();\n    document.getElementById('mpAccountList').innerHTML = '\u003cdiv class=\"mp-empty\"\u003e加载失败：' + esc(err.message) + '\u003c/div\u003e';\n  });\n}\n\nfunction selectStarredTab(){mpCurrentCat=STARRED_TAB;mpCurrentAccount=null;mpShowListView();renderMpCatTabs();renderMpAccounts();document.getElementById('mpArticlePanel').innerHTML='\u003cdiv class=\"mp-empty\"\u003e\u70b9\u51fb\u5de6\u4fa7\u516c\u4f17\u53f7\u540d\u79f0\u003cbr\u003e\u67e5\u770b\u6700\u8fd1\u6587\u7ae0\u003c/div\u003e';}\nfunction toggleStarFromBtn(bookId){var idx=mpStarredIds.indexOf(bookId);if(idx\u003e=0){mpStarredIds.splice(idx,1)}else{mpStarredIds.push(bookId)}saveStarred();renderMpCatTabs();renderMpAccounts();}\nfunction renderMpCatTabs() {\n  var container = document.getElementById('mpCatTabs');\n  var starredCount = mpStarredIds.length;\n  var allActive = mpCurrentCat === ALL_TAB ? ' active' : '';\n  var allTab = '\u003cdiv class=\"mp-cat-tab' + allActive + '\" onclick=\"selectMpCat(\\'' + ALL_TAB + '\\')\"\u003e' + ALL_TAB + ' (' + mpCategories.reduce(function(s,c){return s+c.accounts.length},0) + ')\u003c/div\u003e';\n  var starredActive = mpCurrentCat === STARRED_TAB ? ' active' : '';\n  var starredTab = '\u003cdiv class=\"mp-cat-tab' + starredActive + '\" onclick=\"selectStarredTab()\"\u003e' + STARRED_TAB + (starredCount \u003e 0 ? ' (' + starredCount + ')' : '') + '\u003c/div\u003e';\n  var catTabs = mpCategories.map(function(c) {\n    var active = c.name === mpCurrentCat ? ' active' : '';\n    return '\u003cdiv class=\"mp-cat-tab' + active + '\" onclick=\"selectMpCat(\\'' + escA(c.name) + '\\')\"\u003e' + esc(c.name) + ' (' + c.accounts.length + ')\u003c/div\u003e';\n  }).join('');\n  container.innerHTML = allTab + starredTab + catTabs;\n}\n\nfunction selectMpCat(name) {\n  mpCurrentCat = name;\n  mpCurrentAccount = null;\n  mpShowListView();\n  renderMpCatTabs();\n  renderMpAccounts();\n  document.getElementById('mpArticlePanel').innerHTML = '\u003cdiv class=\"mp-empty\"\u003e点击左侧公众号名称\u003cbr\u003e查看最近文章\u003c/div\u003e';\n}\n\nfunction renderMpAccounts() {\n  var list = document.getElementById('mpAccountList');\n  var accounts = [];\n  if (mpCurrentCat === STARRED_TAB) {\n    mpCategories.forEach(function(c) {\n      c.accounts.forEach(function(a) {\n        if (mpStarredIds.indexOf(a.bookId) \u003e= 0) accounts.push(a);\n      });\n    });\n    accounts.sort(function(a, b) { return b.updateTs - a.updateTs; });\n    if (!accounts.length) {\n      list.innerHTML = '\u003cdiv class=\"mp-empty\"\u003e暂无星标公众号\u003cbr\u003e点击公众号旁的星标添加\u003c/div\u003e';\n      return;\n    }\n  } else if (mpCurrentCat === ALL_TAB) {\n    mpCategories.forEach(function(c) {\n      c.accounts.forEach(function(a) { accounts.push(a); });\n    });\n    accounts.sort(function(a, b) { return (b.updateTs || 0) - (a.updateTs || 0); });\n    if (!accounts.length) {\n      list.innerHTML = '<div class=\"mp-empty\">\u6682\u65e0\u516c\u4f17\u53f7</div>';\n      return;\n    }\n  } else {\n    var cat = mpCategories.find(function(c) { return c.name === mpCurrentCat; });\n    if (!cat || !cat.accounts.length) {\n      list.innerHTML = '\u003cdiv class=\"mp-empty\"\u003e该分类下没有公众号\u003c/div\u003e';\n      return;\n    }\n    accounts = cat.accounts;\n  }\n  var html = accounts.map(function(a) {\n    var active = mpCurrentAccount \u0026\u0026 mpCurrentAccount.bookId === a.bookId ? ' active' : '';\n    var updateDate = a.updateTime ? a.updateTime.substring(5, 10) : '';\n    var isStarred = mpStarredIds.indexOf(a.bookId) \u003e= 0;\n    var starClass = isStarred ? 'mp-star-btn starred' : 'mp-star-btn';\n    var starIcon = isStarred ? String.fromCharCode(0x2B50) : '☆';\n    return '\u003cdiv class=\"mp-account-item' + active + '\" onclick=\"selectMpAccount(\\'' + escA(a.bookId) + '\\')\"\u003e' +\n      '\u003cimg class=\"mp-account-cover\" src=\"' + esc(a.cover) + '\" onerror=\"this.style.display=\\'none\\'\"\u003e' +\n      '\u003cdiv class=\"mp-account-info\"\u003e' +\n      '\u003cdiv class=\"mp-account-name\"\u003e' + esc(a.title) + '\u003c/div\u003e' +\n      '\u003cdiv class=\"mp-account-update\"\u003e更新于 ' + updateDate + '\u003c/div\u003e' +\n      '\u003c/div\u003e' +\n      '\u003cspan class=\"' + starClass + '\" onclick=\"event.stopPropagation();toggleStar(\\'' + escA(a.bookId) + '\\')\"\u003e' + starIcon + '\u003c/span\u003e' +\n      '\u003c/div\u003e';\n  }).join('');\n  list.innerHTML = html;\n}\n\nfunction selectMpAccount(bookId) {\n  var account = null;\n  mpCategories.forEach(function(c) {\n    if (!account) {\n      account = c.accounts.find(function(a) { return a.bookId === bookId; });\n    }\n  });\n  if (!account) return;\n  mpCurrentAccount = account;\n  renderMpAccounts();\n  loadMpArticles(account);\n  mpShowArticleView();\n}\n\nfunction mpShowArticleView() {\n  var layout = document.getElementById(\"mpLayout\");\n  if (layout) { layout.className = \"mp-layout mp-view-article\"; }\n}\n\nfunction mpShowListView() {\n  var layout = document.getElementById(\"mpLayout\");\n  if (layout) { layout.className = \"mp-layout mp-view-list\"; }\n  mpCurrentAccount = null;\n  renderMpAccounts();\n}\n\nfunction mpBackToList() {\n  mpShowListView();\n  document.getElementById(\"mpArticlePanel\").innerHTML = '<div class=\"mp-empty\">点击公众号名称<br>查看最近文章</div>';\n}\n\nfunction loadMpArticles(account) {\n  var panel = document.getElementById('mpArticlePanel');\n  panel.innerHTML = '\u003cdiv class=\"mp-empty\"\u003e正在加载文章...\u003c/div\u003e';\n  fetch(location.origin + '/mp/articles', {\n    method: 'POST',\n    headers: {'Content-Type': 'application/json'},\n    body: JSON.stringify({bookId: account.bookId})\n  })\n  .then(function(r) { return r.json(); })\n  .then(function(data) {\n    if (data.error === 'cookie_expired') {\n      panel.innerHTML = '\u003cdiv class=\"mp-empty\" style=\"flex-direction:column;gap:12px\"\u003e\u003cdiv style=\"font-size:15px;color:#f0883e\"\u003e\u26a0\ufe0f 微信读书登录已过期\u003c/div\u003e\u003cdiv style=\"font-size:13px;color:#8b949e;line-height:1.6\"\u003e请重新登录 weread.qq.com\u003cbr\u003e并更新 Cloudflare Worker 的 WEREAD_COOKIE\u003c/div\u003e\u003c/div\u003e';\n      return;\n    }\n    if (data.error) {\n      renderMpAccountFallback(account);\n      return;\n    }\n    var articles = data.articles || [];\n    if (!articles.length) {\n      renderMpAccountFallback(account);\n      return;\n    }\n    renderMpArticleList(account, articles);\n  })\n  .catch(function() {\n    renderMpAccountFallback(account);\n  });\n}\n\nfunction renderMpArticleList(account, articles) {\n  var panel = document.getElementById('mpArticlePanel');\n  var html = '\u003cdiv class=\"mp-account-header\"\u003e' +\n    '\u003cimg class=\"mp-account-header-cover\" src=\"' + esc(account.cover) + '\" onerror=\"this.style.display=\\'none\\'\"\u003e' +\n    '\u003cdiv\u003e\u003cdiv class=\"mp-account-header-name\"\u003e' + esc(account.title) + '\u003c/div\u003e' +\n    '\u003cdiv class=\"mp-account-header-meta\"\u003e公众号 · 更新于 ' + (account.updateTime || '') + '\u003c/div\u003e\u003c/div\u003e\u003c/div\u003e' +\n    '\u003cdiv class=\"article-list-scroll\"\u003e';\n  articles.forEach(function(art) {\n    var dateStr = art.date || '';\n    html += '\u003cdiv class=\"article-item\"\u003e' +\n      '\u003cdiv style=\"flex:1;min-width:0\"\u003e' +\n      '\u003cdiv class=\"article-date\"\u003e' + esc(dateStr) + '\u003c/div\u003e' +\n      '\u003cdiv class=\"article-title\"\u003e' + esc(art.title || '') + '\u003c/div\u003e';\n    if (art.readCount || art.likeCount) {\n      html += '\u003cdiv class=\"article-meta\"\u003e';\n      if (art.readCount) html += '阅读 ' + esc(art.readCount) + ' ';\n      if (art.likeCount) html += '赞 ' + esc(art.likeCount);\n      html += '\u003c/div\u003e';\n    }\n    html += '\u003c/div\u003e';\n    if (art.deepLink) {\n      html += '\u003ca href=\"' + esc(art.deepLink) + '\" target=\"_blank\" class=\"btn-read\" style=\"text-decoration:none\"\u003e\xe5\x8e\xbb\xe8\xaf\xbb\u003c/a\u003e';\n    }\n    html += '\u003c/div\u003e';\n  });\n  html += '\u003c/div\u003e';\n  panel.innerHTML = html;\n}\n\n// ===== 跨平台 Deep Link 拉起微信读书 =====\nfunction openInWeRead(deepLink) {\n  if (!deepLink) return;\n  var webUrl = deepLink;\n  if (deepLink.indexOf('weread://') === 0) {\n    webUrl = 'https://weread.qq.com/' + deepLink.substring(9);\n  }\n  var ua = navigator.userAgent || '';\n  var isIOS = /iPad|iPhone|iPod/.test(ua);\n  var isHarmonyOS = /HarmonyOS/.test(ua) || /OpenHarmony/.test(ua);\n  var isAndroid = /Android/.test(ua);\n  if (isIOS) {\n    var a = document.createElement('a');\n    a.href = webUrl;\n    a.setAttribute('target', '_blank');\n    a.style.display = 'none';\n    document.body.appendChild(a);\n    a.click();\n    document.body.removeChild(a);\n  } else if (isHarmonyOS || isAndroid) {\n    window.location.href = webUrl;\n  } else {\n    window.open(webUrl, '_blank');\n  }\n}\n\nfunction toggleStar(bookId) {\n  var idx = mpStarredIds.indexOf(bookId);\n  if (idx \u003e= 0) {\n    mpStarredIds.splice(idx, 1);\n  } else {\n    mpStarredIds.push(bookId);\n  }\n  saveStarred();\n  renderMpCatTabs();\n  renderMpAccounts();\n}\n\nfunction saveStarred() {\n  fetch(location.origin + '/mp/star/set', {\n    method: 'POST',\n    headers: {'Content-Type': 'application/json'},\n    body: JSON.stringify({starred: mpStarredIds})\n  }).catch(function(){});\n}\n\nfunction renderMpAccountFallback(account) {\n  var panel = document.getElementById('mpArticlePanel');\n  var deepLink = account.readerUrl || account.deepLink || '';\n  var html = '\u003cdiv class=\"mp-account-header\"\u003e' +\n    '\u003cimg class=\"mp-account-header-cover\" src=\"' + esc(account.cover) + '\" onerror=\"this.style.display=\\'none\\'\"\u003e' +\n    '\u003cdiv\u003e\u003cdiv class=\"mp-account-header-name\"\u003e' + esc(account.title) + '\u003c/div\u003e' +\n    '\u003cdiv class=\"mp-account-header-meta\"\u003e\u516c\u4f17\u53f7 \u00b7 \u66f4\u65b0\u4e8e ' + (account.updateTime || '') + '\u003c/div\u003e\u003c/div\u003e\u003c/div\u003e';\n  if (account.intro) {\n    html += '\u003cdiv style=\"padding:12px 0;color:#8b949e;font-size:13px;border-bottom:1px solid #21262d;margin-bottom:12px\"\u003e' + esc(account.intro) + '\u003c/div\u003e';\n  }\n  html += '\u003cdiv style=\"text-align:center;padding:24px 16px\"\u003e';\n  html += '\u003cdiv style=\"color:#8b949e;font-size:13px;margin-bottom:20px;line-height:1.6\"\u003e\u6587\u7ae0\u5217\u8868\u8bf7\u901a\u8fc7\u5fae\u4fe1\u8bfb\u4e66 App \u67e5\u770b\u003cbr\u003e\u70b9\u51fb\u4e0b\u65b9\u6309\u94ae\u6253\u5f00\u5fae\u4fe1\u8bfb\u4e66\u003cbr\u003e\u67e5\u770b\u8be5\u516c\u4f17\u53f7\u7684\u6700\u65b0\u6587\u7ae0\u003c/div\u003e';\n  if (deepLink) {\n    html += '\u003ca href=\"' + esc(deepLink) + '\" target=\"_blank\" class=\"btn-read-inapp\" style=\"padding:10px 24px;font-size:15px;border-radius:8px;display:inline-flex;align-items:center;gap:6px;text-decoration:none\"\u003e📖 打开微信读书\u003c/a\u003e';\n  }\n  html += '\u003c/div\u003e';\n  panel.innerHTML = html;\n}\n\n\u003c/script\u003e\n\u003c/body\u003e\n\u003c/html\u003e\n";
