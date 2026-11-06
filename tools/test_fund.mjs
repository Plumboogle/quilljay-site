// node --test tools/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { checkTrade, compute, goalAt, logTicks, tradePnl, tradeTicks, tradesToGoal } from "../fund/stats.js";

const t = (over = {}) => ({ date: "2026-12-01", by: "J", contract: "SPY 600C", side: "long", qty: 1, in: 1, out: 1.5, fees: 1.36, ...over });

test("the goal line reaches $1M at trade 695 from $999", () => {
  assert.equal(tradesToGoal(999), 695);
  assert.ok(goalAt(999, 695) >= 1000000);
  assert.ok(goalAt(999, 694) < 1000000);
  assert.ok(Math.abs(goalAt(100, 2) - 102.01) < 1e-9);
});

test("a trade's dollars include fees, contract size and side", () => {
  assert.equal(tradePnl(t()), 48.64);
  assert.equal(tradePnl(t({ side: "short" })), -51.36);
  assert.equal(tradePnl(t({ mult: 1, qty: 10, in: 5, out: 6, fees: 0 })), 10);
});

test("no trades: value is the start, on the goal line, no made-up stats", () => {
  const s = compute({ start: 999, trades: [] });
  assert.deepEqual([s.value, s.n, s.gapDollars, s.gapTrades, s.winRate, s.best, s.avgGainPct], [999, 0, 0, 0, null, null, null]);
});

test("value, win rate, best, worst and goal gap follow the trades", () => {
  const s = compute({ start: 1000, trades: [t({ in: 1, out: 1.1, fees: 0 }), t({ in: 1, out: 0.9, fees: 0, by: "Q" }), t({ in: 1, out: 1.2, fees: 0, by: "W" })] });
  assert.deepEqual(s.rows.map((r) => r.value), [1010, 1000, 1020]);
  assert.equal(s.value, 1020);
  assert.equal(s.winRate, (2 / 3) * 100);
  assert.equal(s.best.by, "W");
  assert.equal(s.worst.by, "Q");
  assert.equal(s.gapDollars, Math.round((1020 - goalAt(1000, 3)) * 100) / 100);
  assert.ok(s.gapTrades < 0 && s.gapTrades > -2);
  assert.ok(Math.abs(s.avgGainPct - ((1.02 ** (1 / 3) - 1) * 100)) < 1e-9);
  assert.ok(Math.abs(s.rows[1].pct - (-10 / 1010) * 100) < 1e-9);
});

test("an account at zero has no trades-behind number instead of crashing", () => {
  const s = compute({ start: 100, trades: [t({ qty: 1, in: 1, out: 0, fees: 0 })] });
  assert.equal(s.value, 0);
  assert.equal(s.gapTrades, null);
  assert.equal(s.avgGainPct, null);
});

test("bad trades are refused, and only initials are allowed", () => {
  assert.throws(() => checkTrade(t({ by: "Jake" }), 0), /by must be/);
  assert.throws(() => checkTrade(t({ date: "12/1" }), 0), /date/);
  assert.throws(() => checkTrade(t({ qty: 0 }), 0), /qty/);
  assert.throws(() => checkTrade(t({ side: "up" }), 0), /side/);
});

test("axis ticks stay inside the range", () => {
  const ys = logTicks(900, 1250000);
  assert.ok(ys.every((v) => v >= 900 && v <= 1250000) && ys.length <= 6 && ys.includes(1000000));
  assert.deepEqual(tradeTicks(10, 5), [0, 2, 4, 6, 8, 10]);
  assert.equal(tradeTicks(695, 7).at(-1), 600);
});

test("the published file is the real start: no sample trades, only allowed fields", () => {
  const d = JSON.parse(readFileSync(new URL("../fund/trades.json", import.meta.url)));
  assert.equal(d.start, 999);
  assert.equal(d.sample, undefined);
  assert.deepEqual(Object.keys(d).sort(), ["start", "status", "trades", "updated"]);
  const ok = new Set(["date", "by", "contract", "side", "qty", "in", "out", "fees", "mult"]);
  d.trades.forEach((x, i) => { checkTrade(x, i); assert.ok(Object.keys(x).every((k) => ok.has(k))); });
  compute(d);
});

test("the page and its scripts use one version", () => {
  const page = readFileSync(new URL("../fund/index.html", import.meta.url), "utf8");
  const app = readFileSync(new URL("../fund/app.js", import.meta.url), "utf8");
  const v = page.match(/app\.js\?v=(\w+)/)[1];
  assert.ok(page.includes(`fund.css?v=${v}`) && app.includes(`stats.js?v=${v}`));
});
