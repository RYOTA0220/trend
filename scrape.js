// scrape.js
const { chromium } = require('playwright');
const fetch = require('node-fetch');

const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;  // GitHub Secrets
const LINE_TO    = process.env.LINE_GROUP_ID;              // グループID or ユーザID

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
    viewport: { width: 1400, height: 1000 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(45_000);

  try {
    console.log('[nav] goto twittrend');
    await page.goto('https://twittrend.jp/', { waitUntil: 'domcontentloaded' });

    // ちょいスクロールしてレイアウト確定
    await page.mouse.wheel(0, 1200);

    // 「現在」セクションを Playwright のロケータで特定
    const currentSection = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: '現在' }) })
      .first();

    // 左端カラムの「21位以下を見る」を押す（セクション内で限定）
    const moreBtn = currentSection.getByRole('button', { name: '21位以下を見る' });
    await moreBtn.scrollIntoViewIfNeeded();
    await moreBtn.click();

    // 50件そろうまで待つ（最大 15s）
    const listLoc = currentSection.locator('ol li');
    let ok = false;
    for (let i = 0; i < 30; i++) { // 30 * 500ms = 15s
      const n = await listLoc.count();
      if (n >= 50) { ok = true; break; }
      await page.waitForTimeout(500);
    }
    if (!ok) throw new Error('50位まで展開されませんでした');

    // 1〜50 のテキストを抽出
    const items = await listLoc.allTextContents(); // 50件分の "1. 〜" のテキストが入る
    // もし番号が付与されていない場合は自前で付ける
    const lines = items.slice(0, 50).map((t, i) => {
      const clean = t.replace(/\s+/g, ' ').trim();
      return `${i + 1}位 ${clean.replace(/^\d+\.\s*/, '')}`;
    });

    // ヘッダ＋本文（1送信で収まる）
    const now = new Date();
    const ts = now.toISOString().replace('T', ' ').slice(0, 19);
    const header = `🕰 現在のＸトレンド（1〜50位）\n${ts}`;
    const body = lines.join('\n');
    const message = `${header}\n${body}`;

    // LINE 送信
    console.log('[line] push message len=', message.length);
    await pushToLine(message);

    console.log('[done] success');
    await browser.close();
    process.exit(0);
  } catch (e) {
    console.error('[error]', e);
    await browser.close();
    process.exit(1);
  }

  async function pushToLine(text) {
    if (!LINE_TOKEN || !LINE_TO) {
      throw new Error('環境変数 LINE_CHANNEL_ACCESS_TOKEN / LINE_GROUP_ID が未設定');
    }
    const res = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${LINE_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ to: LINE_TO, messages: [{ type: 'text', text }] }),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`LINE Push failed: ${res.status} ${t}`);
    }
  }
})();
