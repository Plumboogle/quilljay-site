// node --test tools/
import assert from "node:assert/strict";
import test from "node:test";
import { Account, FLATTEN_S, chain, clock, decodeDay, pick, quote, unpack } from "../play/engine.js";

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
  assert.equal(a.pos.cost, 245.3); // 2 x 122 + 1.30
  assert.equal(a.cash, 754.7);
  const m = a.mark(d, 60);
  assert.equal(m.value, 238.7); // 2 x 120 - 1.30
  assert.equal(m.pnl, -6.6);
  assert.ok(!a.open(d, 61, "short", pick(d, 61, "short"), 1).ok); // one at a time
  const c = a.close(d, 100); // bid fell to 1.00
  assert.equal(c.trade.pnl, -46.6); // 2 x 100 - 1.30 - 245.30
  assert.equal(a.cash, 953.4);
  assert.equal(a.pos, null);
  assert.deepEqual(a.stats("t"), { n: 1, wins: 0, pnl: -46.6, best: -46.6, worst: -46.6 });
});

test("size is capped by cash", () => {
  const d = day(), a = new Account(300);
  a.open(d, 50, "long", pick(d, 50, "long"), 99);
  assert.equal(a.pos.qty, 2); // 122.65 each
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

test("held contract without a quote is valued at intrinsic (est.)", () => {
  const d = day(), a = new Account(1000);
  a.open(d, 150, "long", d.opts.get("C581"), 1);
  const m = a.mark(d, 250); // C581 in a gap, SPY 581.40
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
  assert.equal(a.pos.cost, 2.65);
  assert.equal(a.close(d, 20).trade.value, 0);
  assert.equal(a.cash, 997.35);
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
