// 現在（いちばん左の列）の「21位以下を見る」をクリック → その列だけから 1〜50位 を取得 → LINE送信
// 依存: playwright, axios
//   npm i playwright axios
//   npx playwright install --with-deps chromium
const { chromium } = require("playwright");
const axios = require("axios");

const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;      // GitHub Secrets
const GROUP_ID = process.env.LINE_TARGET_GROUP_ID;        // GitHub Secrets
const LINE_PUSH_API = "https://api.line.me/v2/bot/message/push";
const URL = "https://twittrend.jp/";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

// ---------- 送信ユーティリティ（LINE 400 回避） ----------
const sanitize = (s) =>
  (s || "")
    .replace(/[\u0000-\u001F\u007F]/g, "")  // 制御文字除去
    .replace(/[ \t\v\f]+\n/g, "\n")         // 行末空白除去
    .replace(/\n{3,}/g, "\n\n");            // 連続改行圧縮
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

// ---------- スクレイピング本体 ----------
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

    // 遅延読み込みを発火させるため下までスクロール
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
        }, 90);
      });
    });

    // 4列の「21位以下を見る」を全取得 → 一番左(=現在列)のボタンを座標で特定
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

    // 左端ボタンをクリック（=現在）
    await target.scrollIntoViewIfNeeded().catch(() => {});
    await target.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(900); // 展開待ち

    // クリックしたボタンが属する「列コンテナ」だけを解析して 1〜50 を抽出
    const items = await target.evaluate((el) => {
      // 可視テキストだけを取る
      const visText = (node) => {
        const cs = window.getComputedStyle(node);
        if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return "";
        return (node.textContent || "").replace(/\s+/g, " ").trim();
      };

      // ランキングを持っていそうな親を上に辿って列コンテナを特定
      const hasRankish = (node) =>
        node.querySelector("ol li, ul li, [data-rank], .rank, .ranking, a[href*='/trend/']");

      let col = el;
      for (let i = 0; i < 10 && col; i++) {
        col = col.parentElement;
        if (col && hasRankish(col)) break;
      }
      if (!col) col = document.body;

      // 与えられた root から 1..50 を抽出
      const extract = (rootEl) => {
        const rows = [];

        // (A) ol/li または ul/li の生テキスト
        rootEl.querySelectorAll("ol li, ul li").forEach((li) => {
          const t = visText(li);
          if (t) rows.push(t);
        });

        // (B) rank と word が分かれているケース
        rootEl.querySelectorAll("li, div, article").forEach((node) => {
          const rEl = node.querySelector(".rank, [class*='rank'], [data-rank]");
          const wEl =
            node.querySelector("a[href*='/trend/']") ||
            node.querySelector(".word, [class*='word']");
          const r = rEl ? visText(rEl) : "";
          const w = wEl ? visText(wEl) : "";
          if (/^\d+$/.test(r) && w && !/位以下|見る/.test(w)) {
            rows.push(`${r}位 ${w}`);
          }
        });

        // (C) trendリンクのみが語
        rootEl.querySelectorAll('a[href*="/trend/"]').forEach((a) => {
          const t = visText(a);
          if (t) rows.push(t);
        });

        // (D) data-rank 属性のみ
        rootEl.querySelectorAll("[data-rank]").forEach((n) => {
          const r = (n.getAttribute("data-rank") || "").trim();
          const w =
            visText(
              n.querySelector("a[href*='/trend/'], .word, [class*='word']") ||
              n
            ) || "";
          if (/^\d+$/.test(r) && w && !/位以下|見る/.test(w)) rows.push(`${r}位 ${w}`);
        });

        // 正規化：行頭の数字を順位に（1..50）、重複排除、見出し除外
        const map = new Map();
        for (const s of rows) {
          // 例: "1. ゴールデングラブ賞 29,984件のツイート"
          let t = s.replace(/(\d{1,3}(?:,\d{3})*)件のツイート/g, "").trim();
          const m = t.match(/^(\d+)[\.\s]*\s*(.*)$/);
          if (!m) continue;
          const rank = Number(m[1]);
          let word = (m[2] || "").trim();
          if (!word) continue;
          if (/日本の各地域のトレンド|地域|世界|国|エリア|トレンド一覧|位以下|見る/i.test(word)) continue;
          if (rank >= 1 && rank <= 50 && !map.has(rank)) map.set(rank, word);
        }
        return Array.from(map.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([r, w]) => `${r}位 ${w}`);
      };

      // まずは推定列から
      let list = extract(col);

      // 少なければ一段上の親でもう一度
      if (list.length < 30 && col.parentElement) {
        const upper = extract(col.parentElement);
        if (upper.length > list.length) list = upper;
      }

      // それでもダメなら最終フォールバック（ページ全体）
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

// ---------- 実行 & 送信 ----------
(async () => {
  try {
    const ranks = await scrapeTrends();
    const header =
      `🕒 現在のＸトレンド（1〜50位）\n` +
      new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
    const body =
      ranks && ranks.length
        ? ranks.map((s) => `・${s}`).join("\n")
        : "※ 取得できませんでした。";

    await pushChunks(`${header}\n\n${body}`);
    console.log("Done:", (ranks || []).length, "items");
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
