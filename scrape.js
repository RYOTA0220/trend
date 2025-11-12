// scrape.js
const { chromium } = require('playwright');
const axios = require('axios');

const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_TO    = process.env.LINE_GROUP_ID;

if (!LINE_TOKEN || !LINE_TO) {
  console.error('環境変数が足りません: LINE_CHANNEL_ACCESS_TOKEN / LINE_GROUP_ID');
  process.exit(1);
}

const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119 Safari/537.36',
    viewport: { width: 1366, height: 900 }
  });
  const page = await ctx.newPage();

  try {
    // 1) アクセス
    await page.goto('https://twittrend.jp/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(()=>{});

    // 2) ちょいスクロール（ボタンを画面内へ）
    await page.mouse.wheel(0, 800);
    await sleep(300);

    // 3) 「現在」列の "21位以下を見る" をクリック（id 固定：#more_btn_now）
    const seeMoreNow = page.locator('#more_btn_now');
    await seeMoreNow.waitFor({ state: 'attached', timeout: 10_000 });
    await seeMoreNow.scrollIntoViewIfNeeded();
    await seeMoreNow.click({ timeout: 10_000 });

    // 4) 「現在」列だけの LI を 50件揃うまで待つ
    // 　パネルIDは #panel_now（中に <ol><li>...）
    const nowLis = page.locator('#panel_now ol li');
    await page.waitForFunction(
      (sel) => document.querySelectorAll(sel).length >= 50,
      '#panel_now ol li',
      { timeout: 30_000 }
    );

    // 5) 1〜50位を抽出（順位ごとに改行）
    const items = await nowLis.evaluateAll(nodes =>
      nodes.slice(0,50).map((li,i) => `${i+1}位 ${ (li.textContent||'').replace(/\s+/g,' ').trim() }`)
    );

    const stamp = new Date().toISOString().replace('T',' ').slice(0,19);
    const header = `🕒 現在のＸトレンド（1〜50位）\n${stamp}`;
    const message = `${header}\n${items.join('\n')}`;

    // 6) LINEへ一括送信（長すぎる時のみ分割）
    const chunks = message.length <= 1900
      ? [message]
      : [ `${header}\n${items.slice(0,25).join('\n')}`, items.slice(25).join('\n') ];

    for (const text of chunks) {
      await axios.post(
        'https://api.line.me/v2/bot/message/push',
        { to: LINE_TO, messages: [{ type:'text', text }] },
        { headers: { Authorization: `Bearer ${LINE_TOKEN}` } }
      );
      await sleep(200);
    }

    console.log('✅ 送信完了');
  } catch (e) {
    console.error('❌ 失敗:', e.message);
    throw e;
  } finally {
    await page.close().catch(()=>{});
    await ctx.close().catch(()=>{});
    await browser.close().catch(()=>{});
  }
})();
