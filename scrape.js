// scrape.js
const { chromium } = require('playwright');
// Node.js v20 なら fetch はグローバル。node-fetch は不要。

const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN; // GitHub Secrets
const LINE_TO    = process.env.LINE_GROUP_ID;             // グループID or ユーザーID

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
    viewport: { width: 1400, height: 1000 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(45000);

  try {
    // 1) アクセス
    await page.goto('https://twittrend.jp/', { waitUntil: 'domcontentloaded' });

    // 2) 下にスクロール（ボタンを確実に可視化）
    await page.mouse.wheel(0, 1200);

    // 3) 「現在」列の「21位以下を見る」を ID でクリック（左端の列）
    const moreBtn = page.locator('#more_btn_now');
    await moreBtn.waitFor({ state: 'visible', timeout: 15000 });
    await moreBtn.scrollIntoViewIfNeeded();
    await moreBtn.click();

    // 4) 50位まで出るのを待つ（ID 固定のリスト）
    const listLoc = page.locator('#list_now li');
    await listLoc.nth(49).waitFor({ state: 'visible', timeout: 15000 });

    // 5) 1〜50位のテキストを抽出・整形
    const items = await listLoc.evaluateAll(nodes =>
      nodes.slice(0, 50).map(n => (n.textContent || '').replace(/\s+/g, ' ').trim())
    );
    const lines = items.map((t, i) => `${i + 1}位 ${t.replace(/^\d+\.?\s*/, '')}`);

    const now = new Date();
    const ts = now.toISOString().replace('T', ' ').slice(0, 19);
    const message = `🕰 現在のＸトレンド（1〜50位）\n${ts}\n` + lines.join('\n');

    // 6) LINE に送信
    if (!LINE_TOKEN || !LINE_TO) throw new Error('LINE 環境変数が未設定です');
    const res = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${LINE_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ to: LINE_TO, messages: [{ type: 'text', text: message }] }),
    });
    if (!res.ok) throw new Error(`LINE Push failed: ${res.status} ${await res.text()}`);

    await browser.close();
    process.exit(0);
  } catch (err) {
    console.error('[SCRAPE ERROR]', err);
    await browser.close();
    process.exit(1);
  }
})();
