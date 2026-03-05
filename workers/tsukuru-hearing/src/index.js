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
const ARTICLE_MODEL = 'claude-sonnet-4-20250514';
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
        return handleApprovePost(request, env, origin, ctx);
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

// ===== 業種別カラーテーマ =====
function getIndustryTheme(industry) {
  const themes = {
    '不動産業': { primary: '#1a3a5c', accent: '#4a90d9', light: '#e8f0fe', emoji: '🏢', label: '不動産', gradFrom: '#1a2f4a', gradTo: '#0d1f33' },
    '税理士・会計士': { primary: '#2d5016', accent: '#5a9e2f', light: '#edf7e5', emoji: '📊', label: '税務・会計', gradFrom: '#2d5016', gradTo: '#1a3009' },
    '社労士・弁護士': { primary: '#4a1942', accent: '#8b3a7d', light: '#f5e8f3', emoji: '⚖️', label: '法務・労務', gradFrom: '#4a1942', gradTo: '#2d0a27' },
    '製造業・商社': { primary: '#5c3d1a', accent: '#d4922a', light: '#fef5e8', emoji: '🏭', label: '製造・商社', gradFrom: '#1a1a2e', gradTo: '#0f0f1a' },
    '地域団体・商工会': { primary: '#1a4a3d', accent: '#2e9e7d', light: '#e5f7f2', emoji: '🤝', label: '地域・団体', gradFrom: '#1a4a3d', gradTo: '#0d2820' },
    '飲食業': { primary: '#8b2500', accent: '#e8593a', light: '#fde8e3', emoji: '🍽️', label: '飲食', gradFrom: '#8B2500', gradTo: '#5c1900' },
    '医療・介護': { primary: '#1a5c5c', accent: '#2aa5a5', light: '#e5f5f5', emoji: '🏥', label: '医療・介護', gradFrom: '#0a3d62', gradTo: '#051e31' },
    'IT・テクノロジー': { primary: '#1a1a4a', accent: '#5a5ad9', light: '#ebebfe', emoji: '💻', label: 'IT', gradFrom: '#0d2137', gradTo: '#071320' },
  };
  return themes[industry] || { primary: '#1c1814', accent: '#b8924a', light: '#f4ede0', emoji: '📰', label: '業界', gradFrom: '#1a1a1a', gradTo: '#0d0d0d' };
}

// ===== 記事自動生成 =====
async function generateArticle(clientData, env, revisionInstructions) {
  const { answers, issueNumber } = clientData;
  const today = new Date().toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' });
  const titleText = answers.title || '業界通信';
  const theme = getIndustryTheme(answers.industry);

  const systemPrompt = `あなたはプロの業界紙編集長です。読者が「毎号楽しみにしている」と感じるほどの質の高いメールマガジンを制作してください。
これはサンプルではなく、実際のクライアントに届ける本物の創刊号です。受注に直結する品質が求められます。

## 出力ルール
- <html>タグから始まる完全なHTMLを出力
- 外部CSS・JavaScript・画像タグは一切使用禁止
- 全てインラインCSS（style属性）で指定
- テーブルレイアウトでメールクライアント（Gmail, Outlook, Yahoo!メール）互換性を確保
- コードブロック（\`\`\`）で囲まない。純粋なHTMLのみ出力
- 説明文や前置きは一切不要

## 記事構成（必ずこの順番で、すべて含めること）

### 1. ヘッダー（インパクト重視・新聞の権威感を演出）
以下の順番で構成：
1. 上部アクセントライン: <div style="height:6px;background:${theme.accent}"></div>
2. メインヘッダー（背景グラデーション + パディング40px）:
  <div style="background:linear-gradient(135deg, ${theme.gradFrom}, ${theme.gradTo});padding:40px 24px;text-align:center">
    <div style="font-size:12px;color:rgba(255,255,255,0.6);letter-spacing:2px;margin-bottom:12px">発行元名（例: ○○協会 公式メールマガジン）</div>
    <h1 style="font-family:'Hiragino Mincho ProN','Yu Mincho',serif;font-size:42px;font-weight:900;color:#ffffff;margin:0 0 12px 0;letter-spacing:-1px;line-height:1.2">${titleText}</h1>
    <div style="font-size:16px;color:${theme.accent};font-style:italic;margin-bottom:16px">←ここにキャッチコピーを自動生成（例:「2026年春、不動産市場に異変あり」）</div>
    <div style="font-size:13px;color:rgba(255,255,255,0.5)">第${issueNumber}号 ｜ ${today}</div>
    <div style="width:60px;height:1px;background:rgba(255,255,255,0.3);margin:16px auto 0"></div>
  </div>
- キャッチコピーはその号の特集テーマから煽り系の一言を自動生成する（例: 「止まらない地価上昇、勝ち組はどこだ」「値上がり止まらぬ外食業界の今」）
- タイトルはfont-size:42px, font-weight:900, letter-spacing:-1pxで大きく表示
- 発行日・号数は控えめに（font-size:13px、半透明白文字）

### 2. 特集記事（500字以上）
- ${theme.emoji} 見出しにアイコン絵文字を付ける
- 業界の重要トピック・最新トレンドを深掘り
- 具体的な数字・事例・企業名（架空でもリアルに）を含める
- **リード文ボックス**: 本文の前に3行程度のリード文を以下の形式で配置:
  <div style="background:${theme.light};border-left:4px solid ${theme.accent};padding:12px 16px;margin-bottom:16px;font-size:15px;line-height:1.6;color:#555">
    この記事の要約・ポイントを3行で（新聞のデッキに相当）
  </div>
- 背景色 ${theme.light} のハイライトボックスで囲む
- 見出しは ${theme.accent} カラー

### 3. ニュース3本（各200字以上）
- 📌 📊 🏢 など、各ニュースの冒頭にアイコン絵文字を配置
- それぞれ異なるトピック（規制変更、市場動向、テクノロジーなど）
- 見出し + 本文の形式
- ニュース間は罫線（border-bottom）で区切る

### 4. データで見る${theme.label}
- web searchで取得した実データを使った業界分析セクション
- 4項目の指標カードを2列グリッドで配置
- グリッドコンテナ:
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:16px 0">
- 各カードのHTML構造:
  <div style="background:${theme.light};border-radius:8px;padding:16px;border:1px solid #e0e0e0">
    <div style="font-size:13px;color:#666;margin-bottom:4px">指標名</div>
    <div style="font-size:24px;font-weight:bold;color:${theme.primary};margin-bottom:4px">数値</div>
    <div style="font-size:14px;color:#27ae60;margin-bottom:8px">↑ +22.0%　前年比</div>
    <div style="font-size:11px;color:#999">（出典：○○省）</div>
  </div>
- 前年比の色分け: 上昇→color:#27ae60（緑）、下降→color:#e74c3c（赤）
- 上昇は「↑」、下降は「↓」の矢印を付ける
- 出典元はweb searchで取得した実際の出典を記載
- 架空のデータは使用禁止

### 5. ${theme.label}カレンダー
- 今月の重要イベント・締切・季節情報を3〜5項目（web searchで取得した実イベント）
- 日付は丸バッジで表示:
  <div style="background:${theme.primary};color:white;border-radius:50%;width:40px;height:40px;display:inline-flex;align-items:center;justify-content:center;font-weight:bold;font-size:14px;flex-shrink:0">15</div>
- 各イベントは日付バッジ＋テキストを横並び（display:flex; align-items:center; gap:12px）
- イベント間は余白(margin-bottom:12px)で区切る

### 6. 編集後記（100字以上）
- 編集長の個人的な視点や今号のポイントを振り返る
- 次号の予告も一言添える
- 温かみのある人間味あるトーンで

### 7. フッター
- 配信元情報のプレースホルダー:「このメールは[会社名]よりお届けしています」
- 配信停止リンクのプレースホルダー:「配信停止はこちら」（リンクは # で仮置き）
- Copyright表記

## デザイン指針
- max-width: 600px; margin: 0 auto
- モバイル対応: フォントサイズ最低14px、パディング十分に
- ヘッダー: 背景 linear-gradient(135deg, ${theme.gradFrom}, ${theme.gradTo})、テキスト白、パディング40px、タイトルfont-size:42px font-weight:900
- セクション区切り: 左ボーダー4px ${theme.accent} + パディング
- 見出し: font-size 20px、色 ${theme.primary}、font-weight bold
- 本文: font-size 15px、line-height 1.8、色 #333333
- フォントファミリ: 'Hiragino Kaku Gothic ProN', 'Yu Gothic', 'Meiryo', sans-serif（本文）/ 'Hiragino Mincho ProN', 'Yu Mincho', serif（タイトル・見出し）
- データカード: 2列グリッド、背景 ${theme.light}、角丸8px、ボーダー1px #e0e0e0
- 全体の背景: #f5f5f5（外枠）、#ffffff（コンテンツ部分）`;

  const userPrompt = `記事を生成する前に、必ずweb searchを使って以下の情報を取得してください：
1. 「${answers.industry}」の最新ニュース（直近1ヶ月）
2. 「${answers.industry}」に関連する最新の統計・数字
3. 「${answers.industry}」の今月の重要イベント・トピック

取得した実際の情報・数字をもとに記事を生成してください。
架空のデータは使用しないでください。
数字には必ず出典元を（）内に記載してください。

以下の情報をもとに、本物の創刊号を生成してください。

業種: ${answers.industry}
目的: ${answers.purpose}
配信規模: ${answers.audience}
頻度: ${answers.frequency}
タイトル: ${titleText}
トーン: ${answers.tone}
号数: 第${issueNumber}号
発行日: ${today}

特に重要なポイント:
- ${answers.industry}の読者が「これは役に立つ」と感じる具体的な情報を書いてください
- web searchで取得した実データ・実際のニュースを必ず盛り込んでください
- 「${answers.tone}」のトーンを厳密に守ってください
- 全セクション（特集・ニュース3本・データ・カレンダー・編集後記・フッター）を必ず含めてください

## データセクションの視覚表現ルール
データセクションは4項目の指標カードを2列グリッドで表示してください。
横棒グラフは使用しません。代わりに以下のカード形式を使ってください：

グリッドコンテナ:
<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:16px 0">

各カード:
<div style="background:${theme.light};border-radius:8px;padding:16px;border:1px solid #e0e0e0">
  <div style="font-size:13px;color:#666;margin-bottom:4px">指標名</div>
  <div style="font-size:24px;font-weight:bold;color:${theme.primary};margin-bottom:4px">数値</div>
  <div style="font-size:14px;color:#27ae60;margin-bottom:8px">↑ +22.0%　前年比</div>
  <div style="font-size:11px;color:#999">（出典：○○省）</div>
</div>

前年比の色: 上昇→color:#27ae60（緑）+ ↑、下降→color:#e74c3c（赤）+ ↓

## カレンダーセクションの日付バッジ
日付は以下の丸バッジで表示：
<div style="background:${theme.primary};color:white;border-radius:50%;width:40px;height:40px;display:inline-flex;align-items:center;justify-content:center;font-weight:bold;font-size:14px;flex-shrink:0">日</div>
各イベントは日付バッジ＋テキストを横並びで表示。${revisionInstructions ? `

## 【修正指示】以下のフィードバックを必ず反映してください:
${revisionInstructions}` : ''}`;

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
        max_tokens: 16000,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error(`Claude article generation error ${response.status}: ${errText}`);
      throw new Error(`Claude API error: ${response.status}`);
    }

    const result = await response.json();

    if (result.usage) {
      const cost = ((result.usage.input_tokens / 1_000_000) * 3.0 + (result.usage.output_tokens / 1_000_000) * 15.0) * 150;
      console.log(`Claude (sonnet): in=${result.usage.input_tokens} out=${result.usage.output_tokens} ≈${cost.toFixed(1)}円`);
    }

    // web_search使用時はcontent配列に複数ブロック（web_search_tool_result, text等）が返る
    // textブロックを全て結合してHTMLを抽出
    const textBlocks = (result.content || []).filter(b => b.type === 'text');
    const fullText = textBlocks.map(b => b.text).join('');
    // HTML部分を抽出（<html...から</html>まで、または<!DOCTYPE...から</html>まで）
    const htmlMatch = fullText.match(/(<!DOCTYPE[\s\S]*?<\/html>|<html[\s\S]*?<\/html>)/i);
    const html = htmlMatch ? htmlMatch[0] : fullText;
    console.log(`Article HTML extracted: ${html.length} chars, textBlocks: ${textBlocks.length}, fullText: ${fullText.length} chars`);
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
    revisionCount: clientData.revisionCount || 0,
    maxRevisions: 3,
  }, 200, origin);
}

// ===== POST /approve — 承認/修正依頼処理 =====
async function handleApprovePost(request, env, origin, ctx) {
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
    // 修正回数チェック（上限3回）
    const revisionCount = (clientData.revisionCount || 0) + 1;
    const MAX_REVISIONS = 3;

    if (revisionCount > MAX_REVISIONS) {
      // 上限超過: Paulに通知して手動対応を依頼
      await sendRevisionLimitNotification(clientData, feedback, freeText, env);
      return json({
        ok: true,
        limitReached: true,
        message: '修正回数の上限に達しました。\n担当者より直接ご連絡いたします。',
      }, 200, origin);
    }

    // フィードバックをKVに保存
    const revisionEntry = {
      count: revisionCount,
      feedback: feedback || [],
      freeText: freeText || '',
      requestedAt: new Date().toISOString(),
    };
    clientData.revisionCount = revisionCount;
    clientData.revisionHistory = clientData.revisionHistory || [];
    clientData.revisionHistory.push(revisionEntry);
    clientData.status = 'revision_requested';
    await env.CLIENTS.put(kvKey, JSON.stringify(clientData));

    // フィードバックを反映した修正指示を組み立て
    const revisionInstructions = buildRevisionInstructions(feedback, freeText);

    // 同期的に記事再生成→サンプルメール送信
    // （Stripe webhookと違いブラウザからの呼び出しなので、完了まで待ってからレスポンス返却）
    try {
      const articleHtml = await generateArticle(clientData, env, revisionInstructions);
      clientData.articleHtml = articleHtml;

      const newToken = crypto.randomUUID();
      clientData.approvalToken = newToken;
      clientData.tokenExpiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      clientData.status = 'pending_approval';

      await env.CLIENTS.put(kvKey, JSON.stringify(clientData));
      // 古いトークンインデックスを削除、新しいトークンインデックスを作成
      await env.CLIENTS.delete(`token:${token}`);
      await env.CLIENTS.put(`token:${newToken}`, clientData.email, { expirationTtl: 7 * 24 * 60 * 60 });

      await sendRevisionSampleEmail(clientData, env);
      await sendRevisionAutoNotification(clientData, revisionEntry, env);
      console.log(`Revision #${revisionCount} article regenerated and sample sent for ${clientData.email}`);

      return json({
        ok: true,
        revisionCount,
        message: `修正版を作成しました（${revisionCount}/${MAX_REVISIONS}回目）。\n修正版のサンプルメールをお送りしました。`,
      }, 200, origin);
    } catch (err) {
      console.error(`Revision article generation failed for ${clientData.email}: ${err.message}`);
      clientData.status = 'revision_requested';
      await env.CLIENTS.put(kvKey, JSON.stringify(clientData));
      // エラー時はPaulに手動対応を依頼
      await sendRevisionNotification(clientData, feedback, freeText, env);

      return json({
        ok: true,
        revisionCount,
        message: `修正依頼を受け付けました（${revisionCount}/${MAX_REVISIONS}回目）。\n自動生成に失敗したため、担当者が手動で対応します。`,
      }, 200, origin);
    }
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

// ===== フィードバックからプロンプト修正指示を組み立て =====
function buildRevisionInstructions(feedback, freeText) {
  const feedbackMap = {
    '文体・トーンを変えたい': '文体・トーンを大幅に変更してください。現在のトーンが合っていないため、読者層により適した表現に書き直してください。',
    '記事のテーマが業種に合っていない': 'この業種により特化した内容に変更してください。業種固有の課題・トレンド・用語を使い、読者が「自分ごと」と感じる記事にしてください。',
    'もっとやわらかい表現にしたい': '専門用語を減らし、平易でやわらかい文章に変更してください。初心者でも読みやすい表現を心がけてください。',
    'もっと専門的な内容にしたい': '業界専門用語・具体的な数字・実例・事例を増やし、より専門的で深い内容にしてください。プロの読者が満足する情報密度にしてください。',
    'タイトル・見出しを変えたい': '見出し・タイトルをより魅力的で目を引くものに変更してください。読者がクリックしたくなるような表現にしてください。',
    'レイアウト・デザインを変えたい': 'レイアウト構成を変更してください。セクション間の余白、色使い、フォントサイズのバランスを見直してください。',
  };

  const instructions = [];
  if (Array.isArray(feedback)) {
    for (const item of feedback) {
      if (feedbackMap[item]) {
        instructions.push(`- ${feedbackMap[item]}`);
      }
    }
  }
  if (freeText && freeText.trim()) {
    instructions.push(`- クライアントからの追加要望: 「${freeText.trim()}」`);
  }
  return instructions.join('\n');
}

// ===== 修正版サンプルメール送信（クライアント宛） =====
async function sendRevisionSampleEmail(clientData, env) {
  const approveUrl = `${APPROVE_PAGE_URL}?token=${clientData.approvalToken}`;
  const titleText = clientData.answers.title || '業界通信';

  const wrapperHtml = `
<div style="max-width:640px;margin:0 auto;font-family:'Hiragino Kaku Gothic ProN',sans-serif;">
  <div style="background:#1c1814;color:#f4ede0;padding:16px 24px;text-align:center;font-size:14px;">
    【${escapeHtml(titleText)}】修正版サンプルのお知らせ
  </div>
  <div style="padding:24px;background:#fdfaf5;border:1px solid rgba(28,24,20,0.15);">
    <p style="font-size:15px;line-height:1.8;color:#333;margin:0 0 16px;">
      ご指摘いただいた内容を反映し、「${escapeHtml(titleText)}」第${clientData.issueNumber}号の修正版を作成しました。<br>
      以下のリンクから内容をご確認ください。
    </p>
    <div style="text-align:center;margin:24px 0;">
      <a href="${approveUrl}" style="display:inline-block;background:#1c1814;color:#f4ede0;padding:14px 32px;text-decoration:none;border-radius:8px;font-size:16px;font-weight:bold;">
        修正版を確認する →
      </a>
    </div>
    <p style="font-size:13px;color:#6b6058;line-height:1.7;margin:16px 0 0;">
      修正回数: ${clientData.revisionCount}/3回<br>
      さらに修正が必要な場合は、確認ページ上のフォームからご指示いただけます。
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
        subject: `【${titleText}】修正版のサンプルをお送りします`,
        html: wrapperHtml,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`Revision sample email send error ${res.status}: ${errText}`);
    } else {
      console.log(`Revision sample email sent to ${clientData.email}`);
    }
  } catch (err) {
    console.error('Revision sample email send error:', err.message);
  }
}

// ===== 修正版自動送信完了通知（Paul宛） =====
async function sendRevisionAutoNotification(clientData, revisionEntry, env) {
  const titleText = clientData.answers.title || '業界通信';
  const feedbackItems = Array.isArray(revisionEntry.feedback) && revisionEntry.feedback.length > 0
    ? '<h3 style="margin:16px 0 8px;">フィードバック内容</h3><ul style="margin:0;padding-left:20px;">' +
      revisionEntry.feedback.map(f => `<li style="margin:4px 0;">${escapeHtml(f)}</li>`).join('') +
      '</ul>'
    : '';

  const freeTextBlock = revisionEntry.freeText
    ? `<h3 style="margin:16px 0 8px;">自由記述</h3><p style="background:#f5f5f5;padding:12px;border-radius:8px;margin:0;">${escapeHtml(revisionEntry.freeText)}</p>`
    : '';

  const htmlBody = `
<h2>【業界紙つくーる】修正版を自動送信しました</h2>
<table style="border-collapse:collapse;font-family:sans-serif;font-size:14px;">
  <tr><td style="padding:8px 16px 8px 0;color:#888;">クライアント</td><td style="padding:8px 0;font-weight:bold;">${escapeHtml(clientData.email)}</td></tr>
  <tr><td style="padding:8px 16px 8px 0;color:#888;">タイトル</td><td style="padding:8px 0;">${escapeHtml(titleText)}</td></tr>
  <tr><td style="padding:8px 16px 8px 0;color:#888;">号数</td><td style="padding:8px 0;">第${clientData.issueNumber}号</td></tr>
  <tr><td style="padding:8px 16px 8px 0;color:#888;">修正回数</td><td style="padding:8px 0;font-weight:bold;">${clientData.revisionCount}/3回</td></tr>
</table>
${feedbackItems}
${freeTextBlock}
<p style="margin-top:16px;font-size:13px;color:#888;">※ フィードバックを反映した修正版を自動生成し、クライアントに送信済みです。</p>`;

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
        subject: `【業界紙つくーる】修正版自動送信（${escapeHtml(titleText)} 第${clientData.issueNumber}号 修正${clientData.revisionCount}回目）`,
        html: htmlBody,
      }),
    });
  } catch (err) {
    console.error('Revision auto notification email error:', err.message);
  }
}

// ===== 修正上限到達通知（Paul宛） =====
async function sendRevisionLimitNotification(clientData, feedback, freeText, env) {
  const titleText = clientData.answers.title || '業界通信';
  const feedbackItems = Array.isArray(feedback) && feedback.length > 0
    ? '<h3 style="margin:16px 0 8px;">最終フィードバック</h3><ul style="margin:0;padding-left:20px;">' +
      feedback.map(f => `<li style="margin:4px 0;">${escapeHtml(f)}</li>`).join('') +
      '</ul>'
    : '';

  const freeTextBlock = freeText
    ? `<h3 style="margin:16px 0 8px;">自由記述</h3><p style="background:#f5f5f5;padding:12px;border-radius:8px;margin:0;">${escapeHtml(freeText)}</p>`
    : '';

  const historyBlock = Array.isArray(clientData.revisionHistory) && clientData.revisionHistory.length > 0
    ? '<h3 style="margin:16px 0 8px;">修正履歴</h3>' +
      clientData.revisionHistory.map((h, i) =>
        `<p style="margin:4px 0;font-size:13px;"><strong>${i + 1}回目</strong>（${h.requestedAt}）: ${(h.feedback || []).join('、')}${h.freeText ? '、' + h.freeText : ''}</p>`
      ).join('')
    : '';

  const htmlBody = `
<h2 style="color:#8b1a1a;">【業界紙つくーる】修正上限到達 ⚠️ 手動対応が必要です</h2>
<table style="border-collapse:collapse;font-family:sans-serif;font-size:14px;">
  <tr><td style="padding:8px 16px 8px 0;color:#888;">クライアント</td><td style="padding:8px 0;font-weight:bold;">${escapeHtml(clientData.email)}</td></tr>
  <tr><td style="padding:8px 16px 8px 0;color:#888;">タイトル</td><td style="padding:8px 0;">${escapeHtml(titleText)}</td></tr>
  <tr><td style="padding:8px 16px 8px 0;color:#888;">号数</td><td style="padding:8px 0;">第${clientData.issueNumber}号</td></tr>
  <tr><td style="padding:8px 16px 8px 0;color:#888;">修正回数</td><td style="padding:8px 0;font-weight:bold;color:#8b1a1a;">${clientData.revisionCount || 3}/3回（上限到達）</td></tr>
</table>
${feedbackItems}
${freeTextBlock}
${historyBlock}
<p style="margin-top:16px;font-size:14px;color:#333;background:#fff3cd;padding:12px;border-radius:8px;border-left:4px solid #ffc107;">
  自動修正の上限に達したため、クライアントに「担当者より直接ご連絡いたします」と案内しています。<br>
  直接クライアントに連絡して対応をお願いします。
</p>`;

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
        subject: `【業界紙つくーる】⚠️ 修正上限到達・手動対応必要（${escapeHtml(titleText)}）`,
        html: htmlBody,
      }),
    });
  } catch (err) {
    console.error('Revision limit notification email error:', err.message);
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
