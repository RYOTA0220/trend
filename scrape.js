// 依存: axios, cheerio
const axios = require("axios");
const cheerio = require("cheerio");

const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN; // 長期トークン
const TARGET_GROUP_ID = process.env.LINE_TARGET_GROUP_ID;           // groupId
const LINE_PUSH_API = "https://api.line.me/v2/bot/message/push";

// 1000文字で分割（制限対策）
const chunk = (s, n = 1000) => s.match(new RegExp(`(.|\\n){1,${n}}`, "g")) || [];

async function pushToGroup(texts) {
  for (const text of texts) {
    await axios.post(
      LINE_PUSH_API,
      { to: TARGET_GROUP_ID, messages: [{ type: "text", text }] },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}`,
        },
        timeout: 30000,
      }
    );
    await new Promise(r => setTimeout(r, 400));
  }
}

async function main() {
  const { data: html } = await axios.get("https://twittrend.jp/", { timeout: 30000 });
  const $ = cheerio.load(html);

  const rows = [];
  $("ol li, .trend-list li, a[href*='/trend/']").each((_, el) => {
    const t = $(el).text().replace(/\s+/g, " ").trim();
    if (t) rows.push(t);
  });

  const map = new Map();
  for (const s of rows) {
    const m = s.match(/^(\d+)[位\.]?\s*(.*)$/);
    if (!m) continue;
    const rank = Number(m[1]);
    const label = (m[2] || "").trim();
    if (rank >= 1 && rank <= 50 && !map.has(rank)) map.set(rank, label || s);
  }

  let list = Array.from(map.entries()).sort((a, b) => a[0] - b[0]).map(([r, l]) => `${r}位 ${l}`);
  if (list.length < 20) list = rows.slice(0, 50).map((t, i) => `${i + 1}位 ${t}`);

  const header = `🕘 現在のXトレンド（1〜50位）\n${new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}`;
  const body = list.slice(0, 50).map(s => `・${s}`).join("\n");

  const messages = chunk(`${header}\n\n${body}`, 1000);
  await pushToGroup(messages);
}

main().catch(async (e) => {
  try { await pushToGroup([`❗エラー: ${String(e).slice(0, 900)}`]); } catch {}
  process.exit(1);
});
