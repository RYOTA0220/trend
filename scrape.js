// scrape.js

const { chromium } = require('playwright');
const axios = require('axios');

// —— 例外は必ずログへ ——
process.on('unhandledRejection', (e) => {
  console.error('[unhandledRejection]', e?.stack || e);
  process.exit(1);
});
process.on('uncaughtException', (e) => {
  console.error('[uncaughtException]', e?.stack || e);
  process.exit(1);
});

const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN; // GitHub Secrets
const LINE_TO_ID = process.env.LINE_TO_ID;                 // 送信先（グループID or userId）
const LINE_API = 'https://api.line.me/v2/bot/message/push';

const log = (...a) => console.log('[scrape]', ...a);

async function sendLineText(to, text) {
  if (!LINE_TOKEN) throw new Error('LINE_CHANNEL_ACCESS_TOKEN が未設定です（GitHub Secrets）');
  const headers = { Authorization: `Bearer ${LINE_TOKEN}` };
  try {
    const res = await axios.post(LINE_API, { to, messages: [{ type: 'text', text }] }, { headers });
    log('LINE push status', res.status);
  } catch (err) {
    console.error('[LINE push error]', err.message, err.response?.data || '');
    throw err;
  }
}

async function scrapeTwittrend() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 1366, height: 1200 } });

  try {
    log('open twittrend');
    await page.goto('https://twittrend.jp/', { waitUntil: 'domcontentloaded', timeout: 60000 });

    // 「日本のトレンド」→ 左端「現在」列の存在を待つ
    await page.waitForSelector('section:has(h2:has-text("現在"))', { timeout: 30000 });

    // 左端「現在」列の「21位以下を見る」を押す（4列の一番左だけ）
    const moreBtn = page.locator('section:has(h2:has-text("現在")) button:has-text("21位以下を")').first();
    await moreBtn.scrollIntoViewIfNeeded();
    await moreBtn.click({ timeout: 15000 });

    // 50位まで描画されるのを待つ
    await page.waitForFunction(
      () => document.querySelectorAll('section:has(h2:has-text("現在")) ol li').length >= 50,
      { timeout: 30000 }
    );

    // 1〜50位を取得（順位ごとに改行）
    const items = await page.locator('section:has(h2:has-text("現在")) ol li').allTextContents();
    const top50 = items.slice(0, 50).map((t, i) => `${i + 1}位 ${t.replace(/\s+/g, ' ').trim()}`);

    const ts = new Date().toLocaleString('ja-JP', { hour12: false });
    const header = `🕒 現在のＸトレンド（1〜50位）\n${ts}`;
    return `${header}\n${top50.join('\n')}`;
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

(async () => {
  const text = await scrapeTwittrend();

  if (!LINE_TO_ID) {
    log('プレビュー（LINE_TO_ID 未設定）\n' + text.slice(0, 500) + ' ...');
  } else {
    await sendLineText(LINE_TO_ID, text);
  }
  log('done');
})();
