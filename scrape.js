// 現在（左端列）の「21位以下を見る」をクリック → その列から 1〜50位を取得して順位ごと改行してLINE送信
// 依存: playwright, axios
const { chromium } = require("playwright");
const axios = require("axios");

const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const GROUP_ID = process.env.LINE_TARGET_GROUP_ID;
const LINE_PUSH_API = "https://api.line.me/v2/bot/message/push";
const URL = "https://twittrend.jp/";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

// ---------- LINE送信用 ----------
const sanitize = (s) =>
  (s || "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/[ \t\v\f]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
const split1000 = (s) => (sanitize(s).match(/[\s\S]{1,1000}/g) || []);

async function pushText(text) {
  if (!text || !text.trim()) return;
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
    await new Promise((r) => setTimeout(r, 350));
  }
}

// ---------- スクレイピング ----------
async function scrapeTrends() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: UA,
    locale: "ja-JP",
    viewport: { width: 1360, height: 2300 },
  });
  const page = await context.newPage();

  try {
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });

    // 遅延ロード防止
    await page.evaluate(async () => {
      await new Promise((res) => {
        let y = 0;
        const id = setInterval(() => {
          y += 900;
          window.scrollTo(0, y);
          if (y >= document.body.scrollHeight) {
            clearInterval(id);
            res();
          }
        }, 80);
      });
    });

    // 左端（現在）の「21位以下を見る」ボタン
    const btns = page.locator('text=21位以下を見る');
    const count = await btns.count();
    if (count === 0) throw new Error('「21位以下を見る」ボタンが見つかりません');

    let target = null;
    let minX = Number.POSITIVE_INFINITY;
    for (let i = 0; i < count; i++) {
      const b = btns.nth(i);
      if (!(await b.isVisible().catch(() => false))) continue;
      const box = await b.boundingBox();
      if (box && box.x < minX) {
        minX = box.x;
        target = b;
      }
    }
    if (!target) throw new Error("可視の『21位以下を見る』が見つかりません");

    await target.scrollIntoViewIfNeeded().catch(() => {});
    await target.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1000);

    // クリックした列の中から順位を抽出
    const items = await target.evaluate((el) => {
      const visText = (node) => {
        const cs = window.getComputedStyle(node);
        if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return "";
        return (node.textContent || "").replace(/\s+/g, " ").trim();
      };
      const hasRankish = (n) =>
        n.querySelector("ol li, ul li, [data-rank], .rank, a[href*='/trend/']");
      let col = el;
      for (let i = 0; i < 10 && col; i++) {
        col = col.parentElement;
        if (col && hasRankish(col)) break;
      }
      if (!col) col = document.body;

      const extract = (root) => {
        const rows = [];
        root.querySelectorAll("ol li, ul li").forEach((li) => {
          const t = visText(li);
          if (t) rows.push(t);
        });
        root.querySelectorAll("a[href*='/trend/']").forEach((a) => {
          const t = visText(a);
          if (t) rows.push(t);
        });
        const map = new Map();
        for (const s of rows) {
          const clean = s.replace(/(\d{1,3}(?:,\d{3})*)件のツイート/g, "").trim();
          const m = clean.match(/^(\d+)[\.\s]*\s*(.*)$/);
          if (!m) continue;
          const rank = Number(m[1]);
          const word = (m[2] || "").trim();
          if (rank >= 1 && rank <= 50 && word && !map.has(rank)) {
            map.set(rank, word);
          }
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

// ---------- 実行 ----------
(async () => {
  try {
    const ranks = await scrapeTrends();
    const header =
      `🕒 現在のＸトレンド（1〜50位）\n` +
      new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });

    const body =
      ranks && ranks.length
        ? ranks.map((s) => `・${s}`).join("\n") // 👈 ここで1行ずつ改行！
        : "※ 取得できませんでした。";

    await pushChunks(`${header}\n\n${body}`);
    console.log("Done:", ranks.length, "items");
  } catch (err) {
    console.error("Failed:", err?.response?.data || String(err));
    try {
      await pushText(
        `❗スクレイプ失敗: ${err?.response?.status || ""} ${
          err?.response?.data?.message || String(err).slice(0, 200)
        }`
      );
    } catch {}
    process.exit(1);
  }
})();
