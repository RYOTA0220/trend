// 現在（左端の列）の「21位以下を見る」をクリック → その列だけから 1〜50位を抽出 → LINE送信
// 依存: playwright, axios（Actions で `npm i playwright axios` & `npx playwright install --with-deps chromium`）
const { chromium } = require("playwright");
const axios = require("axios");

const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const GROUP_ID = process.env.LINE_TARGET_GROUP_ID;
const LINE_PUSH_API = "https://api.line.me/v2/bot/message/push";
const URL = "https://twittrend.jp/";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

// ---- 送信ユーティリティ（400回避のサニタイズ & 1000字分割） ----
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
    { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, timeout: 30000 }
  );
}
async function pushChunks(full) {
  for (const part of split1000(full)) {
    await pushText(part);
    await new Promise((r) => setTimeout(r, 350));
  }
}

// ---- スクレイピング本体 ----
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

    // 遅延要素を出すためにゆっくり最下部まで
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
        }, 100);
      });
    });

    // 画面上の「21位以下を見る」を全部列挙 → 一番左のもの（= 現在の列）を選ぶ
    const all = page.locator('text=21位以下を見る');
    const n = await all.count();
    if (n === 0) throw new Error('「21位以下を見る」ボタンが見つかりません');

    let targetBtn = null;
    let minX = Number.POSITIVE_INFINITY;
    for (let i = 0; i < n; i++) {
      const btn = all.nth(i);
      if (!(await btn.isVisible().catch(() => false))) continue;
      const box = await btn.boundingBox();
      if (box && box.x < minX) {
        minX = box.x;
        targetBtn = btn;
      }
    }
    if (!targetBtn) throw new Error("可視の『21位以下を見る』が見つかりません（現在列特定失敗）");

    // クリック（現在＝左端）
    await targetBtn.scrollIntoViewIfNeeded().catch(() => {});
    await targetBtn.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1000); // 展開待ち

    // クリックしたボタンから「列コンテナ」を見つけ、その中だけ解析
    const items = await targetBtn.evaluate(() => {
      // 可視テキスト取り出し
      const visText = (el) => {
        const cs = window.getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return "";
        return (el.textContent || "").replace(/\s+/g, " ").trim();
      };

      // 列候補: ボタンから親を上に辿り、子孫にランキングらしい要素を持つノードを見つける
      const hasRankish = (node) =>
        node.querySelector("ol li, [data-rank], .rank, .ranking, a[href*='/trend/']");

      let col = /** @type {HTMLElement|null} */ (/** @type any */ (null));
      {
        let p = /** @type {HTMLElement|null} */ (/** @type any */ (document.activeElement)) || (/** @type any */ null);
        // activeElement がボタンとは限らないので、探索起点をボタン自身に
        p = /** @type any */ (arguments)[0];
        for (let i = 0; i < 10 && p; i++) {
          p = p.parentElement;
          if (p && hasRankish(p)) {
            col = p;
            break;
          }
        }
      }
      if (!col) col = document.body; // 最後の保険

      // 与えられた root から 1..50 を抜く関数（複数セレクタに対応）
      const extractFromRoot = (rootEl) => {
        const rows = [];

        // 1) ol > li 直下に順位＋語が入っている
        rootEl.querySelectorAll("ol li").forEach((li) => {
          const t = visText(li);
          if (t) rows.push(t);
        });

        // 2) rank と word が別要素
        rootEl.querySelectorAll("li, div, article").forEach((node) => {
          const rEl = node.querySelector(".rank, [class*='rank'], [data-rank]");
          // 「21位以下を見る」など見出し/ボタンの text を排除
          const wEl =
            node.querySelector("a[href*='/trend/']") ||
            node.querySelector(".word, [class*='word']");
          const r = rEl ? visText(rEl) : "";
          const w = wEl ? visText(wEl) : "";
          if (/^\d+$/.test(r) && w && !/位以下|見る/.test(w)) {
            rows.push(`${r}位 ${w}`);
          }
        });

        // 3) a[href*="/trend/"] だけが語で、順位がテキストに含まれている場合
        rootEl.querySelectorAll('a[href*="/trend/"]').forEach((a) => {
          const t = visText(a);
          if (t) rows.push(t);
        });

        // 4) data-rank属性のみ
        rootEl.querySelectorAll("[data-rank]").forEach((el) => {
          const r = (el.getAttribute("data-rank") || "").trim();
          const w =
            visText(
              el.querySelector("a[href*='/trend/'], .word, [class*='word']") ||
              el
            ) || "";
          if (/^\d+$/.test(r) && w && !/位以下|見る/.test(w)) rows.push(`${r}位 ${w}`);
        });

        // 正規化：行頭の数字を順位として 1..50 のみ採用、重複排除
        const map = new Map();
        for (const s of rows) {
          const m = s.match(/^(\d+)[位\.]?\s*(.*)$/);
          if (!m) continue;
          const rank = Number(m[1]);
          const word = (m[2] || "").trim();
          if (rank >= 1 && rank <= 50 && word && !map.has(rank)) {
            // 見出しっぽい語は除外
            if (!/日本の各地域のトレンド|地域|世界|国|エリア|トレンド一覧/i.test(word)) {
              map.set(rank, word);
            }
          }
        }
        return Array.from(map.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([r, w]) => `${r}位 ${w}`);
      };

      // まずは推定列から
      let list = extractFromRoot(col);

      // もし取得が少なすぎる（<20）なら、一段上の親も試す（マークアップ差異の救済）
      if (list.length < 20 && col.parentElement) {
        const upper = extractFromRoot(col.parentElement);
        if (upper.length > list.length) list = upper;
      }

      // さらに少ない場合は、ページ全体からフォールバック（見出し除外）
      if (list.length < 10) {
        const allRoot = extractFromRoot(document.body);
        if (allRoot.length > list.length) list = allRoot;
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

// ---- 実行 & 送信 ----
(async () => {
  try {
    const ranks = await scrapeTrends();
    const header = `🕒 現在のＸトレンド（1〜50位）\n${new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}`;
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
