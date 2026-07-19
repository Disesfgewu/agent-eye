// LIVE DEMO: a visible browser window the user watches while the agent drives.
// Shows: dark theme, 🔒 input-lock badge, bottom narration banner, red cursor,
// the new Add→popup dialog, and a full purchase written to SQLite.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as path from "node:path";

const WS = path.resolve(process.argv[2] || "../../test/ai-shop");
const URL = process.argv[3] || "http://127.0.0.1:5500";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const textOf = (r) => (r.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
const step = (n, s) => console.log(`\n【${n}】 ${s}`);

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js", "--workspace", WS],
  env: { ...process.env, AGENT_EYE_LOG_LEVEL: "warn", AGENT_EYE_SHOW_CURSOR: "1", AGENT_EYE_SLOWMO: "600" },
});
const client = new Client({ name: "live-demo", version: "0" }, { capabilities: { elicitation: {} } });
client.setRequestHandler(ElicitRequestSchema, async () => ({ action: "accept", content: { approve: true } }));
await client.connect(transport);
const call = (n, a = {}) => client.callTool({ name: n, arguments: a });
const say = (m) => call("browser_show_status", { message: m });

console.log("=== Agent Eye LIVE DEMO — 看你的螢幕：視窗會彈出，agent 自己操作，你的鍵鼠被鎖住 ===");

step(1, "打開商店（深色主題；注意左上角 🔒 鎖定標示、底部旁白、紅色游標）");
console.log(textOf(await call("browser_navigate", { url: URL })));
for (let i = 0; i < 20; i++) { await sleep(2000); if (textOf(await call("browser_get_network_requests", { limit: 120 })).includes("/api/products")) { console.log("✔ 商品已從 SQLite 載入"); break; } }
await sleep(1500);

step(2, "示範新功能：點『Add』彈出對話框");
await say("示範：點 Add 按鈕會彈出對話框…");
await call("browser_click_at", { x: 794, y: 500 });
await sleep(2500);
console.log(textOf(await call("browser_screenshot", {})).split("\n")[0]);

step(3, "關掉對話框，改從商品卡進入詳情頁（跳轉測試）");
await call("browser_navigate", { url: URL });
await sleep(4000);
await say("點商品卡 → 跳轉到詳情頁");
await call("browser_click_at", { x: 560, y: 430 });
await sleep(2500);
console.log(textOf(await call("browser_screenshot", {})).split("\n")[0]);

step(4, "點『Buy now』→ 購物車");
await say("Buy now → 加入購物車並跳轉");
await call("browser_click_at", { x: 1207, y: 771 });
await sleep(2500);

step(5, "數量 +1（狀態更新）");
await call("browser_click_at", { x: 1198, y: 111 });
await sleep(1800);
console.log(textOf(await call("browser_screenshot", {})).split("\n")[0]);

step(6, "結帳 → 寫入 SQLite");
await say("Checkout → POST /api/orders → 寫進資料庫");
await call("browser_click_at", { x: 1201, y: 762 });
await sleep(2500);
console.log(textOf(await call("browser_screenshot", {})).split("\n")[0]);

step(7, "完成");
await call("browser_click_at", { x: 715, y: 488 });
await say("完成 ✓ 全程你的鍵鼠被鎖住，只有 agent 能操作");
console.log("\n=== 視窗保留 12 秒 ===");
await sleep(12000);
await client.close();
console.log("=== demo 結束 ===");
