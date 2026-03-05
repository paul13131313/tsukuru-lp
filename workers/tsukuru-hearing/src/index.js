/**
 * tsukuru-hearing — Claude API Proxy + Resend通知 + Stripe決済 + 記事生成・配信 Worker
 * ヒアリング結果からAIサマリーを生成 & メール通知 & Stripe Checkout & 記事自動生成・承認・配信
 */

const ALLOWED_ORIGINS = [
  'https://paul13131313.github.io',
  'http://localhost:5202',
  'http://127.0.0.1:5202',
];

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';
const ARTICLE_MODEL = 'claude-opus-4-6';
const RESEND_API_URL = 'https://api.resend.com/emails';
const RESEND_BROADCAST_URL = 'https://api.resend.com/broadcasts';
const RESEND_AUDIENCES_URL = 'https://api.resend.com/audiences';
const STRIPE_API_URL = 'https://api.stripe.com/v1';
const NOTIFY_TO = 'hiroshinagano0113@gmail.com';
const APPROVE_PAGE_URL = 'https://paul13131313.github.io/tsukuru-lp/approve.html';

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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // GET または POST のみ許可
    if (request.method !== 'POST' && request.method !== 'GET') {
      return json({ error: 'Method not allowed' }, 405, origin);
    }

    const url = new URL(request.url);

    // Stripe Webhookはレートリミット・CORS不要（Stripeサーバーから直接呼出）
    if (url.pathname === '/stripe-webhook' && request.method === 'POST') {
      return handleStripeWebhook(request, env, ctx);
    }

    // /approve はGET・POST両方対応
    if (url.pathname === '/approve') {
      if (request.method === 'GET') {
        return handleApproveGet(request, env, origin);
      }
      if (request.method === 'POST') {
        return handleApprovePost(request, env, origin);
      }
    }

    // それ以外のGETは拒否
    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405, origin);
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
      return handleOnboarding(request, env, origin, ctx);
    }
    if (url.pathname === '/create-portal-session') {
      return handleCreatePortalSession(request, env, origin);
    }
    if (url.pathname !== '/api/hearing-summary') {
      return json({ error: 'Not found' }, 404, origin);
    }

    // ===== /api/hearing-summary — ヒアリングAIサマリー =====
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

    const plan = determinePlan(audience);

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
  params.append('metadata[planKey]', plan);

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
async function handleStripeWebhook(request, env, ctx) {
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

        // KVにクライアントデータを保存（ヒアリング回答はStripeメタデータから取得）
        const meta = session.metadata || {};
        const clientData = {
          email: session.customer_email,
          resendApiKey: null,
          fromName: null,
          answers: {
            industry: meta.industry || '',
            purpose: meta.purpose || '',
            audience: meta.audience || '',
            frequency: meta.frequency || '',
            title: meta.title || '',
            tone: meta.tone || '',
          },
          status: 'onboarding',
          approvalToken: null,
          tokenExpiresAt: null,
          articleHtml: null,
          createdAt: new Date().toISOString(),
          lastSentAt: null,
          issueNumber: 0,
          stripeCustomerId: session.customer || null,
          planKey: meta.planKey || 'starter',
        };
        await env.CLIENTS.put(
          `client:${session.customer_email}`,
          JSON.stringify(clientData)
        );
        console.log(`KV saved: client:${session.customer_email}`);
        break;
      }
      case 'invoice.payment_succeeded': {
        const invoice = event.data.object;
        console.log(`Invoice paid: ${invoice.id}, customer=${invoice.customer}, amount=${invoice.amount_paid}`);

        // 初回請求（subscription_create）はcheckout.session.completedで処理済みなのでスキップ
        if (invoice.billing_reason === 'subscription_create') break;

        // 2回目以降: 記事を自動生成して承認フローに入る
        const clientData = await findClientByCustomerId(invoice.customer, env);
        if (clientData && (clientData.status === 'active' || clientData.status === 'pending_approval')) {
          // ctx.waitUntilでバックグラウンド実行（webhook応答のタイムアウト回避）
          ctx.waitUntil((async () => {
            try {
              clientData.issueNumber = (clientData.issueNumber || 0) + 1;
              const articleHtml = await generateArticle(clientData, env);
              clientData.articleHtml = articleHtml;

              const token = crypto.randomUUID();
              clientData.approvalToken = token;
              clientData.tokenExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
              clientData.status = 'pending_approval';

              await env.CLIENTS.put(`client:${clientData.email}`, JSON.stringify(clientData));
              // トークン逆引きインデックス
              await env.CLIENTS.put(`token:${token}`, clientData.email, { expirationTtl: 7 * 24 * 60 * 60 });

              await sendSampleEmail(clientData, env);
              console.log(`Monthly article generated and sample sent for ${clientData.email} (issue #${clientData.issueNumber})`);
            } catch (err) {
              console.error(`Monthly article generation error for ${invoice.customer}: ${err.message}`);
            }
          })());
        }
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
  const parts = {};
  sigHeader.split(',').forEach(function(part) {
    const [key, value] = part.split('=');
    if (key && value) parts[key.trim()] = value;
  });

  const timestamp = parts['t'];
  const signature = parts['v1'];
  if (!timestamp || !signature) return false;

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp)) > 300) return false;

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

// ===== 記事自動生成 =====
async function generateArticle(clientData, env) {
  const { answers, issueNumber } = clientData;
  const today = new Date().toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' });
  const titleText = answers.title || '業界通信';

  const systemPrompt = `あなたは業界紙・メールマガジンの編集者です。
指定された業種・目的・トーンに合わせて、メールで配信する業界紙の1号分を作成してください。

出力はメール配信用のインラインCSS付きHTML（<html>タグから開始）で返してください。
外部CSSやJavaScriptは一切使わないこと。画像タグも不要です。
HTMLのみ返してください。説明文や前置きは不要です。

構成:
1. ヘッダー: 「${titleText}」タイトルと号数（第${issueNumber}号）、日付（${today}）
2. メイン記事: 業界の最新トレンドや役立つ情報（300文字程度）
3. サブ記事1: 関連トピック（150文字程度）
4. サブ記事2: 関連トピック（150文字程度）
5. 編集後記: 編集者からの一言（50文字程度）
6. フッター: 配信元情報

デザイン指針:
- 新聞風の品のあるレイアウト
- フォントファミリ: 'Hiragino Mincho ProN', 'Yu Mincho', serif（見出し）, sans-serif（本文）
- 配色: #1c1814（墨）ベース、#b8924a（金）をアクセント、背景#f4ede0（和紙）
- max-width: 600px, margin: 0 auto
- 全てインラインCSSで指定
- テーブルレイアウトでメールクライアント互換性を確保`;

  const userPrompt = `業種: ${answers.industry}
目的: ${answers.purpose}
配信規模: ${answers.audience}
頻度: ${answers.frequency}
タイトル: ${titleText}
トーン: ${answers.tone}
号数: 第${issueNumber}号
日付: ${today}`;

  try {
    const response = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ARTICLE_MODEL,
        max_tokens: 4000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`Claude article generation error ${response.status}: ${errText}`);
      throw new Error(`Claude API error: ${response.status}`);
    }

    const result = await response.json();

    if (result.usage) {
      const cost = ((result.usage.input_tokens / 1_000_000) * 15.0 + (result.usage.output_tokens / 1_000_000) * 75.0) * 150;
      console.log(`Claude (opus): in=${result.usage.input_tokens} out=${result.usage.output_tokens} ≈${cost.toFixed(1)}円`);
    }

    const html = result.content?.find(b => b.type === 'text')?.text || '';
    return html;

  } catch (err) {
    console.error('Article generation error:', err.message);
    throw err;
  }
}

// ===== サンプルメール送信（クライアント宛） =====
async function sendSampleEmail(clientData, env) {
  const approveUrl = `${APPROVE_PAGE_URL}?token=${clientData.approvalToken}`;
  const titleText = clientData.answers.title || '業界通信';

  const wrapperHtml = `
<div style="max-width:640px;margin:0 auto;font-family:'Hiragino Kaku Gothic ProN',sans-serif;">
  <div style="background:#1c1814;color:#f4ede0;padding:16px 24px;text-align:center;font-size:14px;">
    【${escapeHtml(titleText)}】サンプル確認のお願い
  </div>
  <div style="padding:24px;background:#fdfaf5;border:1px solid rgba(28,24,20,0.15);">
    <p style="font-size:15px;line-height:1.8;color:#333;margin:0 0 16px;">
      「${escapeHtml(titleText)}」第${clientData.issueNumber}号のサンプルが完成しました。<br>
      以下のリンクから内容をご確認いただき、<strong>承認</strong>または<strong>修正のご依頼</strong>をお願いいたします。
    </p>
    <div style="text-align:center;margin:24px 0;">
      <a href="${approveUrl}" style="display:inline-block;background:#1c1814;color:#f4ede0;padding:14px 32px;text-decoration:none;border-radius:8px;font-size:16px;font-weight:bold;">
        サンプルを確認する →
      </a>
    </div>
    <hr style="border:none;border-top:1px solid rgba(28,24,20,0.15);margin:20px 0;">
    <p style="font-size:13px;color:#6b6058;line-height:1.7;margin:0;">
      修正が必要な場合は、確認ページ上のフォームからご指示いただけます。<br>
      その他ご不明な点があれば、<strong>このメールにそのままご返信ください</strong>。
    </p>
  </div>
  <div style="background:#1c1814;color:#6b6058;padding:12px 24px;text-align:center;font-size:11px;">
    業界紙つくーる — AI生成×プロデザインの業界紙配信サービス
  </div>
</div>`;

  try {
    const res = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: 'onboarding@resend.dev',
        reply_to: NOTIFY_TO,
        to: clientData.email,
        subject: `【${titleText}】第${clientData.issueNumber}号サンプルをご確認ください`,
        html: wrapperHtml,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`Sample email send error ${res.status}: ${errText}`);
    } else {
      console.log(`Sample email sent to ${clientData.email}`);
    }
  } catch (err) {
    console.error('Sample email send error:', err.message);
  }
}

// ===== GET /approve — 記事HTML取得（approve.htmlから呼び出し） =====
async function handleApproveGet(request, env, origin) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  if (!token) {
    return json({ error: 'トークンが指定されていません' }, 400, origin);
  }

  const clientData = await findClientByToken(token, env);
  if (!clientData) {
    return json({ error: '無効なトークンです。リンクの有効期限が切れている可能性があります。' }, 404, origin);
  }

  if (clientData.tokenExpiresAt && new Date(clientData.tokenExpiresAt) < new Date()) {
    return json({ error: 'トークンの有効期限が切れています。担当者にご連絡ください。' }, 410, origin);
  }

  return json({
    articleHtml: clientData.articleHtml,
    title: clientData.answers.title || '業界通信',
    issueNumber: clientData.issueNumber,
    status: clientData.status,
  }, 200, origin);
}

// ===== POST /approve — 承認/修正依頼処理 =====
async function handleApprovePost(request, env, origin) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400, origin);
  }

  const { token, action, feedback, freeText } = body;
  if (!token || !action) {
    return json({ error: 'Missing token or action' }, 400, origin);
  }

  const clientData = await findClientByToken(token, env);
  if (!clientData) {
    return json({ error: '無効なトークンです。' }, 404, origin);
  }

  if (clientData.tokenExpiresAt && new Date(clientData.tokenExpiresAt) < new Date()) {
    return json({ error: 'トークンの有効期限が切れています。' }, 410, origin);
  }

  const kvKey = `client:${clientData.email}`;

  if (action === 'approve') {
    // 読者に本配信
    const deliveryResult = await deliverToReaders(clientData, env);

    clientData.status = 'active';
    clientData.lastSentAt = new Date().toISOString();
    clientData.approvalToken = null;
    clientData.tokenExpiresAt = null;
    await env.CLIENTS.put(kvKey, JSON.stringify(clientData));

    // トークンインデックス削除
    await env.CLIENTS.delete(`token:${token}`);

    // Paulに配信完了通知
    await sendApprovalNotification(clientData, deliveryResult, env);

    return json({
      ok: true,
      delivered: deliveryResult.ok,
      message: deliveryResult.ok
        ? '承認されました。読者への配信を開始しました。'
        : '承認されましたが、配信中にエラーが発生しました。担当者が確認します。',
    }, 200, origin);
  }

  if (action === 'revise') {
    clientData.status = 'revision_requested';
    await env.CLIENTS.put(kvKey, JSON.stringify(clientData));

    // Paulにフィードバック通知
    await sendRevisionNotification(clientData, feedback, freeText, env);

    return json({
      ok: true,
      message: '修正依頼を受け付けました。2営業日以内に修正版をお送りします。',
    }, 200, origin);
  }

  return json({ error: 'Invalid action' }, 400, origin);
}

// ===== トークンからクライアント検索（逆引きインデックス使用） =====
async function findClientByToken(token, env) {
  // まず逆引きインデックスを確認
  const email = await env.CLIENTS.get(`token:${token}`);
  if (email) {
    const data = await env.CLIENTS.get(`client:${email}`, { type: 'json' });
    if (data && data.approvalToken === token) {
      return data;
    }
  }

  // フォールバック: KV全走査（インデックスが無い場合）
  const list = await env.CLIENTS.list({ prefix: 'client:' });
  for (const key of list.keys) {
    const data = await env.CLIENTS.get(key.name, { type: 'json' });
    if (data && data.approvalToken === token) {
      return data;
    }
  }
  return null;
}

// ===== Stripe顧客IDからクライアント検索 =====
async function findClientByCustomerId(customerId, env) {
  const list = await env.CLIENTS.list({ prefix: 'client:' });
  for (const key of list.keys) {
    const data = await env.CLIENTS.get(key.name, { type: 'json' });
    if (data && data.stripeCustomerId === customerId) {
      return data;
    }
  }
  return null;
}

// ===== 読者への本配信（Resend Broadcasts API） =====
async function deliverToReaders(clientData, env) {
  try {
    // Step 1: クライアントのResend APIキーでオーディエンスリスト取得
    const audienceRes = await fetch(RESEND_AUDIENCES_URL, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${clientData.resendApiKey}` },
    });

    if (!audienceRes.ok) {
      const errText = await audienceRes.text();
      console.error('Audiences API error:', errText);
      return { ok: false, error: 'オーディエンスの取得に失敗しました' };
    }

    const audienceData = await audienceRes.json();
    if (!audienceData.data || audienceData.data.length === 0) {
      console.error('No audiences found for client:', clientData.email);
      return { ok: false, error: '読者リストが見つかりません。Resendでオーディエンスを作成してください。' };
    }

    const audienceId = audienceData.data[0].id;
    const titleText = clientData.answers.title || '業界通信';

    // Step 2: ブロードキャスト作成
    const createRes = await fetch(RESEND_BROADCAST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${clientData.resendApiKey}`,
      },
      body: JSON.stringify({
        audience_id: audienceId,
        from: `${clientData.fromName || titleText} <onboarding@resend.dev>`,
        subject: `【${titleText}】第${clientData.issueNumber}号`,
        html: clientData.articleHtml,
      }),
    });

    const createData = await createRes.json();
    if (!createRes.ok) {
      console.error('Broadcast create error:', JSON.stringify(createData));
      return { ok: false, error: 'ブロードキャスト作成に失敗: ' + (createData.message || JSON.stringify(createData)) };
    }

    const broadcastId = createData.id;
    console.log(`Broadcast created: ${broadcastId}`);

    // Step 3: ブロードキャスト送信
    const sendRes = await fetch(`${RESEND_BROADCAST_URL}/${broadcastId}/send`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${clientData.resendApiKey}` },
    });

    if (!sendRes.ok) {
      const sendErr = await sendRes.text();
      console.error('Broadcast send error:', sendErr);
      return { ok: false, error: 'ブロードキャスト送信に失敗' };
    }

    console.log(`Broadcast sent: ${broadcastId} to audience ${audienceId}`);
    return { ok: true, audienceId, broadcastId };

  } catch (err) {
    console.error('deliverToReaders error:', err.message);
    return { ok: false, error: err.message };
  }
}

// ===== 承認・配信完了通知（Paul宛） =====
async function sendApprovalNotification(clientData, deliveryResult, env) {
  const titleText = clientData.answers.title || '業界通信';
  const htmlBody = `
<h2>【業界紙つくーる】記事承認・配信完了</h2>
<table style="border-collapse:collapse;font-family:sans-serif;font-size:14px;">
  <tr><td style="padding:8px 16px 8px 0;color:#888;">クライアント</td><td style="padding:8px 0;font-weight:bold;">${escapeHtml(clientData.email)}</td></tr>
  <tr><td style="padding:8px 16px 8px 0;color:#888;">タイトル</td><td style="padding:8px 0;">${escapeHtml(titleText)}</td></tr>
  <tr><td style="padding:8px 16px 8px 0;color:#888;">号数</td><td style="padding:8px 0;">第${clientData.issueNumber}号</td></tr>
  <tr><td style="padding:8px 16px 8px 0;color:#888;">配信結果</td><td style="padding:8px 0;font-weight:bold;color:${deliveryResult.ok ? '#2e7d32' : '#8b1a1a'};">${deliveryResult.ok ? '配信成功 ✅' : 'エラー: ' + escapeHtml(String(deliveryResult.error))}</td></tr>
  ${deliveryResult.broadcastId ? `<tr><td style="padding:8px 16px 8px 0;color:#888;">ブロードキャストID</td><td style="padding:8px 0;">${escapeHtml(deliveryResult.broadcastId)}</td></tr>` : ''}
</table>`;

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
        subject: `【業界紙つくーる】記事承認・配信完了（${escapeHtml(titleText)} 第${clientData.issueNumber}号）`,
        html: htmlBody,
      }),
    });
  } catch (err) {
    console.error('Approval notification email error:', err.message);
  }
}

// ===== 修正依頼通知（Paul宛） =====
async function sendRevisionNotification(clientData, feedback, freeText, env) {
  const titleText = clientData.answers.title || '業界通信';
  const feedbackItems = Array.isArray(feedback) && feedback.length > 0
    ? '<h3 style="margin:16px 0 8px;">チェック項目</h3><ul style="margin:0;padding-left:20px;">' +
      feedback.map(f => `<li style="margin:4px 0;">${escapeHtml(f)}</li>`).join('') +
      '</ul>'
    : '';

  const freeTextBlock = freeText
    ? `<h3 style="margin:16px 0 8px;">自由記述</h3><p style="background:#f5f5f5;padding:12px;border-radius:8px;margin:0;">${escapeHtml(freeText)}</p>`
    : '';

  const htmlBody = `
<h2>【業界紙つくーる】修正依頼</h2>
<table style="border-collapse:collapse;font-family:sans-serif;font-size:14px;">
  <tr><td style="padding:8px 16px 8px 0;color:#888;">クライアント</td><td style="padding:8px 0;font-weight:bold;">${escapeHtml(clientData.email)}</td></tr>
  <tr><td style="padding:8px 16px 8px 0;color:#888;">タイトル</td><td style="padding:8px 0;">${escapeHtml(titleText)}</td></tr>
  <tr><td style="padding:8px 16px 8px 0;color:#888;">号数</td><td style="padding:8px 0;">第${clientData.issueNumber}号</td></tr>
</table>
${feedbackItems}
${freeTextBlock}`;

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
        subject: `【業界紙つくーる】修正依頼（${escapeHtml(titleText)} 第${clientData.issueNumber}号）`,
        html: htmlBody,
      }),
    });
  } catch (err) {
    console.error('Revision notification email error:', err.message);
  }
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

// ===== /onboarding — オンボーディング情報受付（KV統合・記事生成トリガー） =====
async function handleOnboarding(request, env, origin, ctx) {
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

  // KVからクライアントデータ読み出し（checkout.session.completedで保存済み）
  const kvKey = `client:${email}`;
  const existing = await env.CLIENTS.get(kvKey, { type: 'json' });

  if (!existing) {
    // KVにレコードが無い場合: 従来のフォールバック（通知のみ）
    console.log(`No KV record for ${email}, sending notification only`);
    await sendOnboardingNotification(email, resendApiKey, senderName, sessionId, env);
    return json({ ok: true }, 200, origin);
  }

  // オンボーディングデータをマージ
  existing.resendApiKey = resendApiKey;
  existing.fromName = senderName || '';
  existing.issueNumber = (existing.issueNumber || 0) + 1;

  // Paulに通知（バックグラウンドで記事生成が始まることを通知）
  await sendOnboardingNotification(email, resendApiKey, senderName, sessionId, env);

  // 記事生成→サンプルメール送信をバックグラウンドで実行
  // （クライアントのブラウザにはすぐにOKを返す）
  ctx.waitUntil((async () => {
    try {
      const articleHtml = await generateArticle(existing, env);
      existing.articleHtml = articleHtml;

      const token = crypto.randomUUID();
      existing.approvalToken = token;
      existing.tokenExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      existing.status = 'pending_approval';

      await env.CLIENTS.put(kvKey, JSON.stringify(existing));
      // トークン逆引きインデックス（7日間TTL）
      await env.CLIENTS.put(`token:${token}`, email, { expirationTtl: 7 * 24 * 60 * 60 });

      await sendSampleEmail(existing, env);
      console.log(`Article generated and sample sent for ${email} (issue #${existing.issueNumber})`);
    } catch (err) {
      console.error(`Article generation failed for ${email}: ${err.message}`);
      // エラー時もKVを更新してステータスを記録
      existing.status = 'onboarding';
      await env.CLIENTS.put(kvKey, JSON.stringify(existing));
    }
  })());

  return json({ ok: true }, 200, origin);
}

// オンボーディング通知メール（Paul宛）
async function sendOnboardingNotification(email, resendApiKey, senderName, sessionId, env) {
  const htmlBody = `
<h2>【業界紙つくーる】オンボーディング情報</h2>
<table style="border-collapse:collapse;font-family:sans-serif;font-size:14px;">
  <tr><td style="padding:8px 16px 8px 0;color:#888;">メールアドレス</td><td style="padding:8px 0;font-weight:bold;">${escapeHtml(email)}</td></tr>
  <tr><td style="padding:8px 16px 8px 0;color:#888;">Resend APIキー</td><td style="padding:8px 0;font-family:monospace;">${escapeHtml(resendApiKey)}</td></tr>
  <tr><td style="padding:8px 16px 8px 0;color:#888;">送信者名</td><td style="padding:8px 0;">${escapeHtml(senderName || '—')}</td></tr>
  <tr><td style="padding:8px 16px 8px 0;color:#888;">セッションID</td><td style="padding:8px 0;">${escapeHtml(sessionId || '—')}</td></tr>
</table>
<p style="margin-top:16px;font-size:13px;color:#888;">※ 記事の自動生成を開始しました。完了後にサンプルメールがクライアントに送信されます。</p>
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
        subject: '【業界紙つくーる】オンボーディング情報受付',
        html: htmlBody,
      }),
    });
  } catch (err) {
    console.error('Onboarding notification email error:', err.message);
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
