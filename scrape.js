// scrape.js
const { chromium } = require('playwright');
const axios = require('axios');

const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LINE_TO = process.env.LINE_GROUP_ID;

if (!LINE_TOKEN || !LINE_TO) {
  console.error('環境変数が足りません: LINE_CHANNEL_ACCESS_TOKEN と LINE_GROUP_ID');
  process.exit(1);
}

const TWITTREND_URL = 'https://twittrend.jp/jp';

async function pushToLINE(text) {
  const url = 'https://api.line.me/v2/bot/message/push';
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${LINE_TOKEN}`,
  };
  // 文字数が長い場合は分割送信
  const chunks = [];
  let buf = '';
  for (const line of text.split('\n')) {
    if ((buf + '\n' + line).length > 4500) {
      chunks.push(buf);
      buf = line;
    } else {
      buf = buf ? buf + '\n' + line : line;
    }
  }
  if (buf) chunks.push(buf);

  for (const c of chunks) {
    await axios.post(url, { to: LINE_TO, messages: [{ type: 'text', text: c }] }, { headers, timeout: 20000 });
  }
}

async function scrapeTwittrend() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--disable-dev-shm-usage', '--no-sandbox', '--disable-gpu', '--disable-setuid-sandbox'],
  });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 2400 },
    javaScriptEnabled: true,
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  });

  // 広告等での外部遷移を極力ブロック（強すぎない設定）
  await context.route('**/*', (route) => {
    const u = route.request().url();
    const block = [
      'doubleclick.net',
      'googlesyndication.com',
      '/sodar2/',
      'recaptcha',
      '/ads?',
      'google-analytics.com',
    ].some((x) => u.includes(x));
    if (block) route.abort();
    else route.continue();
  });

  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  try {
    await page.goto(TWITTREND_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // 初期レンダリング完了待ち
    await page.waitForSelector('section h2', { timeout: 30000 });

    // 軽くスクロール（遅延ロード対策）
    await page.mouse.wheel(0, 1200);
    await page.waitForTimeout(500);

    // 「現在」カラムの section を特定（テキスト一致ではなく包含で判定）
    const currentSectionSelector = await page.evaluate(() => {
      const hs = Array.from(document.querySelectorAll('section h2'));
      const h = hs.find((n) => (n.textContent || '').trim().includes('現在'));
      if (!h) return null;
      const sec = h.closest('section');
      if (!sec) return null;
      // ユニークなCSSセレクタを返す（nth-of-typeで十分）
      const allSecs = Array.from(document.querySelectorAll('section'));
      const idx = allSecs.indexOf(sec) + 1;
      return `section:nth-of-type(${idx})`;
    });
    if (!currentSectionSelector) throw new Error('「現在」カラムの検出に失敗');

    // 「21位以下を見る」ボタンを押下（テキストの表記ゆれに対応）
    const openBtn = page.locator(
      `${currentSectionSelector} :is(button,a,div):text-matches("21位以下", "i")`
    );
    // 見当たらないサイト状態もあるので、まずは存在確認して押せるなら押す
    if (await openBtn.first().isVisible().catch(() => false)) {
      await Promise.all([
        page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {}),
        openBtn.first().click({ timeout: 5000 }),
      ]);
    }

    // 21〜50位が展開されるまで待機（ol li が50個以上になるまで）
    await page.waitForFunction(
      (selector) => {
        const sec = document.querySelector(selector);
        if (!sec) return false;
        const lis = sec.querySelectorAll('ol li');
        return lis && lis.length >= 50;
      },
      currentSectionSelector,
      { timeout: 15000 }
    );

    // 1〜50位を抽出（テキスト整形）
    const top50 = await page.evaluate((selector) => {
      const sec = document.querySelector(selector);
      const lis = Array.from(sec.querySelectorAll('ol li')).slice(0, 50);
      return lis.map((li, i) => {
        const t = (li.textContent || '')
          .replace(/\s*\d{1,3}(,\d{3})*件のツイート\s*/g, '')
          .replace(/\s+/g, ' ')
          .trim();
        return `${i + 1}位 ${t}`;
      });
    }, currentSectionSelector);

    // ヘッダー＋本文（順位ごとに改行）
    const now = new Date();
    const jp = new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(now);
    const header = `🕒 現在のＸトレンド（1〜50位）\n${jp}`;
    const body = top50.join('\n');
    await pushToLINE(`${header}\n${body}`);

    console.log('✅ 完了: 送信済み');
  } catch (e) {
    console.error('❌ スクレイプ失敗:', e);
    try {
      await pushToLINE('⚠️ スクレイプ失敗: ' + (e?.message || e));
    } catch (_) {}
    process.exit(1);
  } finally {
    await context.close();
    await browser.close();
  }
}

scrapeTwittrend();
