/**
 * tsukuru-hearing — Claude API Proxy + Resend通知 + Stripe決済 Worker
 * ヒアリング結果からAIサマリーを生成 & メール通知 & Stripe Checkout
 */

const ALLOWED_ORIGINS = [
  'https://paul13131313.github.io',
  'http://localhost:5202',
  'http://127.0.0.1:5202',
];

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';
const RESEND_API_URL = 'https://api.resend.com/emails';
const STRIPE_API_URL = 'https://api.stripe.com/v1';
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

// プランキーから価格IDを取得
function getPriceId(planKey, env) {
  switch (planKey) {
    case 'premium': return env.STRIPE_PRICE_PREMIUM;
    case 'standard': return env.STRIPE_PRICE_STANDARD;
    case 'starter':
    default: return env.STRIPE_PRICE_STARTER;
  }
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

    // Stripe Webhookはレートリミット・CORS不要（Stripeサーバーから直接呼出）
    if (url.pathname === '/stripe-webhook') {
      return handleStripeWebhook(request, env);
    }

    // レートリミット
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (!checkRate(ip)) {
      return json({ error: 'Rate limit exceeded' }, 429, origin);
    }

    // ルーティング
    if (url.pathname === '/notify') {
      return handleNotify(request, env, origin);
    }
    if (url.pathname === '/create-checkout') {
      return handleCreateCheckout(request, env, origin);
    }
    if (url.pathname === '/onboarding') {
      return handleOnboarding(request, env, origin);
    }
    if (url.pathname === '/create-portal-session') {
      return handleCreatePortalSession(request, env, origin);
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

// ===== /create-checkout — Stripe Checkoutセッション作成 =====
async function handleCreateCheckout(request, env, origin) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400, origin);
  }

  const { plan, email, answers } = body;
  if (!plan || !email) {
    return json({ error: 'Missing plan or email' }, 400, origin);
  }

  const priceId = getPriceId(plan, env);
  if (!priceId) {
    return json({ error: 'Price not configured for plan: ' + plan }, 500, origin);
  }

  // Stripe APIはform-urlencoded形式
  const params = new URLSearchParams();
  params.append('mode', 'subscription');
  params.append('customer_email', email);
  params.append('line_items[0][price]', priceId);
  params.append('line_items[0][quantity]', '1');
  params.append('success_url', 'https://paul13131313.github.io/tsukuru-lp/success.html?session_id={CHECKOUT_SESSION_ID}');
  params.append('cancel_url', 'https://paul13131313.github.io/tsukuru-lp/');

  // ヒアリング回答をメタデータに保存
  if (answers) {
    params.append('metadata[industry]', answers.industry || '');
    params.append('metadata[purpose]', answers.purpose || '');
    params.append('metadata[audience]', answers.audience || '');
    params.append('metadata[frequency]', answers.frequency || '');
    params.append('metadata[title]', answers.title || '');
    params.append('metadata[tone]', answers.tone || '');
  }

  try {
    const res = await fetch(STRIPE_API_URL + '/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    const session = await res.json();

    if (!res.ok) {
      console.error('Stripe Checkout error:', JSON.stringify(session));
      return json({ error: session.error?.message || 'Checkout session creation failed' }, 500, origin);
    }

    return json({ url: session.url }, 200, origin);

  } catch (err) {
    console.error('Stripe error:', err.message);
    return json({ error: err.message }, 500, origin);
  }
}

// ===== /stripe-webhook — Stripe Webhook処理 =====
async function handleStripeWebhook(request, env) {
  const signature = request.headers.get('stripe-signature');
  if (!signature) {
    return new Response(JSON.stringify({ error: 'Missing stripe-signature header' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const payload = await request.text();

  // 署名検証
  const isValid = await verifyStripeSignature(payload, signature, env.STRIPE_WEBHOOK_SECRET);
  if (!isValid) {
    console.error('Stripe webhook: invalid signature');
    return new Response(JSON.stringify({ error: 'Invalid signature' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const event = JSON.parse(payload);
  console.log(`Stripe webhook event: ${event.type} (${event.id})`);

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        console.log(`Checkout completed: customer=${session.customer}, email=${session.customer_email}`);
        await sendCheckoutNotification(session, env);
        break;
      }
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        console.log(`Invoice paid: ${invoice.id}, customer=${invoice.customer}, amount=${invoice.amount_paid}`);
        break;
      }
      case 'customer.subscription.deleted': {
        const subscription = event.data.object;
        console.log(`Subscription cancelled: ${subscription.id}, customer=${subscription.customer}`);
        await sendCancellationNotification(subscription, env);
        break;
      }
      default:
        console.log(`Unhandled event type: ${event.type}`);
    }
  } catch (err) {
    console.error(`Webhook handler error: ${err.message}`);
  }

  // Stripeには常に200を返す（再試行を防ぐ）
  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Stripe署名検証（Web Crypto API使用）
async function verifyStripeSignature(payload, sigHeader, secret) {
  // sigHeaderをパース: t=タイムスタンプ,v1=署名
  const parts = {};
  sigHeader.split(',').forEach(function(part) {
    const [key, value] = part.split('=');
    if (key && value) parts[key.trim()] = value;
  });

  const timestamp = parts['t'];
  const signature = parts['v1'];
  if (!timestamp || !signature) return false;

  // タイムスタンプが5分以内か確認
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 300) return false;

  // HMAC-SHA256で署名を生成
  const signedPayload = timestamp + '.' + payload;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(signedPayload)
  );
  const expectedSig = Array.from(new Uint8Array(sig))
    .map(function(b) { return b.toString(16).padStart(2, '0'); })
    .join('');

  return expectedSig === signature;
}

// 決済完了通知メール
async function sendCheckoutNotification(session, env) {
  const meta = session.metadata || {};
  const htmlBody = `
<h2>【業界紙つくーる】新規契約完了 🎉</h2>
<table style="border-collapse:collapse;font-family:sans-serif;font-size:14px;">
  <tr><td style="padding:8px 16px 8px 0;color:#888;">メールアドレス</td><td style="padding:8px 0;font-weight:bold;">${escapeHtml(session.customer_email || '—')}</td></tr>
  <tr><td style="padding:8px 16px 8px 0;color:#888;">Stripe顧客ID</td><td style="padding:8px 0;">${escapeHtml(session.customer || '—')}</td></tr>
  <tr><td style="padding:8px 16px 8px 0;color:#888;">サブスクリプションID</td><td style="padding:8px 0;">${escapeHtml(session.subscription || '—')}</td></tr>
  <tr><td style="padding:8px 16px 8px 0;color:#888;">業種</td><td style="padding:8px 0;">${escapeHtml(meta.industry || '—')}</td></tr>
  <tr><td style="padding:8px 16px 8px 0;color:#888;">目的</td><td style="padding:8px 0;">${escapeHtml(meta.purpose || '—')}</td></tr>
  <tr><td style="padding:8px 16px 8px 0;color:#888;">配信規模</td><td style="padding:8px 0;">${escapeHtml(meta.audience || '—')}</td></tr>
  <tr><td style="padding:8px 16px 8px 0;color:#888;">頻度</td><td style="padding:8px 0;">${escapeHtml(meta.frequency || '—')}</td></tr>
  <tr><td style="padding:8px 16px 8px 0;color:#888;">タイトル案</td><td style="padding:8px 0;">${escapeHtml(meta.title || '—')}</td></tr>
  <tr><td style="padding:8px 16px 8px 0;color:#888;">トーン</td><td style="padding:8px 0;">${escapeHtml(meta.tone || '—')}</td></tr>
</table>
`;

  try {
    await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: 'onboarding@resend.dev',
        to: NOTIFY_TO,
        subject: '【業界紙つくーる】新規契約完了',
        html: htmlBody,
      }),
    });
  } catch (err) {
    console.error('Checkout notification email error:', err.message);
  }
}

// 解約通知メール
async function sendCancellationNotification(subscription, env) {
  const htmlBody = `
<h2>【業界紙つくーる】解約通知</h2>
<table style="border-collapse:collapse;font-family:sans-serif;font-size:14px;">
  <tr><td style="padding:8px 16px 8px 0;color:#888;">サブスクリプションID</td><td style="padding:8px 0;">${escapeHtml(subscription.id || '—')}</td></tr>
  <tr><td style="padding:8px 16px 8px 0;color:#888;">顧客ID</td><td style="padding:8px 0;">${escapeHtml(subscription.customer || '—')}</td></tr>
  <tr><td style="padding:8px 16px 8px 0;color:#888;">ステータス</td><td style="padding:8px 0;">${escapeHtml(subscription.status || '—')}</td></tr>
</table>
`;

  try {
    await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: 'onboarding@resend.dev',
        to: NOTIFY_TO,
        subject: '【業界紙つくーる】解約通知',
        html: htmlBody,
      }),
    });
  } catch (err) {
    console.error('Cancellation notification email error:', err.message);
  }
}

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

// ===== /onboarding — オンボーディング情報受付 =====
async function handleOnboarding(request, env, origin) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400, origin);
  }

  const { email, resendApiKey, senderName, sessionId } = body;
  if (!email || !resendApiKey) {
    return json({ error: 'Missing email or resendApiKey' }, 400, origin);
  }

  // Phase 1: 通知メールで受付（KVは後のフェーズで追加）
  const htmlBody = `
<h2>【業界紙つくーる】オンボーディング情報</h2>
<table style="border-collapse:collapse;font-family:sans-serif;font-size:14px;">
  <tr><td style="padding:8px 16px 8px 0;color:#888;">メールアドレス</td><td style="padding:8px 0;font-weight:bold;">${escapeHtml(email)}</td></tr>
  <tr><td style="padding:8px 16px 8px 0;color:#888;">Resend APIキー</td><td style="padding:8px 0;font-family:monospace;">${escapeHtml(resendApiKey)}</td></tr>
  <tr><td style="padding:8px 16px 8px 0;color:#888;">送信者名</td><td style="padding:8px 0;">${escapeHtml(senderName || '—')}</td></tr>
  <tr><td style="padding:8px 16px 8px 0;color:#888;">セッションID</td><td style="padding:8px 0;">${escapeHtml(sessionId || '—')}</td></tr>
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
        subject: '【業界紙つくーる】オンボーディング情報受付',
        html: htmlBody,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`Resend API error ${res.status}: ${errText}`);
      return json({ ok: false, error: 'Failed to process onboarding' }, 500, origin);
    }

    return json({ ok: true }, 200, origin);
  } catch (err) {
    console.error('Onboarding error:', err.message);
    return json({ ok: false, error: err.message }, 500, origin);
  }
}

// ===== /create-portal-session — Stripe Customer Portal =====
async function handleCreatePortalSession(request, env, origin) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400, origin);
  }

  const { email } = body;
  if (!email) {
    return json({ error: 'Missing email' }, 400, origin);
  }

  try {
    // メールアドレスから顧客を検索
    const searchParams = new URLSearchParams();
    searchParams.append('email', email);
    searchParams.append('limit', '1');

    const searchRes = await fetch(STRIPE_API_URL + '/customers?' + searchParams.toString(), {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
      },
    });

    const searchData = await searchRes.json();
    if (!searchRes.ok || !searchData.data || searchData.data.length === 0) {
      return json({ error: 'このメールアドレスに紐づく契約が見つかりません。ご契約時のメールアドレスをご確認ください。' }, 404, origin);
    }

    const customerId = searchData.data[0].id;

    // Customer Portalセッション作成
    const portalParams = new URLSearchParams();
    portalParams.append('customer', customerId);
    portalParams.append('return_url', 'https://paul13131313.github.io/tsukuru-lp/contact.html');

    const portalRes = await fetch(STRIPE_API_URL + '/billing_portal/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: portalParams.toString(),
    });

    const portalData = await portalRes.json();
    if (!portalRes.ok) {
      console.error('Stripe Portal error:', JSON.stringify(portalData));
      return json({ error: portalData.error?.message || 'ポータルセッションの作成に失敗しました。' }, 500, origin);
    }

    return json({ url: portalData.url }, 200, origin);

  } catch (err) {
    console.error('Portal session error:', err.message);
    return json({ error: err.message }, 500, origin);
  }
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
