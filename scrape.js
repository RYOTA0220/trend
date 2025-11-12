// scrape.js
// Twittrend（Xトレンド）を取得してLINEに送信するスクリプト（完全版・2025年11月対応）

const { chromium } = require('playwright');
const axios = require('axios');

// ======== 環境変数 ========
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN; // LINE公式BOTのトークン
const LINE_TO_ID = process.env.LINE_TO_ID;                 // 送信先（グループ・ユーザーID）
const LINE_API = 'https://api.line.me/v2/bot/message/push';

// ======== ログ＆エラー処理 ========
const log = (...args) => console.log('[scrape]', ...args);
process.on('unhandledRejection', e => { console.error('[unhandledRejection]', e); process.exit(1); });
process.on('uncaughtException', e => { console.error('[uncaughtException]', e); process.exit(1); });

// ======== LINE送信関数 ========
async function sendLineText(to, text) {
  if (!LINE_TOKEN) throw new Error('❌ LINE_CHANNEL_ACCESS_TOKEN が未設定です');
  const headers = { Authorization: `Bearer ${LINE_TOKEN}` };
  const body = { to, messages: [{ type: 'text', text }] };
  const res = await axios.post(LINE_API, body, { headers });
  log('✅ LINE送信完了:', res.status);
}

// ======== Twittrendスクレイピング ========
async function scrapeTwittrend() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage({ viewport: { width: 1366, height: 1200 } });

  try {
    log('🌐 Twittrendにアクセス中...');
    await page.goto('https://twittrend.jp/', { waitUntil: 'domcontentloaded', timeout: 60000 });

    // 「現在」セクションを取得
    const currentSection = page.locator('section').filter({
      has: page.locator('h2', { hasText: '現在' }),
    }).first();

    await currentSection.scrollIntoViewIfNeeded();

    // 「21位以下を見る」をクリック
    const moreBtn = currentSection.getByRole('button', { name: '21位以下を見る' }).first();
    await moreBtn.waitFor({ state: 'visible', timeout: 20000 });
    await moreBtn.click();

    // li が 50個になるまで待機（最大60秒）
    log('📊 ランキング展開中...');
    await page.waitForFunction(
      () => document.querySelectorAll('section h2') &&
        Array.from(document.querySelectorAll('section')).some(sec =>
          sec.querySelector('h2')?.innerText.includes('現在') &&
          sec.querySelectorAll('ol li').length >= 50
        ),
      { timeout: 60000 }
    );

    // 50位分の li を抽出
    log('✅ トレンド取得中...');
    const items = currentSection.locator('ol li');
    const count = await items.count();
    const lines = [];

    for (let i = 0; i < Math.min(count, 50); i++) {
      const li = items.nth(i);
      let text = '';
      if (await li.locator('a').first().isVisible().catch(() => false)) {
        text = await li.locator('a').first().innerText();
      } else {
        text = await li.innerText();
      }
      text = text.replace(/\d{1,3}(,\d{3})*件のツイート/g, '').trim();
      lines.push(`${i + 1}位 ${text}`);
    }

    // 出力用テキスト整形
    const now = new Date(Date.now() + 9 * 60 * 60 * 1000); // JST
    const header = `🕒 現在のXトレンド（1〜50位）\n${now.toISOString().replace('T', ' ').slice(0, 19)}`;
    const result = `${header}\n${lines.join('\n')}`;
    return result;

  } catch (err) {
    console.error('❌ スクレイプ失敗:', err);
    throw err;
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

// ======== メイン処理 ========
(async () => {
  const text = await scrapeTwittrend();

  if (!LINE_TO_ID) {
    log('⚠️ LINE_TO_ID 未設定。結果プレビュー:\n' + text.slice(0, 300));
  } else {
    await sendLineText(LINE_TO_ID, text);
  }

  log('🎉 完了');
})();
