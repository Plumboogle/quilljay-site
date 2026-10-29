// node --test tools/
import assert from "node:assert/strict";
import test from "node:test";
import { Account, FLATTEN_S, breakeven, chain, clock, decodeDay, pick, price, quote, unpack } from "../play/engine.js";

const N = 23400;
const run = (v, len) => `${v},~${len - 1}`; // a value held for len seconds

// SPY 580.00 all day except 581.40 from second 100; C580 and C581 and P580 quoted from second 10
function day(extra = {}) {
  return decodeDay({
    v: 1, id: "t", date: "2026-10-27", und: "SPY", t0: 0, n: N, synthetic: true,
    spy: { i0: 0, len: N, d: `58000,~99,140,~${N - 101}`, g: [[5000, 5100]] },
    opts: [
      { r: "C", k: 580, i0: 10, len: N - 10, b: `120,~89,-20,~${N - 101}`, s: run(2, N - 10), g: [] },
      { r: "C", k: 581, i0: 10, len: N - 10, b: run(80, N - 10), s: run(2, N - 10), g: [[200, 300]] },
      { r: "P", k: 580, i0: 10, len: N - 10, b: run(110, N - 10), s: run(2, N - 10), g: [] },
    ],
    ...extra,
  });
}

test("unpack", () => {
  assert.deepEqual([...unpack("5,~2,1,-3", 5)], [5, 5, 5, 6, 3]);
  assert.throws(() => unpack("5,~2", 5));
});

test("clock", () => {
  assert.equal(clock(0), "09:30:00");
  assert.equal(clock(3727), "10:32:07");
  assert.equal(clock(FLATTEN_S, false), "15:50");
});

test("pick: nearest strike with a quote, otm offsets", () => {
  const d = day();
  assert.equal(pick(d, 50, "long").k, 580);
  assert.equal(pick(d, 50, "long", 1).k, 581);
  assert.equal(pick(d, 150, "long").k, 581); // SPY 581.40
  assert.equal(pick(d, 250, "long").k, 580); // 581 not quoted (gap)
  assert.equal(pick(d, 50, "short").r, "P");
  assert.equal(pick(d, 5, "long"), null); // before any option quote
  assert.equal(pick(d, 50, "short", 1), null); // no lower put strike
});

test("buy at ask, sell at bid, commission each way", () => {
  const d = day(), a = new Account(1000);
  const r = a.open(d, 50, "long", pick(d, 50, "long"), 2);
  assert.ok(r.ok, r.msg);
  assert.equal(a.pos.ask, 1.22);
  assert.equal(a.pos.cost, 245.36); // 2 x 122 + 2 x 0.68
  assert.equal(a.cash, 754.64);
  const m = a.mark(d, 60);
  assert.equal(m.value, 238.64); // 2 x 120 - 1.36: what cash out pays
  assert.equal(m.pnl, -6.72);
  assert.ok(!a.open(d, 61, "short", pick(d, 61, "short"), 1).ok); // one at a time
  const c = a.close(d, 100); // bid fell to 1.00
  assert.equal(c.trade.pnl, -46.72); // 2 x 100 - 1.36 - 245.36
  assert.equal(a.cash, 953.28);
  assert.equal(a.pos, null);
  assert.deepEqual(a.stats("t"), { n: 1, wins: 0, pnl: -46.72, best: -46.72, worst: -46.72 });
});

test("size is capped by cash", () => {
  const d = day(), a = new Account(300);
  a.open(d, 50, "long", pick(d, 50, "long"), 99);
  assert.equal(a.pos.qty, 2); // 122.68 each
  const b = new Account(100);
  const r = b.open(d, 50, "long", pick(d, 50, "long"), 1);
  assert.ok(!r.ok);
  assert.match(r.msg, /Not enough cash/);
});

test("no entries in a data gap or after 15:50; flatten at 15:50", () => {
  const d = day(), a = new Account(1000);
  assert.ok(!a.open(d, 5050, "long", d.opts.get("C580"), 1).ok);
  assert.ok(!a.open(d, FLATTEN_S, "long", d.opts.get("C580"), 1).ok);
  a.open(d, FLATTEN_S - 5, "long", d.opts.get("C580"), 1);
  assert.equal(a.step(d, FLATTEN_S - 1), null);
  const c = a.step(d, FLATTEN_S);
  assert.equal(c.trade.why, "15:50");
  assert.equal(a.pos, null);
});

test("held contract without a quote: last quote for 30 s, then intrinsic (est.)", () => {
  const d = day(), a = new Account(1000);
  a.open(d, 150, "long", d.opts.get("C581"), 1);
  assert.deepEqual(quote(d, d.opts.get("C581"), 229), { bid: 0.8, ask: 0.82, ok: false }); // gap from 200: carried
  const m = a.mark(d, 250); // C581 in the gap for 51 s, SPY 581.40
  assert.ok(m.est);
  assert.equal(m.bid, 0.4);
  assert.deepEqual(quote(d, d.opts.get("C581"), 250), { bid: 0.4, ask: 0.4, ok: false });
});

test("zero bid sells for nothing, no commission", () => {
  const d = decodeDay({
    v: 1, id: "z", date: "2026-10-27", und: "SPY", t0: 0, n: N, synthetic: true,
    spy: { i0: 0, len: N, d: run(58000, N), g: [] },
    opts: [{ r: "C", k: 585, i0: 0, len: N, b: `1,~9,-1,~${N - 11}`, s: run(1, N), g: [] }],
  });
  const a = new Account(1000);
  a.open(d, 1, "long", d.opts.get("C585"), 1);
  assert.equal(a.pos.cost, 2.68);
  assert.equal(a.close(d, 20).trade.value, 0);
  assert.equal(a.cash, 997.32);
});

test("chain is sorted high to low around the money", () => {
  const rows = chain(day(), 50, 1);
  assert.deepEqual(rows.map((r) => r.k), [581, 580]);
  assert.equal(rows[1].call.ask, 1.22);
  assert.equal(rows[0].put, null);
});

test("account survives JSON", () => {
  const d = day(), a = new Account(1000);
  a.open(d, 50, "long", pick(d, 50, "long"), 1);
  const b = Account.from(JSON.parse(JSON.stringify(a)));
  assert.equal(b.cash, a.cash);
  assert.equal(b.close(d, 60).ok, true);
});

test("sample day decodes", async () => {
  const fs = await import("node:fs");
  const url = new URL("../play/days/sample-1.json", import.meta.url);
  if (!fs.existsSync(url)) return;
  const d = decodeDay(JSON.parse(fs.readFileSync(url, "utf8")));
  assert.equal(d.synthetic, true);
  assert.ok(pick(d, 60, "long") && pick(d, 60, "short"));
  assert.ok(!d.spyOk[11_450]); // the sample's recorder outage
});

test("the cash-out value shown is exactly what closing pays, fees included", () => {
  const d = day(), a = new Account(1000);
  a.open(d, 50, "long", pick(d, 50, "long"), 3);
  assert.equal(a.pos.cost, 368.04); // 3 x 122 + 3 x 0.68: the fee is part of what you paid
  const shown = a.mark(d, 120), before = a.cash;
  assert.equal(shown.value, 297.96); // 3 x 100 - 3 x 0.68
  assert.equal(shown.pnl, -70.08);
  const t = a.close(d, 120).trade;
  assert.equal(t.value, shown.value);
  assert.equal(t.pnl, shown.pnl);
  assert.equal(Math.round((a.cash - before) * 100) / 100, shown.value);
  assert.equal(Math.round((a.cash - 1000) * 100) / 100, shown.pnl);
});

test("break-even: SPY is past it exactly when the P&L is positive", () => {
  const d = day(), a = new Account(1000);
  a.open(d, 50, "long", d.opts.get("C580"), 1);
  // delta from C580 (1.21 mid) and C581 (0.81 mid): 0.40; P&L at 60: 120 - 0.68 - 122.68 = -3.36
  const m = a.mark(d, 60);
  const be = breakeven(d, 60, a.pos, m.pnl);
  assert.equal(Math.round(be * 100) / 100, Math.round((580 - m.pnl / 40) * 100) / 100);
  assert.ok(m.pnl < 0 && price(d, 60) < be); // losing: SPY below break-even
  for (const pnl of [-50, -0.01, 0.01, 50]) { // the sign rule holds for any P&L, calls and puts
    assert.equal(price(d, 60) > breakeven(d, 60, a.pos, pnl), pnl > 0);
    assert.equal(price(d, 60) < breakeven(d, 60, { ...a.pos, r: "P" }, pnl), pnl > 0);
  }
});

test("entry + fees line: a little above entry for a long, below for a short, fixed", () => {
  const d = day(), a = new Account(1000);
  a.open(d, 50, "long", d.opts.get("C580"), 1);
  // at entry: cost 122.68, cash out 120 - 0.68 = 119.32, so -3.36 to make up at delta 0.40: SPY +0.084
  assert.equal(a.pos.level, 580.08);
  a.close(d, 60);
  a.open(d, 61, "short", d.opts.get("P580"), 1);
  assert.ok(a.pos.level < a.pos.spy);
});

test("page, script and engine carry the same version (phones cache files ~10 min)", async () => {
  const fs = await import("node:fs");
  const read = (f) => fs.readFileSync(new URL(`../play/${f}`, import.meta.url), "utf8");
  const html = read("index.html"), app = read("app.js");
  const v = html.match(/app\.js\?v=(\w+)/)[1];
  assert.equal(html.match(/play\.css\?v=(\w+)/)[1], v);
  assert.equal(app.match(/engine\.js\?v=(\w+)/)[1], v);
});

test("15:50 flatten sells at 15:50's quote even when the clock jumped past it", () => {
  const d = decodeDay({
    v: 1, id: "f", date: "2026-10-27", und: "SPY", t0: 0, n: N, synthetic: true,
    spy: { i0: 0, len: N, d: run(58000, N), g: [] },
    opts: [{ r: "C", k: 580, i0: 0, len: N, b: `120,~${FLATTEN_S},-10,~${N - FLATTEN_S - 2}`, s: run(2, N), g: [] }],
  });
  const a = new Account(1000);
  a.open(d, 10, "long", d.opts.get("C580"), 1);
  const t = a.step(d, FLATTEN_S + 14).trade; // bid 1.20 through 15:50:00, 1.10 from 15:50:01
  assert.equal(t.out, FLATTEN_S);
  assert.equal(t.bid, 1.2);
});
