// scrape.js
const { chromium } = require('playwright');
const axios = require('axios');

process.on('unhandledRejection', e => { console.error(e); process.exit(1); });
process.on('uncaughtException', e => { console.error(e); process.exit(1); });

const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN; // GitHub Secrets
const LINE_TO   = process.env.LINE_TO_ID;                 // グループIDまたはuserId
const LINE_API  = 'https://api.line.me/v2/bot/message/push';

async function sendLine(text) {
  if (!LINE_TOKEN || !LINE_TO) throw new Error('LINE_CHANNEL_ACCESS_TOKEN / LINE_TO_ID が未設定です');
  const headers = { Authorization: `Bearer ${LINE_TOKEN}` };
  await axios.post(LINE_API, { to: LINE_TO, messages: [{ type: 'text', text }] }, { headers });
}

(async () => {
  // できるだけ安定するブラウザ設定
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']
  });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119 Safari/537.36',
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo'
  });
  const page = await context.newPage({ viewport: { width: 1366, height: 1400 } });

  try {
    console.log('[scrape] open');
    await page.goto('https://twittrend.jp/', { waitUntil: 'domcontentloaded', timeout: 60000 });

    // 日本のトレンド「現在」列の20位までが描画されるのを待つ
    await page.waitForSelector('#list_now li', { timeout: 30000 });

    // “21位以下を見る” ボタンを確実に押す（id 直指定 + フォールバック）
    const btn = page.locator('#more_btn_now');
    await btn.scrollIntoViewIfNeeded();
    try {
      await btn.click({ timeout: 5000, trial: true }); // クリック可能性チェック
      await btn.click({ timeout: 5000 });
    } catch {
      // うまく押せない場合はネイティブクリック
      await page.evaluate(() => {
        const b = document.getElementById('more_btn_now');
        if (b) b.click();
      });
    }

    // 50件に増えたことをidで確認
    await page.waitForFunction(
      () => document.querySelectorAll('#list_now li').length >= 50,
      { timeout: 30000 }
    );

    // 1〜50位のテキストを収集
    const top50 = await page.$$eval('#list_now li', els =>
      els.slice(0, 50).map((el, i) => {
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        return `${i + 1}位 ${t}`;
      })
    );

    const ts = new Date().toLocaleString('ja-JP', { hour12: false });
    const body = `🕒 現在のＸトレンド（1〜50位）\n${ts}\n` + top50.join('\n');

    await sendLine(body);
    console.log('[scrape] sent to LINE');
  } finally {
    await page.close().catch(()=>{});
    await context.close().catch(()=>{});
    await browser.close().catch(()=>{});
  }
})();
