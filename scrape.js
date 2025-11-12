// scrape.js
// Twitttrend（日本のトレンド）→「現在」→「21位以下を見る」→1〜50位取得→LINEに1通送信
// 速度最優先：広告/画像/フォント/recaptchaをブロック、確実性：DOM条件で厳密待機

const { chromium } = require('playwright');
const axios = require('axios');

const TWITTREND_URL = 'https://twitttrend.deno.dev/jp';

const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || process.env.TOKEN; // どちらでも可
const LINE_TO = process.env.LINE_GROUP_ID || process.env.LINE_USER_ID || process.env.LINE_TO; // 送信先ID（グループID推奨）

if (!LINE_TOKEN || !LINE_TO) {
  console.error('❌ 環境変数が足りません: LINE_CHANNEL_ACCESS_TOKEN と LINE_GROUP_ID (または LINE_TO) を設定してください。');
  process.exit(1);
}

// --- ネットワークブロック設定（高速＆安定化） ---
const BLOCKED_HOST_PAT = /(doubleclick|googlesyndication|adservice|googletagservices|google-analytics|gpt|recaptcha|analytics)\./i;
const BLOCKED_TYPES = new Set(['image', 'media', 'font']);

// --- ユーティリティ ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowJST = () => {
  const d = new Date();
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${jst.getFullYear()}/${pad(jst.getMonth() + 1)}/${pad(jst.getDate())} ${pad(jst.getHours())}:${pad(jst.getMinutes())}:${pad(jst.getSeconds())}`;
};

// LINE 文字数制限（約5000字）対策：基本は1通で収まるが、超えたら分割
async function pushLine(text) {
  const MAX = 4800; // 余裕を持たせる
  const chunks = [];
  if (text.length <= MAX) {
    chunks.push(text);
  } else {
    let buf = '';
    for (const line of text.split('\n')) {
      if ((buf + '\n' + line).length > MAX) {
        chunks.push(buf);
        buf = line;
      } else {
        buf = buf ? buf + '\n' + line : line;
      }
    }
    if (buf) chunks.push(buf);
  }

  for (const body of chunks) {
    await axios.post(
      'https://api.line.me/v2/bot/message/push',
      { to: LINE_TO, messages: [{ type: 'text', text: body }] },
      { headers: { Authorization: `Bearer ${LINE_TOKEN}`, 'Content-Type': 'application/json' }, timeout: 15000 }
    );
    await sleep(400); // 連投間隔
  }
}

(async () => {
  const browser = await chromium.launch({
    headless: 'shell',              // GitHub Actions で高速
    args: ['--no-sandbox','--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
    viewport: { width: 1366, height: 2000 }, // 縦長でスクロール減らす
    javaScriptEnabled: true,
  });

  const page = await context.newPage();

  // 全リクエストのフィルタ
  await page.route('**/*', (route) => {
    const req = route.request();
    const url = req.url();
    const type = req.resourceType();
    if (BLOCKED_TYPES.has(type) || BLOCKED_HOST_PAT.test(url)) {
      return route.abort();
    }
    return route.continue();
  });

  // ページ全体のデフォルトタイムアウト
  page.setDefaultTimeout(45000);

  console.log('[scrape] ▶ ページ遷移開始');
  await page.goto(TWITTREND_URL, { waitUntil: 'domcontentloaded' });

  // 「現在」セクションを特定（見出し h2: 現在）
  const currentSection = page.locator('section').filter({
    has: page.locator('h2', { hasText: '現在' })
  }).first();

  await currentSection.waitFor({ state: 'visible' });

  // そのセクション内へスクロールしてボタンが見える状態に
  await currentSection.scrollIntoViewIfNeeded();

  // 「21位以下を見る」を “現在” セクション限定で取得
  const viewMoreBtn = currentSection.getByRole('button', { name: '21位以下を見る' });

  await viewMoreBtn.waitFor({ state: 'visible' });
  console.log('[scrape] ▶ 「21位以下を見る」をクリック');
  await viewMoreBtn.click({ delay: 30 });

  // 50件そろうまで待つ（セクション内の <ol><li> が50以上）
  console.log('[scrape] ▶ 50位まで読み込み待機');
  await page.waitForFunction(
    (section) => {
      const ols = section.querySelectorAll('ol');
      let count = 0;
      ols.forEach((ol) => (count += ol.querySelectorAll('li').length));
      return count >= 50;
    },
    await currentSection.elementHandle(),
    { timeout: 35000 }
  );

  // 1〜50位を抽出（“現在” セクション内のみ）
  const items = await currentSection.locator('ol li').allInnerTexts();

  // 万一20件しか見えていない等の安全策でもう一度下端までスクロール→再計測
  if (items.length < 50) {
    await currentSection.evaluate((el) => el.scrollIntoView({ behavior: 'instant', block: 'end' }));
    await page.waitForTimeout(800);
  }
  const texts = await currentSection.locator('ol li').allInnerTexts();

  const top50 = texts.slice(0, 50).map((t) => {
    // li 内の文を「N位 タイトル」形式へ整形
    // 例: "1. ゴールデングラブ賞\n29,984件のツイート" → "1位 ゴールデングラブ賞"
    const line = t.replace(/\r/g, '').split('\n')[0] || t.trim();
    const m = line.match(/^\s*(\d+)\.\s*(.+)$/);
    if (m) return `${m[1]}位 ${m[2].trim()}`;
    return line.replace(/^\s*•\s*/, '').trim();
  });

  if (top50.length < 50) {
    throw new Error(`取得数が不足しています（${top50.length}/50）。サイトの構造が変わった可能性があります。`);
  }

  // 送信用メッセージ
  const header = `🕒 現在のＸトレンド（1〜50位）\n${nowJST()}`;
  const body = header + '\n' + top50.join('\n');

  console.log('[scrape] ▶ LINE送信開始');
  await pushLine(body);
  console.log('[scrape] ✅ 完了');

  await browser.close();
})().catch(async (err) => {
  console.error('❌ スクレイプ失敗:', err?.message || err);
  // 失敗通知（任意）
  try {
    if (LINE_TOKEN && LINE_TO) {
      await axios.post(
        'https://api.line.me/v2/bot/message/push',
        { to: LINE_TO, messages: [{ type: 'text', text: `❗スクレイプ失敗: ${err?.message || err}` }] },
        { headers: { Authorization: `Bearer ${LINE_TOKEN}`, 'Content-Type': 'application/json' }, timeout: 10000 }
      );
    }
  } catch {}
  process.exit(1);
});
