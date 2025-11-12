// scrape.js - Twittrend(日本)の「現在」1〜50位を取得してLINEに送る
// 必要な環境変数: LINE_CHANNEL_ACCESS_TOKEN, LINE_GROUP_ID

const { chromium } = require('playwright'); // CJSでOK
const axios = require('axios');

const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_TO = process.env.LINE_GROUP_ID;

if (!LINE_TOKEN || !LINE_TO) {
  console.error("環境変数が足りません: LINE_CHANNEL_ACCESS_TOKEN と LINE_GROUP_ID を設定してください。");
  process.exit(1);
}

const TWITTREND_URL = 'https://twittrend.jp/';

// 左端の「現在」カードを確実に掴むロケータ
async function getNowSection(page) {
  // 見出しが「現在」の section にスコープ
  const section = page.locator('section').filter({
    has: page.getByRole('heading', { name: '現在' })
  }).first();

  await section.waitFor({ state: 'visible', timeout: 15000 });
  return section;
}

async function clickMore21(section) {
  // セクション内の「21位以下を見る」をクリック（左端に限定）
  const moreBtn = section.getByRole('button', { name: /21位以下を見る/ });
  // Playwrightのstrict違反を避けるため first() 明示
  await moreBtn.first().click({ timeout: 10000 }).catch(async () => {
    // フォールバック: 既知のID（左端は #more_btn_now）
    const fallback = section.locator('#more_btn_now');
    await fallback.click({ timeout: 8000 });
  });
}

async function scrapeNowTop50(page) {
  const section = await getNowSection(page);

  // クリックで展開
  await clickMore21(section);

  // 1〜50の <ol><li> … を待つ（左端のカード内だけ）
  const items = section.locator('ol li');
  await items.nth(49).waitFor({ state: 'visible', timeout: 15000 }); // 0-indexで50番目

  // 抽出
  const count = await items.count();
  const max = Math.min(count, 50);
  const ranks = [];
  for (let i = 0; i < max; i++) {
    const t = (await items.nth(i).innerText()).trim();
    // 「1. キーワード」形式が多いので整形（数字と点を除去）
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
    messages: [{ type: 'text', text }]
  };
  const url = 'https://api.line.me/v2/bot/message/push';
  const res = await axios.post(url, body, { headers });
  return res.status;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 2000 }
  });

  try {
    await page.goto(TWITTREND_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // 軽くスクロールして初期化
    await page.mouse.wheel(0, 1000);
    await page.waitForTimeout(400);

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
    // エラー内容もLINEに通知したい場合は下記を有効化
    // try { await sendToLine(`⚠️ 取得失敗: ${e?.message || e}`); } catch {}
    process.exit(1);
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
})();
