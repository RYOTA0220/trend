// scrape.js
// 要: 環境変数 LINE_CHANNEL_ACCESS_TOKEN, LINE_GROUP_ID
// 動作: Twittrend から「現在」の50位までを取得 → LINEグループへ1通で送信

const { chromium } = require('playwright');
const axios = require('axios');

const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_TO = process.env.LINE_GROUP_ID; // グループID

if (!LINE_TOKEN || !LINE_TO) {
  console.error('環境変数が足りません: LINE_CHANNEL_ACCESS_TOKEN と LINE_GROUP_ID を設定してください。');
  process.exit(1);
}

const TWITTREND_URL = 'https://twittrend.jp/jp';

async function pushToLINE(text) {
  const endpoint = 'https://api.line.me/v2/bot/message/push';

  // 文字数上限対策（5,000文字程度）。安全側で4,500文字で分割。
  const chunks = [];
  let buf = '';
  for (const line of text.split('\n')) {
    if ((buf + '\n' + line).length > 4500) {
      chunks.push(buf);
      buf = line;
    } else {
      buf = buf ? buf + '\n' + line : line;
    }
  }
  if (buf) chunks.push(buf);

  for (const chunk of chunks) {
    await axios.post(
      endpoint,
      {
        to: LINE_TO,
        messages: [{ type: 'text', text: chunk }],
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${LINE_TOKEN}`,
        },
        timeout: 20000,
      }
    );
  }
}

async function scrapeTwittrend() {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-setuid-sandbox',
    ],
  });

  const context = await browser.newContext({
    // 軽量化（画像やフォントの読み込みを抑制）
    javaScriptEnabled: true,
    viewport: { width: 1366, height: 2000 },
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  });

  // 広告・トラッキング由来の遷移やreCAPTCHAを極力避ける
  await context.route('**/*', (route) => {
    const url = route.request().url();
    const block = [
      'doubleclick.net',
      'googlesyndication.com',
      'google-analytics.com',
      'adservice.google.com',
      'adsystem.com',
      'sodar2/runner.html', // ログに出ていたページ
      'recaptcha',
      '/ads?',
    ].some((p) => url.includes(p));

    if (block) route.abort();
    else route.continue();
  });

  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  try {
    // 1) アクセス
    await page.goto(TWITTREND_URL, { waitUntil: 'domcontentloaded' });

    // 2) 下にスクロール（カード群が出る位置まで）
    await page.mouse.wheel(0, 2000);
    await page.waitForTimeout(600);

    // 3) 「現在」セクションを特定
    const currentSection = page.locator('section').filter({
      has: page.locator('h2:has-text("現在")'),
    }).first();

    await currentSection.waitFor({ state: 'visible' });

    // 4) 「21位以下を見る」（現在の列のボタン）をクリック
    const showMoreBtn = currentSection.locator('text=21位以下を見る').first();
    await showMoreBtn.scrollIntoViewIfNeeded();
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {}),
      showMoreBtn.click({ timeout: 5000 }),
    ]);

    // 5) 50位までレンダリング完了を待つ
    await currentSection.locator('ol li').nth(49).waitFor({ state: 'visible' });

    // 6) ランキング抽出
    const items = await currentSection.locator('ol li').allTextContents();

    // 念のため50件に揃える
    const top50 = items.slice(0, 50).map((t, i) => {
      // 「29,984件のツイート」などのサブテキストを除去（見やすさ優先）
      const clean = t.replace(/\s*\d{1,3}(,\d{3})*件のツイート\s*/g, '').trim();
      return `${i + 1}位 ${clean}`;
    });

    const now = new Date();
    const jp = new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(now);

    const header = `🕒 現在のＸトレンド（1〜50位）\n${jp}`;
    const message = header + '\n' + top50.join('\n');

    // 7) LINE送信（1通で改行付き）
    await pushToLINE(message);
    console.log('✅ LINE送信完了');
  } finally {
    await context.close();
    await browser.close();
  }
}

scrapeTwittrend().catch(async (e) => {
  console.error('❌ スクレイプ失敗:', e);
  // 最低限のエラー通知
  try {
    await pushToLINE('⚠️ スクレイプ失敗: ' + (e?.message || e));
  } catch (_) {}
  process.exit(1);
});
