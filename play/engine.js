// QuillJay Play engine: decodes a day file (tools/export_day.py) and runs a practice-money account on it.
// No DOM here, so tools/test_engine.mjs can test it with node.
//
// Rules (match the zdte-bot where it has one):
//   LONG buys a 0DTE call, SHORT buys a 0DTE put. Buy at the ask, sell at the bid, $0.68 a contract each way.
//   Every value shown (cost, cash-out, P&L) already has both sides' fees in it.
//   One position at a time. No entries from 15:50; an open position is sold at the bid at 15:50 (the bot's flatten).
//   A held contract with no quote keeps its last quote for up to CARRY_S (the feed drops a second now and then),
//   then is valued at intrinsic (recorder gap, strike left the band); either way marked "est.".

export const DAY_S = 23400; // 09:30-16:00
export const FLATTEN_S = DAY_S - 600; // 15:50
export const FEE = 0.68; // per contract, per side: Schwab's $0.65 + ~$0.03 regulatory (as the zdte-bot backtester)
export const START_CASH = 1000;
export const CARRY_S = 30;

export function unpack(s, len) {
  const out = new Int32Array(len);
  let v = 0, i = 0;
  if (s) for (const tok of s.split(",")) {
    if (tok[0] === "~") {
      const end = i + Number(tok.slice(1));
      out.fill(v, i, end);
      i = end;
    } else {
      v += Number(tok);
      out[i++] = v;
    }
  }
  if (i !== len) throw new Error(`bad series: ${i} values, expected ${len}`);
  return out;
}

function series(o, n) {
  const ok = new Uint8Array(n);
  ok.fill(1, o.i0, o.i0 + o.len);
  for (const [a, b] of o.g || []) ok.fill(0, a, b);
  return ok;
}

export const key = (r, k) => r + k;

export function decodeDay(j) {
  if (j.v !== 1) throw new Error(`unknown day format v${j.v}`);
  const n = j.n;
  const spy = unpack(j.spy.d, j.spy.len);
  const spyOk = series(j.spy, n);
  const opts = new Map();
  for (const o of j.opts) {
    const bid = unpack(o.b, o.len), spr = unpack(o.s, o.len);
    const ask = new Int32Array(o.len);
    for (let i = 0; i < o.len; i++) ask[i] = bid[i] + spr[i];
    opts.set(key(o.r, o.k), { r: o.r, k: o.k, i0: o.i0, bid, ask, ok: series(o, n) });
  }
  const strikes = [...new Set(j.opts.map((o) => o.k))].sort((a, b) => a - b);
  return { id: j.id, date: j.date, und: j.und, t0: j.t0, n, synthetic: !!j.synthetic, spy, spyOk, opts, strikes };
}

// "10:42:07" for second i of the session (09:30 + i)
export function clock(i, secs = true) {
  const t = 9 * 3600 + 1800 + Math.max(0, Math.floor(i));
  const h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, s = t % 60;
  const hh = String(h).padStart(2, "0"), mm = String(m).padStart(2, "0");
  return secs ? `${hh}:${mm}:${String(s).padStart(2, "0")}` : `${hh}:${mm}`;
}

export const price = (day, i) => day.spy[Math.min(Math.max(0, i), day.n - 1)] / 100;
export const live = (day, i) => i >= 0 && i < day.n && day.spyOk[i] === 1;

// The contract's quote at second i, in dollars. ok=false: no quote this second; bid/ask are then the last quote
// within CARRY_S, else intrinsic (est.).
export function quote(day, opt, i) {
  if (opt.ok[i]) return { bid: opt.bid[i - opt.i0] / 100, ask: opt.ask[i - opt.i0] / 100, ok: true };
  for (let j = i - 1; j >= Math.max(opt.i0, i - CARRY_S); j--) {
    if (opt.ok[j]) return { bid: opt.bid[j - opt.i0] / 100, ask: opt.ask[j - opt.i0] / 100, ok: false };
  }
  const s = price(day, i);
  const v = Math.max(0, Math.round((opt.r === "C" ? s - opt.k : opt.k - s) * 100) / 100);
  return { bid: v, ask: v, ok: false };
}

// The contract LONG/SHORT buys at second i: the strike nearest the money with a live quote and an ask, moved
// `otm` strikes out of the money (negative = in the money). Null if none.
export function pick(day, i, side, otm = 0) {
  const r = side === "long" ? "C" : "P";
  const s = price(day, i);
  const ks = day.strikes.filter((k) => {
    const o = day.opts.get(key(r, k));
    return o && o.ok[i] && o.ask[i - o.i0] > 0;
  });
  if (!ks.length) return null;
  let atm = 0;
  for (let j = 1; j < ks.length; j++) if (Math.abs(ks[j] - s) < Math.abs(ks[atm] - s)) atm = j;
  const j = atm + (r === "C" ? otm : -otm);
  return j >= 0 && j < ks.length ? day.opts.get(key(r, ks[j])) : null;
}

// Chain rows around the money at second i: [{k, call: quote|null, put: quote|null}]
export function chain(day, i, each = 5) {
  const s = price(day, i);
  const ks = day.strikes.filter((k) => ["C", "P"].some((r) => day.opts.get(key(r, k))?.ok[i]));
  ks.sort((a, b) => Math.abs(a - s) - Math.abs(b - s));
  return ks.slice(0, 2 * each + 1).sort((a, b) => b - a).map((k) => {
    const q = (r) => { const o = day.opts.get(key(r, k)); return o && o.ok[i] ? quote(day, o, i) : null; };
    return { k, call: q("C"), put: q("P") };
  });
}

// The SPY level where cashing out would pay back exactly what was paid (fees included), at second i:
//   call: SPY - pnl / (100 x qty x delta)     put: SPY + pnl / (100 x qty x delta)
// with delta read off the neighbouring strikes' mids (dC/dS ~ -dC/dK). Taken once at entry it is the "entry + fees"
// line: how far SPY has to move to pay back the spread and both fees.
export function breakeven(day, i, pos, pnl) {
  const mid = (k) => {
    const o = day.opts.get(key(pos.r, k));
    return o && o.ok[i] ? (o.bid[i - o.i0] + o.ask[i - o.i0]) / 200 : null;
  };
  const j = day.strikes.indexOf(pos.k);
  const pts = [day.strikes[j - 1], pos.k, day.strikes[j + 1]].filter((k) => k != null && mid(k) != null);
  let delta = 0.5;
  if (pts.length >= 2) {
    const lo = pts[0], hi = pts[pts.length - 1];
    delta = Math.abs(mid(lo) - mid(hi)) / (hi - lo);
  }
  delta = Math.min(1, Math.max(0.05, delta));
  const move = pnl / (100 * pos.qty * delta);
  return price(day, i) + (pos.r === "C" ? -move : move);
}

const r2 = (x) => Math.round(x * 100) / 100;
const fees = (bid, qty) => (bid > 0 ? FEE * qty : 0); // nothing to sell at a zero bid: it expires, no commission

export class Account {
  constructor(cash = START_CASH) {
    this.cash = cash;
    this.pos = null;
    this.trades = [];
  }

  static from(o) {
    const a = new Account(o?.cash ?? START_CASH);
    a.trades = Array.isArray(o?.trades) ? o.trades : [];
    a.pos = o?.pos ?? null;
    return a;
  }

  toJSON() {
    return { cash: this.cash, pos: this.pos, trades: this.trades };
  }

  // Contracts the cash buys at this ask, commission included
  maxQty(ask) {
    return ask > 0 ? Math.max(0, Math.floor((this.cash + 1e-9) / (ask * 100 + FEE))) : 0;
  }

  // Buy qty of the contract (pick() or a chain click) at second i. Returns {ok, msg}.
  open(day, i, side, opt, qty) {
    if (this.pos) return { ok: false, msg: "Already in a trade" };
    if (!live(day, i)) return { ok: false, msg: "No market data right now" };
    if (i >= FLATTEN_S) return { ok: false, msg: "No new trades after 15:50" };
    if (!opt || !opt.ok[i]) return { ok: false, msg: "No quote for that contract" };
    const q = quote(day, opt, i);
    if (!(q.ask > 0)) return { ok: false, msg: "No ask" };
    qty = Math.min(Math.floor(qty), this.maxQty(q.ask));
    if (qty < 1) return { ok: false, msg: `Not enough cash for 1 contract ($${(q.ask * 100 + FEE).toFixed(2)})` };
    const cost = r2(q.ask * 100 * qty + FEE * qty);
    this.cash = r2(this.cash - cost);
    this.pos = { day: day.id, side, r: opt.r, k: opt.k, qty, i, ask: q.ask, cost, spy: price(day, i) };
    this.pos.level = r2(breakeven(day, i, this.pos, this.mark(day, i).pnl)); // entry + fees: fixed for the trade
    return { ok: true, msg: `Bought ${qty} ${opt.k}${opt.r} @ ${q.ask.toFixed(2)}` };
  }

  // The open position at second i: what selling now would bring, after commission
  mark(day, i) {
    const p = this.pos;
    if (!p) return null;
    const opt = day.opts.get(key(p.r, p.k));
    const q = opt ? quote(day, opt, i) : { bid: 0, ask: 0, ok: false };
    const value = r2(q.bid * 100 * p.qty - fees(q.bid, p.qty));
    return { bid: q.bid, est: !q.ok, value, pnl: r2(value - p.cost), mult: value / p.cost };
  }

  close(day, i, why = "you") {
    const p = this.pos;
    if (!p) return { ok: false, msg: "No open trade" };
    const m = this.mark(day, i);
    this.cash = r2(this.cash + m.value);
    const t = { ...p, out: i, bid: m.bid, est: m.est, value: m.value, pnl: m.pnl, why };
    this.trades.push(t);
    this.pos = null;
    return { ok: true, msg: `Sold @ ${m.bid.toFixed(2)}${m.est ? " (est.)" : ""}: ${m.pnl >= 0 ? "+" : "-"}$${Math.abs(m.pnl).toFixed(2)}`, trade: t };
  }

  // Call every tick: sells at 15:50 (and at the end of the data). Returns the close result or null.
  step(day, i) {
    if (this.pos && this.pos.day === day.id && i >= FLATTEN_S) return this.close(day, Math.min(i, day.n - 1), "15:50");
    return null;
  }

  stats(dayId) {
    const ts = dayId ? this.trades.filter((t) => t.day === dayId) : this.trades;
    const pnl = r2(ts.reduce((s, t) => s + t.pnl, 0));
    const wins = ts.filter((t) => t.pnl > 0).length;
    return { n: ts.length, wins, pnl, best: ts.length ? Math.max(...ts.map((t) => t.pnl)) : 0, worst: ts.length ? Math.min(...ts.map((t) => t.pnl)) : 0 };
  }
}
