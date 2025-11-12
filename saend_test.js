const axios = require("axios");

const TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const GROUP = process.env.LINE_TARGET_GROUP_ID;

if (!TOKEN || !GROUP) {
  console.error("ENV NG: TOKEN or GROUP is missing");
  process.exit(1);
}

(async () => {
  try {
    const res = await axios.post(
      "https://api.line.me/v2/bot/message/push",
      { to: GROUP, messages: [{ type: "text", text: "✅ テスト送信 from GitHub Actions" }] },
      { headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }, timeout: 30000 }
    );
    console.log("OK", res.status, res.statusText);
  } catch (e) {
    if (e.response) {
      console.error("AXIOS_ERR", e.response.status, e.response.statusText, e.response.data);
    } else {
      console.error("AXIOS_ERR", String(e));
    }
    process.exit(1);
  }
})();
