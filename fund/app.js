import { compute, goalAt, logTicks, tradeTicks, valueTicks } from "./stats.js?v=20261106c";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const money = (v, d = 2) => `${v < 0 ? "-" : ""}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
const smoney = (v) => `${v > 0 ? "+" : ""}${money(v)}`;
const pct = (v, d = 1) => (v == null ? "–" : `${v > 0 ? "+" : ""}${v.toFixed(d)}%`);
const tone = (v) => (v > 0 ? "up" : v < 0 ? "down" : "");
const short = (v) => (v >= 1e6 ? `$${v / 1e6}M` : v >= 1e3 ? `$${v / 1e3}K` : `$${v}`);
const whole = (v) => money(v, v >= 1000 ? 0 : 2);

let S, range;
let scale = "log";

function renderSummary(data) {
  $("sample").hidden = !data.sample;
  if (data.sample) $("valuelabel").textContent = "Sample account value";
  const opening = data.status === "opening";
  $("status").hidden = !opening;
  if (opening) $("status").textContent = "Account opening";
  $("value").textContent = money(S.value);
  $("ret").textContent = pct(S.returnPct);
  $("ret").className = tone(S.returnPct);
  $("start").textContent = money(S.start, 0);
  if (S.n) {
    const word = S.gapDollars >= 0 ? "Ahead of goal" : "Behind goal";
    const t = S.gapTrades == null ? "" : ` · ${Math.abs(S.gapTrades).toFixed(1)} trades`;
    $("gap").innerHTML = `<span class="${tone(S.gapDollars)}">${word} ${money(Math.abs(S.gapDollars))}${t}</span> <span class="mute">goal at trade ${S.n}: ${money(S.goalNow)}</span>`;
  } else {
    $("gap").innerHTML = `<span class="mute">No trades yet. The goal starts at trade 1.</span>`;
  }
  $("asof").textContent = data.updated ? `As of ${data.updated}` : "";
  const stat = (k, v, n = "", cls = "") => `<div class="stat"><div class="k">${k}</div><div class="v ${cls}">${v}</div><div class="n">${n}</div></div>`;
  const tradeNote = (r) => (r ? `#${r.n} · ${esc(r.by)} · ${esc(r.contract)}` : "");
  $("stats").innerHTML = [
    stat("Trades", S.n),
    stat("Trades to $1M", Math.max(0, S.toGoal - S.n), `${S.toGoal} in all on the goal line`),
    stat("Win rate", S.winRate == null ? "–" : `${S.winRate.toFixed(0)}%`, S.n ? `${S.wins} of ${S.n} won` : ""),
    stat("Average per trade", S.avgGainPct == null ? "–" : pct(S.avgGainPct, 2), "goal +1.00%, compounding", tone(S.avgGainPct)),
    stat("Best trade", S.best ? smoney(S.best.pnl) : "–", tradeNote(S.best), S.best ? tone(S.best.pnl) : ""),
    stat("Worst trade", S.worst ? smoney(S.worst.pnl) : "–", tradeNote(S.worst), S.worst ? tone(S.worst.pnl) : ""),
  ].join("");
  $("count").textContent = S.n ? `${S.n}, newest first` : "";
  $("trades").innerHTML = S.n
    ? `<tr><th class="r">#</th><th>Date</th><th>By</th><th>Trade</th><th class="r">Qty</th><th class="r">In</th><th class="r">Out</th><th class="r">P&amp;L</th><th class="r">Gain</th><th class="r">Value after</th></tr>` +
      [...S.rows].reverse().map((r) => `<tr><td class="r">${r.n}</td><td>${esc(r.date)}</td><td>${esc(r.by)}</td><td>${esc(r.side)} ${esc(r.contract)}</td><td class="r">${esc(r.qty)}</td><td class="r">${r.in.toFixed(2)}</td><td class="r">${r.out.toFixed(2)}</td><td class="r ${tone(r.pnl)}">${smoney(r.pnl)}</td><td class="r ${tone(r.pnl)}">${pct(r.pct)}</td><td class="r">${money(r.value)}</td></tr>`).join("")
    : `<tr><td class="empty">No trades yet. The first one shows up here.</td></tr>`;
}

function renderChart() {
  const plot = $("plot");
  const W = Math.max(280, plot.clientWidth);
  const H = W < 520 ? 280 : 380;
  const m = { l: 50, r: 62, t: 14, b: 26 };
  const full = range === "full";
  const xMax = full ? S.toGoal : Math.max(10, Math.ceil(S.n * 1.15));
  const vals = S.rows.map((r) => Math.max(r.value, 10));
  const log = scale === "log";
  const yMin = log ? Math.max(10, Math.min(S.start, ...vals) / 1.12) : 0;
  const yMax = Math.max(goalAt(S.start, xMax), S.start, ...vals) * (log && full ? 1.25 : 1.06);
  const x = (n) => m.l + (n / xMax) * (W - m.l - m.r);
  const share = (v) => (log ? (Math.log(Math.max(v, 10)) - Math.log(yMin)) / (Math.log(yMax) - Math.log(yMin)) : Math.max(v, 0) / yMax);
  const y = (v) => H - m.b - share(v) * (H - m.t - m.b);
  const pts = [[0, S.start], ...S.rows.map((r) => [r.n, r.value])];
  const line = pts.map(([n, v], i) => `${i ? "L" : "M"}${x(n).toFixed(1)} ${y(v).toFixed(1)}`).join("");
  const [lastN, lastV] = pts[pts.length - 1];
  const goalEnd = goalAt(S.start, xMax);
  const yt = (log ? logTicks(yMin, yMax) : valueTicks(yMax)).map((v) => `<line class="g" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end">${short(v)}</text>`).join("");
  const xt = tradeTicks(xMax, W < 520 ? 4 : 7).map((n) => `<text x="${x(n)}" y="${H - 8}" text-anchor="middle">${n}</text>`).join("");
  const realLabelY = y(lastV);
  let goalLabelY = y(goalEnd);
  if (lastN === xMax && Math.abs(goalLabelY - realLabelY) < 14) goalLabelY = realLabelY - 14;
  const steps = Math.min(xMax, 200); // enough points that the goal reads as a smooth curve on the normal scale
  const goalPath = Array.from({ length: steps + 1 }, (_, i) => {
    const n = (i / steps) * xMax;
    return `${i ? "L" : "M"}${x(n).toFixed(1)} ${y(goalAt(S.start, n)).toFixed(1)}`;
  }).join("");
  plot.querySelector("svg")?.remove();
  plot.insertAdjacentHTML("afterbegin", `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="Account value ${money(S.value)} after ${S.n} trades, against a goal line of 1% a trade. The table below has every number.">
    ${yt}${xt}
    <path class="goal" d="${goalPath}"/>
    <path class="real" d="${line}"/>
    <circle class="dot" cx="${x(lastN)}" cy="${y(lastV)}" r="5"/>
    <text class="end" x="${x(xMax) + 6}" y="${goalLabelY + 4}">Goal</text>
    <text class="end" x="${Math.min(x(lastN) + 9, W - 56)}" y="${realLabelY + (Math.abs(realLabelY - goalLabelY) < 14 ? 16 : 4)}">Real</text>
    <g id="hover" visibility="hidden"><line class="cross" id="cx" y1="${m.t}" y2="${H - m.b}"/><circle class="goaldot" id="cg" r="5"/><circle class="dot" id="cr" r="5"/></g>
    <rect id="hit" x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}" fill="transparent"/>
  </svg>`);
  const tip = $("tip");
  const hide = () => { $("hover").setAttribute("visibility", "hidden"); tip.hidden = true; };
  const moveTo = (e) => {
    const box = plot.getBoundingClientRect();
    const px = e.clientX - box.left;
    const n = Math.max(0, Math.min(xMax, Math.round(((px - m.l) / (W - m.l - m.r)) * xMax)));
    const goal = goalAt(S.start, n);
    const real = n === 0 ? S.start : S.rows[n - 1]?.value;
    $("hover").setAttribute("visibility", "visible");
    $("cx").setAttribute("x1", x(n)); $("cx").setAttribute("x2", x(n));
    $("cg").setAttribute("cx", x(n)); $("cg").setAttribute("cy", y(goal));
    $("cr").setAttribute("visibility", real == null ? "hidden" : "inherit");
    if (real != null) { $("cr").setAttribute("cx", x(n)); $("cr").setAttribute("cy", y(real)); }
    const row = (k, v, cls = "") => `<div class="row"><span class="mute">${k}</span><b class="${cls}">${v}</b></div>`;
    tip.innerHTML = `<div class="mute">Trade ${n}</div>${real == null ? "" : row("Real", whole(real))}${row("Goal", whole(goal))}${real == null ? "" : row("Gap", (real - goal >= 0 ? "+" : "") + whole(real - goal), tone(real - goal))}`;
    tip.hidden = false;
    const w = tip.offsetWidth;
    tip.style.left = `${x(n) + 12 + w > W ? x(n) - 12 - w : x(n) + 12}px`;
  };
  const hit = $("hit");
  hit.addEventListener("pointermove", moveTo);
  hit.addEventListener("pointerdown", moveTo);
  hit.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") hide(); }); // a finger lifting keeps the numbers up
  hide();
  $("r_date").setAttribute("aria-pressed", String(!full));
  $("r_full").setAttribute("aria-pressed", String(full));
  $("s_log").setAttribute("aria-pressed", String(log));
  $("s_normal").setAttribute("aria-pressed", String(!log));
  $("axisnote").textContent = log
    ? "Trade number across. Value up, on a log scale: each step is a multiple, so steady 1% growth is a straight line."
    : "Trade number across. Value up, in plain dollars: 1% a trade compounds, so the goal starts flat and curves up.";
}

function setRange(r) { range = r; renderChart(); }
function setScale(v) { scale = v; renderChart(); }

async function main() {
  try {
    const data = window.FUND_DATA ?? (await (await fetch(`trades.json?t=${Math.floor(Date.now() / 60000)}`)).json());
    S = compute(data);
    range = S.n >= 10 ? "date" : "full";
    renderSummary(data);
    renderChart();
    $("r_date").addEventListener("click", () => setRange("date"));
    $("r_full").addEventListener("click", () => setRange("full"));
    $("s_log").addEventListener("click", () => setScale("log"));
    $("s_normal").addEventListener("click", () => setScale("normal"));
    let last = $("plot").clientWidth;
    new ResizeObserver(() => { const w = $("plot").clientWidth; if (w !== last) { last = w; renderChart(); } }).observe($("plot"));
  } catch (e) {
    $("value").textContent = "–";
    $("gap").textContent = `The trade log could not be read: ${e.message}`;
  }
}
main();
