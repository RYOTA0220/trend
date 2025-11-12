// 現在（左端列）の「21位以下を見る」をクリック → その列から 1〜50位を取得して
// 1順位ごとに改行して LINE に送信する高速版。
const { chromium } = require("playwright");
const axios = require("axios");

const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const GROUP_ID = process.env.LINE_TARGET_GROUP_ID;
const LINE_PUSH_API = "https://api.line.me/v2/bot/message/push";
const URL = "https://twittrend.jp/";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

// ---- LINE送信ユーティリティ（400回避） ----
const sanitize = (s) =>
  (s || "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/[ \t\v\f]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
const split1000 = (s) => (sanitize(s).match(/[\s\S]{1,1000}/g) || []);

async function pushText(text) {
  if (!text?.trim()) return;
  await axios.post(
    LINE_PUSH_API,
    { to: GROUP_ID, messages: [{ type: "text", text }] },
    {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    }
  );
}
async function pushChunks(full) {
  for (const part of split1000(full)) {
    await pushText(part);
    await new Promise((r) => setTimeout(r, 300));
  }
}

// ---- スクレイピング本体（通信ブロックで高速化） ----
async function scrapeTrends() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({
    userAgent: UA,
    locale: "ja-JP",
    viewport: { width: 1200, height: 1600 },
  });
  const page = await context.newPage();

  // 画像/フォント/広告をブロック → 軽量化
  await page.route("**/*", (route) => {
    const type = route.request().resourceType();
    const url = route.request().url();
    if (["image", "font", "media", "stylesheet"].includes(type)) return route.abort();
    if (/\b(ads|doubleclick|googletag|adservice|taboola|criteo)\b/i.test(url)) return route.abort();
    route.continue();
  });

  try {
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 45000 });

    // 4列の「21位以下を見る」から、x座標が最小（左端＝現在）のボタンを選ぶ
    const btns = page.locator('text=21位以下を見る');
    const n = await btns.count();
    if (!n) throw new Error('「21位以下を見る」ボタンが見つかりません');

    let target = null;
    let minX = Infinity;
    for (let i = 0; i < n; i++) {
      const b = btns.nth(i);
      if (!(await b.isVisible().catch(() => false))) continue;
      const box = await b.boundingBox();
      if (box && box.x < minX) {
        minX = box.x;
        target = b;
      }
    }
    if (!target) throw new Error("左端ボタン特定失敗");

    // クリック（Playwrightが見える位置まで自動スクロールしてくれる）
    await target.click({ timeout: 5000 });
    await page.waitForTimeout(600); // 展開待ち

    // クリックした「列コンテナ」から 1〜50 を抽出
    const items = await target.evaluate((el) => {
      const visText = (n) => {
        const cs = getComputedStyle(n);
        if (cs.display === "none" || cs.visibility === "hidden" || +cs.opacity === 0) return "";
        return (n.textContent || "").replace(/\s+/g, " ").trim();
      };
      const hasRankish = (n) => n.querySelector("ol li, ul li, [data-rank], a[href*='/trend/']");
      let col = el;
      for (let i = 0; i < 10 && col; i++) {
        col = col.parentElement;
        if (col && hasRankish(col)) break;
      }
      if (!col) col = document.body;

      const extract = (root) => {
        const rows = [];
        root.querySelectorAll("ol li, ul li").forEach((li) => rows.push(visText(li)));
        root.querySelectorAll("a[href*='/trend/']").forEach((a) => rows.push(visText(a)));

        // 正規化（「1. 語」「29,984件のツイート」を除去、1..50のみ、重複排除）
        const map = new Map();
        for (const s of rows) {
          const t = s.replace(/(\d{1,3}(?:,\d{3})*)件のツイート/g, "").trim();
          const m = t.match(/^(\d+)[\.\s]*\s*(.*)$/);
          if (!m) continue;
          const rank = +m[1];
          const word = (m[2] || "").trim();
          if (rank >= 1 && rank <= 50 && word && !map.has(rank)) map.set(rank, word);
        }
        return Array.from(map.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([r, w]) => `${r}位 ${w}`);
      };

      let list = extract(col);
      if (list.length < 30 && col.parentElement) {
        const up = extract(col.parentElement);
        if (up.length > list.length) list = up;
      }
      if (list.length < 10) {
        const all = extract(document.body);
        if (all.length > list.length) list = all;
      }
      return list.slice(0, 50);
    });

    await browser.close();
    return items;
  } catch (e) {
    await browser.close();
    throw e;
  }
}

// ---- 実行（1位ごとに改行して送信） ----
(async () => {
  try {
    const ranks = await scrapeTrends();
    const header =
      `🕒 現在のＸトレンド（1〜50位）\n` +
      new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });

    const body = ranks?.length ? ranks.map((s) => `・${s}`).join("\n") : "※ 取得できませんでした。";
    await pushChunks(`${header}\n\n${body}`);
  } catch (err) {
    try {
      await pushText(`❗スクレイプ失敗: ${String(err).slice(0, 200)}`);
    } catch {}
    process.exit(1);
  }
})();
