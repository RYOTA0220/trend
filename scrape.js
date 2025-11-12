const { chromium } = require('playwright');
const axios = require('axios');

(async () => {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  const groupId = process.env.LINE_GROUP_ID;
  if (!token || !groupId) {
    console.error("環境変数が足りません: LINE_CHANNEL_ACCESS_TOKEN と LINE_GROUP_ID を設定してください。");
    process.exit(1);
  }

  console.log("[scrape] ▶ ランチャー起動…");
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-setuid-sandbox"
    ]
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 2000 },
    userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari"
  });

  // 画像/フォント等はブロックして高速化
  await context.route('**/*', route => {
    const req = route.request();
    const type = req.resourceType();
    if (["image", "font", "media", "stylesheet"].includes(type)) {
      route.abort();
    } else {
      route.continue();
    }
  });

  const page = await context.newPage();

  try {
    console.log("[scrape] ▶ twittrendへ");
    await page.goto('https://twittrend.jp/', { timeout: 45000, waitUntil: 'domcontentloaded' });

    // 十分に下までスクロール（lazy領域を出す）
    await autoScroll(page);

    // 「現在」セクションを特定（見出しh2に“現在”を含む列）
    const nowSection = page.locator('section').filter({ has: page.locator('h2:has-text("現在")') }).first();
    await nowSection.waitFor({ state: 'visible', timeout: 30000 });

    // 左端の「21位以下を見る」をクリック（“現在”列の中のボタン）
    const moreBtn = nowSection.getByRole('button', { name: /21位以下を見る/ });
    await moreBtn.first().scrollIntoViewIfNeeded();
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 30000 }),
      moreBtn.first().click()
    ]);

    // 50位まで並んだ <ol><li> を取得（“現在”列のみ対象）
    // 1〜20位：最初のol、21〜50位：ボタン押下後の追加ol という構造想定。全部の li を連結。
    const items = await nowSection.locator('ol li').allTextContents();

    // 見やすく 1行1順位に整形
    const lines = items
      .map(s => s.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .map((t, i) => `${i + 1}位 ${t}`);

    // 念のため 50件に制限
    const top50 = lines.slice(0, 50);
    const header = `🕒 現在のＸトレンド（1〜50位）\n${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`;
    const body = header + "\n\n" + top50.join("\n");

    // LINE PUSH（グループに1メッセージ）
    await linePush(token, groupId, body);
    console.log("[scrape] ▶ 送信完了");
  } catch (e) {
    console.error("❌ スクレイプ失敗:", e);
    await linePush(token, groupId, "❗スクレイプ失敗：エラーが発生しました。");
    process.exit(1);
  } finally {
    await context.close();
    await browser.close();
  }
})();

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let total = 0;
      const dist = 800;
      const timer = setInterval(() => {
        window.scrollBy(0, dist);
        total += dist;
        if (total >= document.body.scrollHeight * 1.2) {
          clearInterval(timer);
          resolve();
        }
      }, 120);
    });
  });
}

async function linePush(token, to, text) {
  const res = await axios.post(
    'https://api.line.me/v2/bot/message/push',
    { to, messages: [{ type: 'text', text }] },
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (res.status !== 200) {
    console.error("LINE PUSH 失敗:", res.status, res.data);
  }
}
