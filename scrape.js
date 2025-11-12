// 安定クリック＋50件出現までポーリングで待つ版
const { chromium } = require('playwright');

const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_TO    = process.env.LINE_GROUP_ID;

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1400, height: 1000 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(45000);

  try {
    // 1) アクセス → 1回だけ下スクロール（ボタン可視化のため）
    await page.goto('https://twittrend.jp/', { waitUntil: 'domcontentloaded' });
    await page.mouse.wheel(0, 1200);

    // 2) 左端「現在」の“21位以下を見る”を確実クリック（JS直叩き → フォールバック3通り）
    const clickMoreNow = async () => {
      // まずID直叩き（最も安定）
      const ok = await page.evaluate(() => {
        const btn = document.querySelector('#more_btn_now');
        if (btn) { (btn as HTMLElement).click(); return true; }
        return false;
      });
      if (ok) return;
      // 代替1: data-target属性由来の開閉ボタン（稀なケース）
      const alt1 = page.locator('#more_btn_now, button#more_btn_now');
      if (await alt1.count()) { await alt1.first().click(); return; }
      // 代替2: 「現在」セクション内のボタン群からテキスト一致で選択（strict回避）
      const sec = page.locator("section").filter({ has: page.locator('h2:has-text("現在")') }).first();
      const cand = sec.locator('button');
      const n = await cand.count();
      for (let i = 0; i < n; i++) {
        const t = (await cand.nth(i).innerText()).trim();
        if (t.includes('21位以下を見る')) { await cand.nth(i).click(); return; }
      }
      throw new Error('「現在」列の 21位以下ボタンが見つかりません');
    };
    await clickMoreNow();

    // 3) 50件出現までポーリング（取りこぼし防止の再クリック付き）
    const waitListTo50 = async () => {
      const start = Date.now();
      let retries = 0;
      while (Date.now() - start < 15000) {
        const count = await page.evaluate(() =>
          document.querySelectorAll('#list_now li').length
        );
        if (count >= 50) return;
        // まだなら軽くスクロールして再クリック（クリック取りこぼし対策）
        if (retries % 5 === 0) {
          await page.mouse.wheel(0, 400);
          await clickMoreNow().catch(() => {});
        }
        await page.waitForTimeout(200);
        retries++;
      }
      throw new Error('50位まで表示されませんでした（タイムアウト）');
    };
    await waitListTo50();

    // 4) 1〜50のテキスト抽出（左端「現在」列のみ）
    const lines = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('#list_now li'))
        .slice(0, 50)
        .map((li, i) => {
          const raw = (li.textContent || '').replace(/\s+/g, ' ').trim();
          // li 先頭に「1.」「1位」等が入っていても綺麗に
          const cleaned = raw.replace(/^\d+([\.位])?\s*/, '');
          return `${i + 1}位 ${cleaned}`;
        });
      return items;
    });

    // 5) LINEへ送信
    if (!LINE_TOKEN || !LINE_TO) throw new Error('LINE 環境変数が未設定です');
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const text = `🕰 現在のＸトレンド（1〜50位）\n${now}\n` + lines.join('\n');

    const res = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${LINE_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ to: LINE_TO, messages: [{ type: 'text', text }] }),
    });
    if (!res.ok) throw new Error(`LINE Push failed: ${res.status} ${await res.text()}`);

    await browser.close();
    process.exit(0);
  } catch (e) {
    console.error('[SCRAPE ERROR]', e);
    await browser.close();
    process.exit(1); // ← これが GitHub の “exit code 1”
  }
})();
