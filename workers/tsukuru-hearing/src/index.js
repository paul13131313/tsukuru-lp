/**
 * tsukuru-hearing — Claude API Proxy + Resend通知 Worker
 * ヒアリング結果からAIサマリーを生成 & メール通知
 */

const ALLOWED_ORIGINS = [
  'https://paul13131313.github.io',
  'http://localhost:5202',
  'http://127.0.0.1:5202',
];

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';
const RESEND_API_URL = 'https://api.resend.com/emails';
const NOTIFY_TO = 'hiroshinagano0113@gmail.com';

// レートリミット（簡易: メモリ内）
const rateMap = new Map();
const RATE_LIMIT = 10; // 1分あたり最大リクエスト数
const RATE_WINDOW = 60_000; // 1分

function checkRate(ip) {
  const now = Date.now();
  const entry = rateMap.get(ip);
  if (!entry || now - entry.start > RATE_WINDOW) {
    rateMap.set(ip, { start: now, count: 1 });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT;
}

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

// プラン判定
function determinePlan(audience) {
  if (audience === '2,000人以上') {
    return { key: 'premium', name: 'プレミアム', initial: '198,000円', monthly: '79,800円/月' };
  }
  if (audience === '500〜2,000人') {
    return { key: 'standard', name: 'スタンダード', initial: '98,000円', monthly: '39,800円/月' };
  }
  return { key: 'starter', name: 'スターター', initial: '49,800円', monthly: '19,800円/月' };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405, origin);
    }

    const url = new URL(request.url);

    // レートリミット
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (!checkRate(ip)) {
      return json({ error: 'Rate limit exceeded' }, 429, origin);
    }

    // ルーティング
    if (url.pathname === '/notify') {
      return handleNotify(request, env, origin);
    }
    if (url.pathname !== '/api/hearing-summary') {
      return json({ error: 'Not found' }, 404, origin);
    }

    // リクエストボディ
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON' }, 400, origin);
    }

    const { industry, purpose, audience, frequency, title, tone } = body;
    if (!industry || !purpose || !audience || !frequency || !tone) {
      return json({ error: 'Missing required fields' }, 400, origin);
    }

    // プラン判定
    const plan = determinePlan(audience);

    // Claude API呼び出し
    const systemPrompt = `あなたは「業界紙つくーる」のAIコンシェルジュです。
ヒアリング結果をもとに、サービス申込みを自然に後押しする一言メッセージ（2〜3文）を日本語で返してください。
押しつけがましくなく、相手の業種や目的に寄り添った前向きなトーンで。
JSONや記号は不要。文章のみ返してください。`;

    const userPrompt = `業種: ${industry}
目的: ${purpose}
配信規模: ${audience}
頻度: ${frequency}
タイトル案: ${title || '未定'}
トーン: ${tone}`;

    try {
      const response = await fetch(CLAUDE_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.CLAUDE_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 300,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
        }),
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error(`Claude API error ${response.status}: ${errText}`);
        return json({ summary: '', plan }, 200, origin);
      }

      const result = await response.json();

      if (result.usage) {
        const cost = ((result.usage.input_tokens / 1_000_000) * 1.0 + (result.usage.output_tokens / 1_000_000) * 5.0) * 150;
        console.log(`Claude: in=${result.usage.input_tokens} out=${result.usage.output_tokens} ≈${cost.toFixed(1)}円`);
      }

      const text = result.content?.find(b => b.type === 'text')?.text || '';
      return json({ summary: text, plan }, 200, origin);

    } catch (err) {
      console.error('Worker error:', err.message);
      return json({ summary: '', plan }, 200, origin);
    }
  },
};

// ===== /notify — Resendでメール送信 =====
async function handleNotify(request, env, origin) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400, origin);
  }

  const { email, industry, purpose, audience, frequency, title, tone, plan } = body;
  if (!email || !industry) {
    return json({ error: 'Missing required fields' }, 400, origin);
  }

  const htmlBody = `
<h2>【業界紙つくーる】新規ヒアリング完了</h2>
<table style="border-collapse:collapse;font-family:sans-serif;font-size:14px;">
  <tr><td style="padding:8px 16px 8px 0;color:#888;">メールアドレス</td><td style="padding:8px 0;font-weight:bold;">${escapeHtml(email)}</td></tr>
  <tr><td style="padding:8px 16px 8px 0;color:#888;">業種</td><td style="padding:8px 0;">${escapeHtml(industry)}</td></tr>
  <tr><td style="padding:8px 16px 8px 0;color:#888;">目的</td><td style="padding:8px 0;">${escapeHtml(purpose || '—')}</td></tr>
  <tr><td style="padding:8px 16px 8px 0;color:#888;">配信規模</td><td style="padding:8px 0;">${escapeHtml(audience || '—')}</td></tr>
  <tr><td style="padding:8px 16px 8px 0;color:#888;">頻度</td><td style="padding:8px 0;">${escapeHtml(frequency || '—')}</td></tr>
  <tr><td style="padding:8px 16px 8px 0;color:#888;">タイトル案</td><td style="padding:8px 0;">${escapeHtml(title || '未定')}</td></tr>
  <tr><td style="padding:8px 16px 8px 0;color:#888;">トーン</td><td style="padding:8px 0;">${escapeHtml(tone || '—')}</td></tr>
  <tr><td style="padding:8px 16px 8px 0;color:#888;">おすすめプラン</td><td style="padding:8px 0;font-weight:bold;">${escapeHtml(plan || '—')}</td></tr>
</table>
`;

  try {
    const res = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: 'onboarding@resend.dev',
        to: NOTIFY_TO,
        subject: '【業界紙つくーる】新規ヒアリング完了',
        html: htmlBody,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`Resend API error ${res.status}: ${errText}`);
      return json({ ok: false, error: 'Email send failed' }, 500, origin);
    }

    return json({ ok: true }, 200, origin);
  } catch (err) {
    console.error('Notify error:', err.message);
    return json({ ok: false, error: err.message }, 500, origin);
  }
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
