// Playwrightで 21位以降ボタンをクリックしてから 1〜50位を取得し、LINEに送信
const { chromium } = require("playwright");
const axios = require("axios");

const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;      // Secrets
const GROUP_ID = process.env.LINE_TARGET_GROUP_ID;        // Secrets
const LINE_PUSH_API = "https://api.line.me/v2/bot/message/push";
const URL = "https://twittrend.jp/";

// 1000文字で分割（読みやすさ＋制限対策）
const chunk = (s, n = 1000) => s.match(new RegExp(`(.|\\n){1,${n}}`, "g")) || [];

async function pushToLine(texts) {
  for (const text of texts) {
    await axios.post(
      LINE_PUSH_API,
      { to: GROUP_ID, messages: [{ type: "text", text }] },
      { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, timeout: 30000 }
    );
    await new Promise(r => setTimeout(r, 400));
  }
}

async function scrapeTrends() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 2000 } });
  try {
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });

    // ゆっくり最下部までスクロール（遅延表示対策）
    await page.evaluate(async () => {
      await new Promise((res) => {
        let y = 0;
        const timer = setInterval(() => {
          y += 800;
          window.scrollTo(0, y);
          if (y >= document.body.scrollHeight) { clearInterval(timer); res(); }
        }, 120);
      });
    });

    // 「現在の21位以降を見る」ボタンをクリック（表記ゆれに強いマッチ）
    const candidates = [
      '現在の21位以降を見る',
      '現在の21以降を見る',
      '21位以降',
    ];
    let clicked = false;
    for (const label of candidates) {
      const el = page.getByText(label, { exact: false });
      if (await el.first().isVisible().catch(() => false)) {
        await el.first().click();
        clicked = true;
        break;
      }
    }
    if (!clicked) {
      // テキストが変わった場合のフォールバック：button/リンク類から探索
      const el = await page.locator('button:has-text("21"), a:has-text("21")').first();
      if (await el.isVisible().catch(() => false)) {
        await el.click();
        clicked = true;
      }
    }

    // クリック後の描画待ち
    await page.waitForTimeout(800);

    // ランキング抽出（複数パターンに対応）
    const trends = await page.evaluate(() => {
      const texts = [];

      // 一般的な ordered list
      document.querySelectorAll('ol li').forEach(li => {
        const t = (li.textContent || '').replace(/\s+/g, ' ').trim();
        if (t) texts.push(t);
      });

      // trendリンク
      document.querySelectorAll('a[href*="/trend/"]').forEach(a => {
        const t = (a.textContent || '').replace(/\s+/g, ' ').trim();
        if (t) texts.push(t);
      });

      // data-rank 等
      document.querySelectorAll('[data-rank], .rank, .ranking').forEach(el => {
        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (t) texts.push(t);
      });

      // 「n位 〜」形式に正規化
      const rankMap = new Map();
      for (const s of texts) {
        const m = s.match(/^(\d+)[位\.]?\s*(.*)$/);
        if (!m) continue;
        const r = Number(m[1]);
        const label = (m[2] || '').trim();
        if (r >= 1 && r <= 50 && !rankMap.has(r)) rankMap.set(r, label || s);
      }

      if (rankMap.size >= 10) {
        return Array.from(rankMap.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([r, label]) => `${r}位 ${label}`);
      }

      // フォールバック（ページ上部から50件）
      const uniq = Array.from(new Set(texts));
      return uniq.slice(0, 50).map((t, i) => `${i + 1}位 ${t}`);
    });

    await browser.close();
    return trends.slice(0, 50);
  } catch (e) {
    await browser.close();
    throw e;
  }
}

(async () => {
  try {
    const items = await scrapeTrends();
    const header = `🕒 現在のＸトレンド（1〜50位）\n${new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}`;
    const body = items.map(s => `・${s}`).join("\n") || '※ 取得できませんでした。サイト構造が変わった可能性があります。';

    for (const part of chunk(`${header}\n\n${body}`)) {
      await pushToLine(part);
    }
    console.log("Done");
  } catch (err) {
    console.error("Failed:", err);
    try {
      await pushToLine([`❗スクレイプ失敗: ${String(err).slice(0, 900)}`]);
    } catch {}
    process.exit(1);
  }
})();
