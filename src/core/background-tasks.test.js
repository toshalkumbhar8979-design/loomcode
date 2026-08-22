process.env.LOOM_MCP_NO_WARM = "1";
import { test, expect } from "bun:test";
const bt = require("./background-tasks.js");
test("background task runs and finishes", async () => {
  const r = bt.startBackgroundTask(process.platform === "win32" ? "exit 0" : "true");
  expect(r.id).toBeTruthy();
  for (let i = 0; i < 50 && bt.getBackgroundTask(r.id).status === "running"; i++) await new Promise(res => setTimeout(res, 50));
  expect(bt.getBackgroundTask(r.id).status).toBe("done");
});
test("list + kill + clear", async () => {
  const r = bt.startBackgroundTask(process.platform === "win32" ? "ping -n 30 127.0.0.1 >nul" : "sleep 30");
  expect(bt.listBackgroundTasks({ running: true }).some(t => t.id === r.id)).toBe(true);
  expect(bt.killBackgroundTask(r.id)).toBe(true);
  bt.clearFinishedTasks();
});
