// scrape.js
const { chromium } = require('playwright');
const axios = require('axios');

const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_TO    = process.env.LINE_GROUP_ID; // グループID（もしくはユーザー/ルームID）

if (!LINE_TOKEN || !LINE_TO) {
  console.error('環境変数が足りません: LINE_CHANNEL_ACCESS_TOKEN と LINE_GROUP_ID を設定してください。');
  process.exit(1);
}

const TWITTREND = 'https://twittrend.jp/';

// ちょいユーティリティ
const sleep = (ms)=> new Promise(r=>setTimeout(r, ms));

async function run() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119 Safari/537.36',
    viewport: { width: 1366, height: 900 }
  });
  const page = await ctx.newPage();

  try {
    console.log('[scrape] ▶ twittrendへ');
    await page.goto(TWITTREND, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    // 初期描画の安定化
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(()=>{});
    await page.mouse.wheel(0, 800);
    await sleep(500);

    // 「現在」カラムの <section> を特定（h2 に「現在」）
    const currentSection = page.locator('section').filter({
      has: page.locator('h2:has-text("現在")')
    }).first();

    await currentSection.waitFor({ state: 'visible', timeout: 30_000 });

    // 左端（現在カラム）内の「21位以下を見る」ボタンをクリック
    const button = currentSection.getByRole('button', { name: /21位以下を見る/ });
    await button.click({ timeout: 15_000 }).catch(async () => {
      // ボタンが折り畳まれてる/見切れているケースに備え、少しスクロールして再試行
      await currentSection.scrollIntoViewIfNeeded();
      await sleep(300);
      await button.click({ timeout: 10_000 });
    });

    // クリック後、ランキング LI が50件になるまで待機（最大30秒）
    const liLocator = currentSection.locator('ol li');
    await page.waitForFunction(
      (s) => document.querySelectorAll(s).length >= 50,
      liLocator.selector(),
      { timeout: 30_000 }
    );

    // テキスト抽出（1〜50）
    const items = await liLocator.evaluateAll((nodes) =>
      nodes.slice(0, 50).map((li, idx) => {
        // ランク名のテキストを整形
        const raw = li.textContent || '';
        const text = raw.replace(/\s+/g, ' ').trim();
        const n = idx + 1;
        // 「1位 ○○」形式で返す
        return `${n}位 ${text}`;
      })
    );

    // ヘッダー + 改行で結合（1メッセージ）
    const now = new Date();
    const stamp = now.toISOString().replace('T',' ').slice(0,19);
    const header = `🕒 現在のＸトレンド（1〜50位）\n${stamp}`;
    const body = items.join('\n');
    const message = `${header}\n${body}`;

    // 2000字を超える場合は2分割（滅多に超えないけど保険）
    const chunks = [];
    if (message.length <= 1900) {
      chunks.push(message);
    } else {
      const mid = Math.ceil(items.length / 2);
      chunks.push(`${header}\n${items.slice(0, mid).join('\n')}`);
      chunks.push(items.slice(mid).join('\n'));
    }

    // LINE push
    for (const text of chunks) {
      await axios.post(
        'https://api.line.me/v2/bot/message/push',
        { to: LINE_TO, messages: [{ type: 'text', text }] },
        { headers: { Authorization: `Bearer ${LINE_TOKEN}` } }
      );
      await sleep(200); // 連投の間隔
    }

    console.log('[scrape] ▶ 送信完了');
  } catch (e) {
    console.error('❌ スクレイピング失敗:', e.message);
    throw e;
  } finally {
    await page.close().catch(()=>{});
    await ctx.close().catch(()=>{});
    await browser.close().catch(()=>{});
  }
}

run();
