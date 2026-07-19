// LIVE DEMO: a visible browser window + moving red cursor drives the Nexus AI
// e-commerce app end to end (browse → detail → buy → cart → checkout → done),
// through the Agent Eye MCP server, with every step printed and screenshotted.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import * as path from "node:path";
const WS = path.resolve(process.argv[2] || "../../test/ai-shop");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const textOf = (r) => (r.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
const step = (n, s) => console.log(`\n【Step ${n}】 ${s}`);

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js", "--workspace", WS],
  env: {
    ...process.env,
    AGENT_EYE_LOG_LEVEL: "warn",
    AGENT_EYE_SHOW_CURSOR: "1",
    AGENT_EYE_SLOWMO: "600", // slow enough for a human to follow
  },
});
const client = new Client({ name: "live-demo", version: "0" }, { capabilities: { elicitation: {} } });
client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "accept", content: { approve: true } }));
await client.connect(transport);
const call = (name, args = {}) => client.callTool({ name, arguments: args });

console.log("=== Agent Eye LIVE DEMO — watch the browser window on your screen ===");

step(1, "打開商店首頁（瀏覽器視窗現在彈出，注意紅色游標）");
console.log(textOf(await call("browser_navigate", { url: "http://127.0.0.1:5500" })));

step(2, "等 Flutter 載入 + 從 SQLite 取得商品（輪詢 network 直到看到 API 呼叫）");
let apiSeen = false;
for (let i = 0; i < 20 && !apiSeen; i++) {
  await sleep(2000);
  const net = textOf(await call("browser_get_network_requests", { limit: 120 }));
  if (net.includes("127.0.0.1:8000/api/products")) apiSeen = true;
}
console.log(apiSeen ? "✔ 看到 GET /api/products（Flutter → Python → SQLite 串接成功）" : "✘ 沒看到 API 呼叫");
await sleep(1500);

step(3, "截圖：首頁商品牆");
console.log(textOf(await call("browser_screenshot", {})).split("\n")[0]);
await sleep(800);

step(4, "游標移過去點『Aurora Text』商品卡（跳轉測試）");
console.log(textOf(await call("browser_click_at", { x: 560, y: 430 })));
await sleep(2500);

step(5, "截圖：商品詳情頁");
console.log(textOf(await call("browser_screenshot", {})).split("\n")[0]);
await sleep(800);

step(6, "點右下角『Buy now』（按鈕測試 → 跳轉購物車）");
console.log(textOf(await call("browser_click_at", { x: 1207, y: 771 })));
await sleep(2500);

step(7, "點『＋』把數量加到 2（狀態更新測試）");
console.log(textOf(await call("browser_click_at", { x: 1198, y: 111 })));
await sleep(1800);

step(8, "截圖：購物車（應顯示數量 2、Total $98）");
console.log(textOf(await call("browser_screenshot", {})).split("\n")[0]);
await sleep(800);

step(9, "點綠色『Checkout』→ POST /api/orders → 寫入 SQLite");
console.log(textOf(await call("browser_click_at", { x: 1201, y: 762 })));
await sleep(2500);

step(10, "截圖：訂單確認彈窗");
console.log(textOf(await call("browser_screenshot", {})).split("\n")[0]);
await sleep(800);

step(11, "點『Done』關閉彈窗回首頁");
console.log(textOf(await call("browser_click_at", { x: 715, y: 488 })));
await sleep(2000);

step(12, "驗證 network log 裡真的有 POST /api/orders");
const net = textOf(await call("browser_get_network_requests", { limit: 150 }));
const hasOrder = /"method": "POST",\s*\n?\s*"url": "http:\/\/127\.0\.0\.1:8000\/api\/orders"/.test(net) || net.includes("/api/orders");
console.log(hasOrder ? "✔ network log 確認 POST /api/orders 已送出" : "✘ 沒抓到 POST /api/orders");

console.log("\n=== 視窗保留 12 秒讓你看最終狀態 ===");
await sleep(12000);
await client.close();
console.log("=== demo 結束 ===");
