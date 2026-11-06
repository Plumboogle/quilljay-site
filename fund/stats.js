// The numbers behind quilljay.com/fund/. No DOM, so tools/test_fund.mjs can test them.
export const GOAL_VALUE = 1000000;
export const GOAL_RATE = 0.01; // the goal line: +1% a trade, compounding
export const TRADERS = ["J", "Q", "W"];

const cents = (v) => Math.round(v * 100) / 100;

export const goalAt = (start, n) => start * (1 + GOAL_RATE) ** n;

// The first trade number at which the goal line reaches GOAL_VALUE.
export const tradesToGoal = (start) => Math.ceil(Math.log(GOAL_VALUE / start) / Math.log(1 + GOAL_RATE));

// Dollars after fees. `mult` is 100 for an option contract (the default) and 1 for shares.
export function tradePnl(t) {
  const sign = t.side === "short" ? -1 : 1;
  return cents(sign * (t.out - t.in) * t.qty * (t.mult ?? 100) - (t.fees ?? 0));
}

export function checkTrade(t, i) {
  const bad = (what) => new Error(`trade ${i + 1}: ${what}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t.date ?? "")) throw bad("date must look like 2026-11-20");
  if (!TRADERS.includes(t.by)) throw bad(`by must be one of ${TRADERS.join(", ")}`);
  if (!t.contract) throw bad("contract is missing");
  if (t.side !== "long" && t.side !== "short") throw bad("side must be long or short");
  for (const k of ["qty", "in", "out"]) {
    if (typeof t[k] !== "number" || !(t[k] >= 0)) throw bad(`${k} must be a number`);
  }
  if (!(t.qty > 0)) throw bad("qty must be above zero");
}

export function compute(data) {
  const start = data.start;
  let value = start;
  const rows = (data.trades ?? []).map((t, i) => {
    checkTrade(t, i);
    const before = value;
    const pnl = tradePnl(t);
    value = cents(value + pnl);
    return { ...t, n: i + 1, pnl, pct: before > 0 ? (pnl / before) * 100 : null, value };
  });
  const n = rows.length;
  const goalNow = goalAt(start, n);
  const wins = rows.filter((r) => r.pnl > 0).length;
  const byPnl = [...rows].sort((a, b) => b.pnl - a.pnl);
  return {
    start,
    rows,
    n,
    value,
    wins,
    winRate: n ? (wins / n) * 100 : null,
    best: byPnl[0] ?? null,
    worst: byPnl[n - 1] ?? null,
    returnPct: ((value - start) / start) * 100,
    goalNow,
    gapDollars: cents(value - goalNow),
    // How many goal-line trades the account is ahead of (+) or behind (-). No answer once the account is at zero.
    gapTrades: value > 0 ? Math.log(value / start) / Math.log(1 + GOAL_RATE) - n : null,
    avgGainPct: n && value > 0 ? ((value / start) ** (1 / n) - 1) * 100 : null,
    toGoal: tradesToGoal(start),
  };
}

// Log-scale ticks at 1, 2 and 5 of each power of ten; only the powers of ten when that is too many.
export function logTicks(lo, hi) {
  const all = [];
  for (let k = Math.floor(Math.log10(lo)); k <= Math.ceil(Math.log10(hi)); k++) {
    for (const m of [1, 2, 5]) {
      const v = m * 10 ** k;
      if (v >= lo && v <= hi) all.push(v);
    }
  }
  return all.length > 6 ? all.filter((v) => Number.isInteger(Math.log10(v))) : all;
}

// Whole-number trade ticks: about `want` of them from 0.
export function tradeTicks(max, want = 6) {
  const raw = max / want;
  const pow = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow;
  const out = [];
  for (let v = 0; v <= max; v += step) out.push(v);
  return out;
}

// Round-number ticks from 0 for the normal (not log) value scale.
export function valueTicks(max, want = 5) {
  const raw = max / want;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((v) => v >= raw);
  const out = [];
  for (let v = 0; v <= max; v += step) out.push(v);
  return out;
}
