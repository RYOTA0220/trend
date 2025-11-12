// scrape.js - Twittrend「現在」トレンド1〜50位を取得してLINEに送信
// 必要な環境変数: LINE_CHANNEL_ACCESS_TOKEN, LINE_GROUP_ID

const { chromium } = require('playwright');
const axios = require('axios');

const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_TO = process.env.LINE_GROUP_ID;

if (!LINE_TOKEN || !LINE_TO) {
  console.error("環境変数が足りません: LINE_CHANNEL_ACCESS_TOKEN と LINE_GROUP_ID を設定してください。");
  process.exit(1);
}

const TWITTREND_URL = 'https://twittrend.jp/';

async function scrapeNowTop50(page) {
  // 左端の「現在」リストのみを操作
  const list = page.locator('#list_now li');
  const moreBtn = page.locator('#more_btn_now');

  // 一旦ページを少し下にスクロール（描画安定）
  await page.mouse.wheel(0, 800);
  await page.waitForTimeout(1000);

  // リストが20件以上あることを確認（初期状態）
  await list.nth(0).waitFor({ state: 'visible', timeout: 15000 });

  // 「21位以下を見る」ボタンが見えるまで待ってクリック
  await moreBtn.scrollIntoViewIfNeeded();
  await moreBtn.waitFor({ state: 'visible', timeout: 10000 });
  await moreBtn.click({ timeout: 10000 });

  // liが50件になるまで待機（確実な方法）
  await page.waitForFunction(() => {
    const els = document.querySelectorAll('#list_now li');
    return els && els.length >= 50;
  }, { timeout: 15000 });

  // リストを取得（最大50件）
  const count = await list.count();
  const max = Math.min(count, 50);
  const ranks = [];
  for (let i = 0; i < max; i++) {
    const t = (await list.nth(i).innerText()).trim();
    const cleaned = t.replace(/^\s*\d+\.\s*/, '');
    ranks.push(`${i + 1}位 ${cleaned}`);
  }

  return ranks;
}

async function sendToLine(text) {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${LINE_TOKEN}`,
  };
  const body = {
    to: LINE_TO,
    messages: [{ type: 'text', text }],
  };
  const url = 'https://api.line.me/v2/bot/message/push';
  const res = await axios.post(url, body, { headers });
  return res.status;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 2000 } });

  try {
    await page.goto(TWITTREND_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const ranks = await scrapeNowTop50(page);

    const now = new Date();
    const jp = new Intl.DateTimeFormat('ja-JP', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false, timeZone: 'Asia/Tokyo'
    }).format(now);

    const header = `🕐 現在のＸトレンド（1〜50位）\n${jp}`;
    const body = ranks.join('\n');
    const payload = `${header}\n\n${body}`;

    const status = await sendToLine(payload);
    console.log('LINE push status:', status);
  } catch (e) {
    console.error('[SCRAPE ERROR]', e?.message || e);
    try {
      await sendToLine(`⚠️ 取得失敗: ${e?.message || e}`);
    } catch {}
    process.exit(1);
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
})();
