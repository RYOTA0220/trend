// Playwrightで21位以降を開き、1〜50位を取得してLINEに送信（安全版）
const { chromium } = require("playwright");
const axios = require("axios");

const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const GROUP_ID = process.env.LINE_TARGET_GROUP_ID;
const LINE_PUSH_API = "https://api.line.me/v2/bot/message/push";
const URL = "https://twittrend.jp/";

const split1000 = (s) =>
  (s || "")
    .replace(/[\u0000-\u001F\u007F]/g, "")      // 制御文字除去
    .replace(/[ \t\v\f]+\n/g, "\n")             // 行末の空白除去
    .replace(/\n{3,}/g, "\n\n")                 // 連続改行圧縮
    .match(/[\s\S]{1,1000}/g) || [];            // 1000字で分割（改行も含む）

async function pushText(text) {
  if (!text || !text.trim()) return;            // 空は送らない
  await axios.post(
    LINE_PUSH_API,
    { to: GROUP_ID, messages: [{ type: "text", text }] },
    { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, timeout: 30000 }
  );
}

async function pushChunks(fullText) {
  for (const part of split1000(fullText)) {
    await pushText(part);
    await new Promise((r) => setTimeout(r, 350));
  }
}

async function scrapeTrends() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 2200 } });

  try {
    await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });

    // ゆっくりスクロールして遅延要素を出す
    await page.evaluate(async () => {
      await new Promise((res) => {
        let y = 0;
        const id = setInterval(() => {
          y += 900;
          window.scrollTo(0, y);
          if (y >= document.body.scrollHeight) { clearInterval(id); res(); }
        }, 120);
      });
    });

    // 「21位以降」クリック（文言ゆれ対応）
    const labels = ['現在の21位以降を見る', '現在の21以降を見る', '21位以降'];
    let ok = false;
    for (const t of labels) {
      const h = page.getByText(t, { exact: false });
      if (await h.first().isVisible().catch(() => false)) { await h.first().click(); ok = true; break; }
    }
    if (!ok) {
      const alt = await page.locator('button:has-text("21"), a:has-text("21")').first();
      if (await alt.isVisible().catch(() => false)) { await alt.click(); ok = true; }
    }
    await page.waitForTimeout(800);

    // 1〜50位を抽出（可視要素のテキストのみ）
    const items = await page.evaluate(() => {
      const getVisibleText = (el) => {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return "";
        return (el.textContent || "").replace(/\s+/g, " ").trim();
      };

      const texts = [];
      // よくある構造：ol li
      document.querySelectorAll("ol li").forEach((li) => {
        const t = getVisibleText(li);
        if (t) texts.push(t);
      });
      // trendリンク
      document.querySelectorAll('a[href*="/trend/"]').forEach((a) => {
        const t = getVisibleText(a);
        if (t) texts.push(t);
      });
      // data-rank / .rank
      document.querySelectorAll("[data-rank], .rank, .ranking").forEach((el) => {
        const t = getVisibleText(el);
        if (t) texts.push(t);
      });

      // 正規化して 1〜50 位だけにする
      const map = new Map();
      for (const s of texts) {
        const m = s.match(/^(\d+)[位\.]?\s*(.*)$/); // 先頭の数字を順位扱い
        if (!m) continue;
        const r = Number(m[1]);
        const label = (m[2] || "").trim();
        if (r >= 1 && r <= 50 && !map.has(r)) map.set(r, label || s);
      }

      if (map.size >= 20) {
        return Array.from(map.entries())
          .sort((a, b) => a[0] - b[0])
          .map(([r, label]) => `${r}位 ${label}`);
      }

      // フォールバック：重複を消して上から50件に番号を振る
      const uniq = Array.from(new Set(texts.filter(Boolean)));
      return uniq.slice(0, 50).map((t, i) => `${i + 1}位 ${t}`);
    });

    await browser.close();
    return items.slice(0, 50);
  } catch (e) {
    await browser.close();
    throw e;
  }
}

(async () => {
  try {
    const ranks = await scrapeTrends();
    const header = `🕒 現在のＸトレンド（1〜50位）\n${new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}`;
    const body = ranks.map((s) => `・${s}`).join("\n");

    await pushChunks(`${header}\n\n${body || "※ 取得できませんでした。"}`);
    console.log("Done");
  } catch (err) {
    console.error("Failed:", err?.response?.data || String(err));
    // 400対策：詳細があれば短文で通知
    try { await pushText(`❗スクレイプ失敗: ${err?.response?.status || ""} ${err?.response?.data?.message || String(err).slice(0, 200)}`); } catch {}
    process.exit(1);
  }
})();
