// scrape.js - Twittrend「現在」1〜50位を取得してLINEに送信
// 必須Secrets: LINE_CHANNEL_ACCESS_TOKEN, LINE_GROUP_ID

const { chromium } = require('playwright');
const axios = require('axios');

// ---- 例外は必ずログに出して終了 ----
process.on('unhandledRejection', (e) => {
  console.error('[unhandledRejection]', e?.stack || e);
  process.exit(1);
});
process.on('uncaughtException', (e) => {
  console.error('[uncaughtException]', e?.stack || e);
  process.exit(1);
});

// ---- 環境変数（GitHub Secrets）----
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN; // Botのチャネルアクセストークン
const LINE_TO    = process.env.LINE_GROUP_ID;             // 送信先グループID（roomIdでも可）

// ---- 定数 ----
const TWITTREND_URL = 'https://twittrend.jp/';
const LINE_PUSH_API = 'https://api.line.me/v2/bot/message/push';

const log = (...a) => console.log('[scrape]', ...a);

// ---- LINE送信 ----
async function sendLineText(to, text) {
  if (!LINE_TOKEN) throw new Error('LINE_CHANNEL_ACCESS_TOKEN が未設定です');
  if (!to)        throw new Error('LINE_GROUP_ID が未設定です');

  const headers = {
    'Authorization': `Bearer ${LINE_TOKEN}`,
    'Content-Type': 'application/json',
  };
  const body = { to, messages: [{ type: 'text', text }] };

  const res = await axios.post(LINE_PUSH_API, body, { headers });
  log('LINE push status', res.status);
}

// ---- Twittrend「現在」列を1〜50位まで取得 ----
async function scrapeNowTop50(page) {
  // 左端の「現在」列は安定したIDが付いている
  //   ・現在のリスト:  #list_now > li
  //   ・21位以下ボタン: #more_btn_now
  // まずDOMが生えるのを待つ
  await page.waitForSelector('#list_now li', { timeout: 30000 });

  // ちらつき対策で少しスクロール＆待機
  await page.mouse.wheel(0, 800);
  await page.waitForTimeout(700);

  // 「21位以下を見る」を押す（左端列のみ）
  const moreBtn = page.locator('#more_btn_now');
  await moreBtn.scrollIntoViewIfNeeded();
  await moreBtn.waitFor({ state: 'visible', timeout: 10000 });
  await moreBtn.click({ timeout: 10000 });

  // liが50件になるまで待つ（これが一番確実）
  await page.waitForFunction(() => {
    const els = document.querySelectorAll('#list_now li');
    return els && els.length >= 50;
  }, { timeout: 20000 });

  // 取得
  const items = await page.locator('#list_now li').allInnerTexts();
  const top50 = items.slice(0, 50).map((t, i) => {
    // 先頭の「1. 〜」などを消して整形
    const cleaned = t.replace(/^\s*\d+\.\s*/, '').replace(/\s+/g, ' ').trim();
    return `${i + 1}位 ${cleaned}`;
  });

  return top50;
}

// ---- メイン ----
(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 1366, height: 2000 } });

  try {
    log('open', TWITTREND_URL);
    await page.goto(TWITTREND_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

    const ranks = await scrapeNowTop50(page);

    const ts = new Intl.DateTimeFormat('ja-JP', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false, timeZone: 'Asia/Tokyo'
    }).format(new Date());

    const header = `🕐 現在のＸトレンド（1〜50位）\n${ts}`;
    const text = `${header}\n\n${ranks.join('\n')}`;

    await sendLineText(LINE_TO, text);
    log('done');
  } catch (e) {
    console.error('[SCRAPE ERROR]', e?.message || e);
    // 失敗も通知（通知で原因追跡が楽）
    try { await sendLineText(LINE_TO, `⚠️ 取得失敗: ${e?.message || e}`); } catch {}
    process.exit(1);
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
})();
