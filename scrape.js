// 現在（左端の列）の「21位以下を見る」をクリックして 1〜50位を取得 → LINEに送信
// 依存：playwright, axios（Actionsで npm i playwright axios ＋ npx playwright install --with-deps chromium）
const { chromium } = require("playwright");
const axios = require("axios");

const TOKEN    = process.env.LINE_CHANNEL_ACCESS_TOKEN;   // GitHub Secrets
const GROUP_ID = process.env.LINE_TARGET_GROUP_ID;        // GitHub Secrets
const LINE_PUSH_API = "https://api.line.me/v2/bot/message/push";
const URL = "https://twittrend.jp/";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

// ---- 共通ユーティリティ（400対策でサニタイズ＆1000字分割） ----
const sanitize = (s) =>
  (s || "")
    .replace(/[\u0000-\u001F\u007F]/g, "")      // 制御文字除去
    .replace(/[ \t\v\f]+\n/g, "\n")             // 行末空白除去
    .replace(/\n{3,}/g, "\n\n");                // 連続改行圧縮
const split1000 = (s) => (sanitize(s).match(/[\s\S]{1,1000}/g) || []);

async function pushText(text) {
  if (!text || !text.trim()) return;            // 空は送らない
  await axios.post(
    LINE_PUSH_API,
    { to: GROUP_ID, messages: [{ type: "text", text }] },
    { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, timeout: 30000 }
  );
}
async function pushChunks(full) {
  for (const part of split1000(full)) {
    await pushText(part);
    await new Promise(r => setTimeout(r, 350));
  }
}

// ---- メイン：スクレイピング ----
async function scrapeTrends() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: UA, locale: "ja-JP", viewport: { width: 1360, height: 2300 }
  });
  const page = await context.newPage();

  try {
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });

    // 下までゆっくりスクロール（遅延読み込みを出す）
    await page.evaluate(async () => {
      await new Promise((res) => {
        let y = 0;
        const id = setInterval(() => {
          y += 900;
          window.scrollTo(0, y);
          if (y >= document.body.scrollHeight) { clearInterval(id); res(); }
        }, 100);
      });
    });

    // 画面内にある「21位以下を見る」を全部取得 → 一番"左"のボタンを選ぶ（= 現在の列）
    const allBtns = page.locator('text=21位以下を見る');
    const count = await allBtns.count();
    if (count === 0) throw new Error('「21位以下を見る」ボタンが見つかりません');

    // 可視ボタンの中から boundingBox().x が最小（= 左端）を選ぶ
    let leftmostHandle = null;
    let minX = Number.POSITIVE_INFINITY;

    for (let i = 0; i < count; i++) {
      const btn = allBtns.nth(i);
      if (!(await btn.isVisible().catch(() => false))) continue;
      const box = await btn.boundingBox();
      if (box && box.x < minX) {
        minX = box.x;
        leftmostHandle = btn;
      }
    }
    if (!leftmostHandle) throw new Error("可視の『21位以下を見る』が見つかりません");

    // クリック（左端＝現在のトレンド）
    await leftmostHandle.scrollIntoViewIfNeeded().catch(() => {});
    await leftmostHandle.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(900); // 展開待ち

    // クリックしたボタンの「同じ列（親コンテナ）」の中だけから 1〜50位を抽出
    const items = await leftmostHandle.evaluate((el) => {
      const getVisibleText = (node) => {
        const cs = window.getComputedStyle(node);
        if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return "";
        return (node.textContent || "").replace(/\s+/g, " ").trim();
      };

      // ボタンから上に辿って「その列のコンテナ」を見つける
      // 目安：列を表す要素（section/article/div）で、子孫に ol/li や trendリンクがあるもの
      let root = el;
      for (let i = 0; i < 10 && root; i++) {
        root = root.parentElement;
        if (!root) break;
        if (root.querySelector("ol li, a[href*='/trend/'], [data-rank], .rank, .ranking")) break;
      }
      if (!root) root = document.body;

      const rows = [];

      // パターン1：ol > li に「n位」「語」が含まれている
      root.querySelectorAll("ol li").forEach((li) => {
        const t = getVisibleText(li);
        if (t) rows.push(t);
      });

      // パターン2：rank/wordが分かれている
      root.querySelectorAll("li, div").forEach((node) => {
        const rEl = node.querySelector('.rank, [class*="rank"], [data-rank]');
        const wEl = node.querySelector('.word, [class*="word"], a[href*="/trend/"]');
        if (rEl && wEl) {
          const rt = getVisibleText(rEl);
          const wt = getVisibleText(wEl);
          if (/^\d+$/.test(rt) && wt) rows.push(`${rt}位 ${wt}`);
        }
      });

      // パターン3：リンクのみ（/trend/）が語
      root.querySelectorAll('a[href*="/trend/"]').forEach((a) => {
        const t = getVisibleText(a);
        if (t) rows.push(t);
      });

      // 正規化：先頭数字を順位として 1..50 のみ採用
      const map = new Map();
      for (const s of rows) {
        const m = s.match(/^(\d+)[位\.]?\s*(.*)$/);
        if (!m) continue;
        const r = Number(m[1]);
        const w = (m[2] || "").trim();
        if (r >= 1 && r <= 50 && w && !map.has(r)) map.set(r, w);
      }

      if (map.size > 0) {
        return Array.from(map.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([r, w]) => `${r}位 ${w}`);
      }

      // フォールバック：見出しっぽい語を除外して上から50件に番号を振る
      const bad = /日本の各地域のトレンド|地域|世界|国|エリア|トレンド一覧/i;
      const uniq = Array.from(new Set(rows.map(t => (t || "").trim()).filter(t => t && !bad.test(t))));
      return uniq.slice(0, 50).map((t, i) => `${i + 1}位 ${t}`);
    });

    await browser.close();
    return items.slice(0, 50);
  } catch (e) {
    await browser.close();
    throw e;
  }
}

// ---- 実行＆送信 ----
(async () => {
  try {
    const ranks = await scrapeTrends();
    const header = `🕒 現在のＸトレンド（1〜50位）\n${new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}`;
    const body   = (ranks && ranks.length) ? ranks.map(s => `・${s}`).join("\n") : "※ 取得できませんでした。";

    await pushChunks(`${header}\n\n${body}`);
    console.log("Done");
  } catch (err) {
    console.error("Failed:", err?.response?.data || String(err));
    try { await pushText(`❗スクレイプ失敗: ${err?.response?.status || ""} ${err?.response?.data?.message || String(err).slice(0, 200)}`); } catch {}
    process.exit(1);
  }
})();
