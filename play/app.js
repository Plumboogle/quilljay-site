// QuillJay Play: the page. Replays a recorded day second by second and trades it with practice money.
// Market rules live in engine.js. A live mode later swaps the replay clock and the Account for the zdte app's
// quote stream and broker (see README.md); the views and buttons stay as they are.
import { Account, DAY_S, FEE, FLATTEN_S, START_CASH, breakeven, chain, clock, decodeDay, key, live, pick, price, quote } from "./engine.js";

const $ = (id) => document.getElementById(id);
const STORE = "qj-play-v1";
const SPEEDS = [1, 2, 5, 10, 30, 60];
const ZOOMS = [["5m", 300], ["15m", 900], ["1h", 3600], ["Day", DAY_S]];
const BARS = [["5s", 5], ["15s", 15], ["1m", 60], ["5m", 300]];
const ARCADE_WIN = { 1: 90, 2: 150, 5: 300, 10: 600, 30: 1500, 60: 3000 }; // seconds of line on screen
const QTY_CHIPS = [1, 5, 10, "max"];
// Drawn icons: iPhones render the ▶ character as an emoji
const ICON_PLAY = `<svg class="ico" viewBox="0 0 10 12" aria-hidden="true"><path d="M0 0 10 6 0 12z" fill="currentColor"/></svg>`;
const ICON_PAUSE = `<svg class="ico" viewBox="0 0 10 12" aria-hidden="true"><path d="M0 0h3.5v12H0zM6.5 0H10v12H6.5z" fill="currentColor"/></svg>`;

const S = {
  index: [], day: null, pos: 0, playing: false, speed: 1, view: "arcade", qty: 1, otm: 0, zoom: 900, bar: 60,
  acct: new Account(), disp: null, hover: null, ended: false, savedPos: null,
};

// ---------- storage (per browser; works without it) ----------
function load() {
  try {
    const o = JSON.parse(localStorage.getItem(STORE) || "null");
    if (!o) return;
    S.acct = Account.from(o.acct);
    for (const k of ["speed", "view", "qty", "otm", "zoom", "bar"]) if (o[k] != null) S[k] = o[k];
    S.savedDay = o.day;
    S.savedPos = o.pos;
  } catch { /* private window or blocked storage */ }
}
function save() {
  try {
    localStorage.setItem(STORE, JSON.stringify({
      acct: S.acct, speed: S.speed, view: S.view, qty: S.qty, otm: S.otm, zoom: S.zoom, bar: S.bar,
      day: S.day?.id, pos: S.pos,
    }));
  } catch { /* ignore */ }
}

// ---------- formatting ----------
const usd = (x) => `$${Math.abs(x).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const sgn = (x) => `${x >= 0 ? "+" : "-"}${usd(x)}`;
const pct = (x) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
const cname = (p) => `${p.k}${p.r}`;

let toastT;
function toast(msg, bad = false) {
  const t = $("toast");
  t.textContent = msg;
  t.className = `toast show${bad ? " bad" : ""}`;
  clearTimeout(toastT);
  toastT = setTimeout(() => (t.className = "toast"), 2600);
}

// ---------- days ----------
async function init() {
  load();
  buildChips();
  bindKeys();
  try {
    const r = await fetch("days/index.json", { cache: "no-cache" });
    S.index = (await r.json()).days;
  } catch {
    showOverlay("<h1>No data</h1><p>Couldn't load the list of days.</p>");
    return;
  }
  const sel = $("day");
  sel.innerHTML = S.index.map((d) => `<option value="${d.id}">${d.synthetic ? "Sample · synthetic" : d.date}</option>`).join("");
  const open = S.acct.pos?.day;
  if (open && !S.index.some((d) => d.id === open)) { // the day of a saved open trade is gone: give the money back
    S.acct.cash += S.acct.pos.cost;
    S.acct.pos = null;
  }
  const first = open || (S.index.some((d) => d.id === S.savedDay) ? S.savedDay : S.index[0]?.id);
  if (first) await loadDay(first, open || first === S.savedDay ? S.savedPos : 0);
  requestAnimationFrame(frame);
}

async function loadDay(id, pos = 0) {
  const meta = S.index.find((d) => d.id === id);
  if (!meta) return;
  $("day").value = id;
  S.playing = false;
  showOverlay(`<h1>Loading</h1><p>${meta.synthetic ? "Sample day" : meta.date}</p>`);
  try {
    const r = await fetch(`days/${meta.file}`);
    S.day = decodeDay(await r.json());
  } catch (e) {
    showOverlay(`<h1>No data</h1><p>Couldn't load ${meta.date}.</p>`);
    return;
  }
  S.meta = meta;
  S.pos = Math.min(Math.max(0, pos || 0), S.day.n - 1);
  S.disp = null;
  S.ended = S.pos >= S.day.n - 1;
  const b = $("banner");
  b.hidden = !S.day.synthetic;
  b.textContent = "Sample day: synthetic prices for trying the game, not market data. Recorded days appear in the day list as they're added.";
  S.ended ? endOverlay() : startOverlay();
  save();
}

function startOverlay() {
  const resumed = S.pos > 0;
  const bust = !S.acct.pos && S.acct.cash < 5;
  showOverlay(`<div class="box">
    <h1>${resumed ? "Paused" : bust ? "Busted" : "Ready"}</h1>
    <p>${S.day.synthetic ? "Sample day" : S.day.date} · SPY 0DTE · ${clock(S.pos, false)} NY<br>
      ${bust ? "Out of practice money." : `Cash ${usd(S.acct.cash)}`}</p>
    <div class="row">${bust ? `<button class="go" data-act="reset">Reset to $1,000</button>`
      : `<button class="go" data-act="start">${resumed ? "Resume" : "Start"} ${ICON_PLAY}</button>`}
      ${resumed ? `<button class="alt" data-act="restart">From 09:30</button>` : ""}</div>
    <p>&uarr; long &middot; &darr; short &middot; space cash out</p></div>`);
}

function endOverlay() {
  const st = S.acct.stats(S.day.id);
  const next = S.index[S.index.findIndex((d) => d.id === S.day.id) + 1];
  showOverlay(`<div class="box"><h1>Closed</h1>
    <p>${S.day.synthetic ? "Sample day" : S.day.date} · ${st.n} trade${st.n === 1 ? "" : "s"} ·
      <span class="${st.pnl >= 0 ? "up" : "down"}">${sgn(st.pnl)}</span><br>Cash ${usd(S.acct.cash)}</p>
    <div class="row"><button class="go" data-act="restart">Replay day</button>
      ${next ? `<button class="alt" data-act="next">Next: ${next.synthetic ? "sample" : next.date}</button>` : ""}</div></div>`);
}

function showOverlay(html) {
  const o = $("overlay");
  o.innerHTML = html.startsWith("<div") ? html : `<div class="box">${html}</div>`;
  o.hidden = false;
}
const hideOverlay = () => ($("overlay").hidden = true);

$("overlay").addEventListener("click", (e) => {
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "start") play(true);
  if (act === "restart") { S.pos = 0; S.ended = false; S.disp = null; play(true); }
  if (act === "next") loadDay(S.index[S.index.findIndex((d) => d.id === S.day.id) + 1].id, 0);
  if (act === "reset") resetAccount();
});

function play(on) {
  if (!S.day) return;
  if (on && S.ended) return;
  S.playing = on;
  $("playBtn").innerHTML = on ? ICON_PAUSE : ICON_PLAY;
  $("playBtn").setAttribute("aria-label", on ? "Pause" : "Play");
  if (on) hideOverlay(); else if (!S.ended) startOverlay();
  save();
}

// ---------- controls ----------
function buildChips() {
  $("speeds").innerHTML = SPEEDS.map((s) => `<button data-speed="${s}">${s}&times;</button>`).join("");
  $("qtyChips").innerHTML = QTY_CHIPS.map((q) => `<button data-qty="${q}">${q === "max" ? "Max" : q}</button>`).join("");
  $("speeds").onclick = (e) => { const b = e.target.closest("button"); if (b) { S.speed = +b.dataset.speed; save(); } };
  $("qtyChips").onclick = (e) => {
    const b = e.target.closest("button");
    if (b) { S.qty = b.dataset.qty === "max" ? "max" : +b.dataset.qty; save(); }
  };
  $("views").onclick = (e) => { const b = e.target.closest("button"); if (b) setView(b.dataset.view); };
  $("playBtn").onclick = () => play(!S.playing);
  $("qtyDown").onclick = () => setQty(qtyNum() - 1);
  $("qtyUp").onclick = () => setQty(qtyNum() + 1);
  $("qty").onchange = (e) => setQty(parseInt(e.target.value, 10));
  $("otm").value = String(S.otm);
  $("otm").onchange = (e) => { S.otm = +e.target.value; save(); };
  $("longBtn").onclick = () => enter("long");
  $("shortBtn").onclick = () => enter("short");
  $("exitBtn").onclick = exit;
  $("resetBtn").onclick = () => { if (confirm("Reset practice cash to $1,000 and clear the trade log?")) resetAccount(); };
  $("day").onchange = (e) => {
    if (S.acct.pos) {
      if (!confirm("Cash out the open trade at the current bid and switch day?")) { e.target.value = S.day.id; return; }
      exit();
    }
    loadDay(e.target.value, 0);
  };
  $("chain").onclick = (e) => {
    const b = e.target.closest("button[data-k]");
    if (b) enter(b.dataset.r === "C" ? "long" : "short", S.day.opts.get(key(b.dataset.r, +b.dataset.k)));
  };
  $("chartbar").onclick = (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.dataset.zoom) S.zoom = +b.dataset.zoom;
    if (b.dataset.bar) S.bar = +b.dataset.bar;
    save();
    renderChartbar();
  };
  const c = $("chart");
  c.addEventListener("pointermove", (e) => { const r = c.getBoundingClientRect(); S.hover = { x: e.clientX - r.left, y: e.clientY - r.top }; });
  c.addEventListener("pointerleave", () => (S.hover = null));
  setView(S.view);
}

function setView(v) {
  S.view = ["arcade", "line", "pro"].includes(v) ? v : "arcade";
  document.body.classList.remove("view-arcade", "view-line", "view-pro");
  document.body.classList.add(`view-${S.view}`);
  for (const b of $("views").children) b.setAttribute("aria-selected", String(b.dataset.view === S.view));
  renderChartbar();
  save();
}

function renderChartbar() {
  const z = S.view === "pro" ? BARS.map(([l, s]) => `<button data-bar="${s}" aria-pressed="${s === S.bar}">${l}</button>`)
    : ZOOMS.map(([l, s]) => `<button data-zoom="${s}" aria-pressed="${s === S.zoom}">${l}</button>`);
  $("chartbar").innerHTML = `<div class="chips">${z.join("")}</div>`;
}

const qtyNum = () => (S.qty === "max" ? Math.max(1, S.acct.maxQty(currentPick("long")?.ask ?? 0)) : S.qty);
function setQty(n) {
  S.qty = Math.max(1, Math.min(999, Number.isFinite(n) ? n : 1));
  save();
}

const idx = () => Math.min(Math.floor(S.pos), S.day ? S.day.n - 1 : 0);
function currentPick(side) {
  if (!S.day) return null;
  const i = idx(), o = pick(S.day, i, side, S.otm);
  return o ? { opt: o, ...quote(S.day, o, i) } : null;
}

function enter(side, opt) {
  if (!S.day || S.ended) return;
  if (!S.playing && !S.acct.pos) play(true);
  const i = idx();
  opt = opt || pick(S.day, i, side, S.otm);
  const q = opt ? quote(S.day, opt, i) : null;
  const want = S.qty === "max" ? S.acct.maxQty(q?.ask ?? 0) : S.qty;
  const r = S.acct.open(S.day, i, side, opt, Math.max(1, want));
  toast(r.ok && S.acct.pos.qty < want ? `${r.msg} (cash for ${S.acct.pos.qty})` : r.msg, !r.ok);
  save();
}

function exit() {
  if (!S.day || !S.acct.pos) return;
  const r = S.acct.close(S.day, idx());
  toast(r.msg, !r.ok);
  save();
}

function resetAccount() {
  S.acct = new Account(START_CASH);
  save();
  if (S.day && !S.playing) S.ended ? endOverlay() : startOverlay();
}

function bindKeys() {
  addEventListener("keydown", (e) => {
    if (e.target.closest("input, select, textarea") || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "arrowup" || k === "l") enter("long");
    else if (k === "arrowdown" || k === "s") enter("short");
    else if (k === " " || k === "x") (S.acct.pos ? exit() : play(!S.playing));
    else if (k === "p") play(!S.playing);
    else if (k === "1" || k === "2" || k === "3") setView(["arcade", "line", "pro"][+k - 1]);
    else return;
    e.preventDefault();
  });
  addEventListener("pagehide", save);
  document.addEventListener("visibilitychange", () => { if (document.hidden) { if (S.playing) play(false); save(); } });
}

// ---------- clock ----------
let last = performance.now(), lastSave = 0;
function frame(now) {
  const dt = Math.min(now - last, 250) / 1000;
  last = now;
  if (S.day) {
    if (S.playing) {
      S.pos += dt * S.speed;
      let i = Math.floor(S.pos);
      if (i < S.day.n && !live(S.day, i)) { // recorder gap: jump to the next second with data
        let j = i;
        while (j < S.day.n && !live(S.day, j)) j++;
        if (j < S.day.n) { if (j - i > 5) toast(`No data ${clock(i, false)}-${clock(j, false)}, skipped`); S.pos = j; i = j; }
      }
      if (S.pos >= S.day.n - 1) { S.pos = S.day.n - 1; S.playing = false; S.ended = true; }
    }
    const r = S.acct.step(S.day, idx());
    if (r) toast(`15:50 flatten: ${r.msg}`);
    if (S.ended && $("overlay").hidden) { $("playBtn").innerHTML = ICON_PLAY; endOverlay(); save(); }
    const target = price(S.day, idx());
    const ease = (cur, to) => (cur == null || !S.playing ? to : cur + (to - cur) * (1 - Math.exp(-dt * 14)));
    S.disp = ease(S.disp, target);
    render();
    if (now - lastSave > 2000) { save(); lastSave = now; }
  }
  requestAnimationFrame(frame);
}

// ---------- DOM ----------
const setText = (el, s) => { if (el.textContent !== s) el.textContent = s; };
const setHTML = (el, s) => { if (el._h !== s) { el.innerHTML = s; el._h = s; } };

function render() {
  const d = S.day, i = idx(), px = price(d, i), p = S.acct.pos, m = S.acct.mark(d, i);
  const open = price(d, firstLive(d));
  setText($("time"), clock(i));
  setText($("spy"), px.toFixed(2));
  const ch = px - open;
  setText($("chg"), `${ch >= 0 ? "+" : ""}${ch.toFixed(2)} (${pct(ch / open)})`);
  $("chg").className = ch >= 0 ? "up" : "down";
  setText($("cash"), usd(S.acct.cash + (m ? m.value : 0)));
  for (const b of $("speeds").children) b.setAttribute("aria-pressed", String(+b.dataset.speed === S.speed));
  for (const b of $("qtyChips").children) b.setAttribute("aria-pressed", String(String(S.qty) === b.dataset.qty));
  if (document.activeElement !== $("qty")) $("qty").value = S.qty === "max" ? qtyNum() : S.qty;

  const cutoff = i >= FLATTEN_S, gap = !live(d, i);
  document.body.classList.toggle("pos-in", !!p);
  $("longBtn").hidden = $("shortBtn").hidden = !!p;
  $("exitBtn").hidden = !p;
  if (p) {
    setText($("exitSub"), `${usd(m.value)}${m.est ? " est." : ""} · ${sgn(m.pnl)}`);
    document.body.style.setProperty("--glow", m.pnl >= 0 ? "rgba(34,224,122,.12)" : "rgba(255,77,94,.12)");
  } else {
    for (const side of ["long", "short"]) {
      const c = currentPick(side), btn = $(`${side}Btn`);
      btn.disabled = !c || cutoff || gap || S.ended;
      const n = S.qty === "max" ? S.acct.maxQty(c?.ask ?? 0) : S.qty;
      setText($(`${side}Sub`), cutoff ? "closed after 15:50" : !c || gap ? "no quote" : `${n}× ${cname(c.opt)} @ ${c.ask.toFixed(2)} · ${usd(n * (c.ask * 100 + FEE))}`);
    }
  }
  renderHud(p, m, px);
  if (S.view !== "arcade") renderSide(p, m, i);
  draw();
}

function renderHud(p, m, px) {
  const hud = $("hud");
  hud.className = S.view === "arcade" ? "hud" : "hud corner";
  if (!p) {
    setHTML(hud, S.view === "arcade" ? `<div class="big">${px.toFixed(2)}</div><div class="hint">Up or down?</div>` : "");
    return;
  }
  const cls = m.pnl >= 0 ? "up" : "down";
  setHTML(hud, `<div class="mult ${cls}">${m.mult.toFixed(2)}&times;</div>
    <div class="pnl ${cls}">${sgn(m.pnl)} · ${pct(m.pnl / p.cost)}</div>
    <div class="sub">${p.side === "long" ? "Long" : "Short"} ${p.qty}× SPY ${cname(p)} · ${p.ask.toFixed(2)} &rarr; ${m.bid.toFixed(2)}${m.est ? " est." : ""}</div>`);
}

function renderSide(p, m, i) {
  if (p) {
    setHTML($("posPanel"), `<h2>Open trade <small>${p.side === "long" ? "long · call" : "short · put"}</small></h2>
      <dl class="kv">
        <dt>Contract</dt><dd>${p.qty}× SPY ${cname(p)} 0DTE</dd>
        <dt>In</dt><dd>${clock(p.i)} @ ${p.ask.toFixed(2)} (SPY ${p.spy.toFixed(2)})</dd>
        <dt>Cost</dt><dd>${usd(p.cost)}</dd>
        <dt>Break-even</dt><dd>SPY ${held(i).be.toFixed(2)}</dd>
        <dt>Bid now</dt><dd>${m.bid.toFixed(2)}${m.est ? " est." : ""}</dd>
        <dt>Sell for</dt><dd>${usd(m.value)}</dd>
        <dt>P&amp;L</dt><dd class="${m.pnl >= 0 ? "up" : "down"}">${sgn(m.pnl)} (${pct(m.pnl / p.cost)})</dd>
        <dt>Held</dt><dd>${Math.floor((i - p.i) / 60)}m ${(i - p.i) % 60}s</dd>
      </dl>`);
  } else {
    setHTML($("posPanel"), `<h2>Open trade</h2><p class="flat">Flat. Long buys the ${S.otm === 0 ? "at-the-money" : $("otm").selectedOptions[0].text} call,
      short the put. Sell any time; open trades are sold at 15:50.</p>`);
  }
  if (S.view === "pro") {
    const rows = chain(S.day, i, 5), s = price(S.day, i);
    const atm = rows.reduce((b, r) => (Math.abs(r.k - s) < Math.abs(b.k - s) ? r : b), rows[0] || { k: 0 });
    const cell = (q, r, k) => q ? `<td class="bid">${q.bid.toFixed(2)}</td><td><button class="${r === "C" ? "c" : "p"}" data-r="${r}" data-k="${k}"
      ${p || i >= FLATTEN_S ? "disabled" : ""} aria-label="Buy ${k}${r} at ${q.ask.toFixed(2)}">${q.ask.toFixed(2)}</button></td>` : `<td></td><td></td>`;
    setHTML($("chain"), `<tr><th>Bid</th><th>Call ask</th><th>Strike</th><th>Bid</th><th>Put ask</th></tr>` + rows.map((r) =>
      `<tr class="${r.k === atm.k ? "atm" : ""} ${p && p.k === r.k ? "held" : ""}">${cell(r.call, "C", r.k)}<td class="k">${r.k}</td>${cell(r.put, "P", r.k)}</tr>`).join(""));
  }
  const ts = S.acct.trades.filter((t) => t.day === S.day.id), st = S.acct.stats(S.day.id);
  setText($("stats"), st.n ? `${st.n} · ${Math.round((100 * st.wins) / st.n)}% won · ${sgn(st.pnl)}` : "");
  setHTML($("log"), ts.length ? ts.slice().reverse().map((t) => `<li>
      <span class="${t.side === "long" ? "side-l" : "side-s"}">${t.side === "long" ? "LONG" : "SHORT"}</span>
      <span>${t.qty}× ${cname(t)} ${t.ask.toFixed(2)} &rarr; ${t.bid.toFixed(2)}${t.est ? "*" : ""}</span>
      <span class="${t.pnl >= 0 ? "up" : "down"}">${sgn(t.pnl)}</span>
      <span class="meta">${clock(t.i)} &rarr; ${clock(t.out)}${t.why === "you" ? "" : ` · sold at ${t.why}`}</span></li>`).join("")
    : `<li class="flat">No trades on this day yet.</li>`);
}

const firstLiveCache = new WeakMap();
function firstLive(d) {
  if (!firstLiveCache.has(d)) { let j = 0; while (j < d.n - 1 && !d.spyOk[j]) j++; firstLiveCache.set(d, j); }
  return firstLiveCache.get(d);
}

// ---------- chart ----------
const cv = $("chart"), ctx = cv.getContext("2d");
const C = { up: "#22E07A", down: "#FF4D5E", text: "#E8F2EC", muted: "#6E8580", line: "#14211F", grid: "rgba(110,133,128,.12)", amber: "#F5B841" };

function niceStep(range, n) {
  const raw = range / n, mag = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * mag >= raw) return m * mag;
  return 10 * mag;
}

function fit() {
  const dpr = devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h };
}

function draw() {
  const { w, h } = fit();
  ctx.clearRect(0, 0, w, h);
  if (w < 10 || h < 10) return;
  if (S.view === "pro") drawCandles(w, h);
  else drawLine(w, h, S.view === "arcade");
}

// One point per second, or per pixel column (min/max) when there are more seconds than pixels
function columns(a, b, x0, x1) {
  const d = S.day, pts = [], span = b - a, W = x1 - x0;
  if (span <= W * 1.5) {
    for (let t = Math.max(0, Math.ceil(a)); t <= Math.floor(b); t++) if (d.spyOk[t]) {
      pts.push({ x: x0 + ((t - a) / span) * W, v: d.spy[t] / 100, lo: d.spy[t] / 100, hi: d.spy[t] / 100, t });
    }
    return pts;
  }
  const per = span / W;
  for (let c = 0; c < W; c++) {
    const s = Math.max(0, Math.floor(a + c * per)), e = Math.min(Math.floor(b), Math.floor(a + (c + 1) * per));
    let lo = Infinity, hi = -Infinity, v = null;
    for (let t = s; t <= e; t++) if (d.spyOk[t]) { const p = d.spy[t]; lo = Math.min(lo, p); hi = Math.max(hi, p); v = p; }
    if (v != null) pts.push({ x: x0 + c, v: v / 100, lo: lo / 100, hi: hi / 100, t: e });
  }
  return pts;
}

function yScale(lo, hi, top, bot, minRange) {
  if (hi - lo < minRange) { const m = (hi + lo) / 2; lo = m - minRange / 2; hi = m + minRange / 2; }
  const pad = (hi - lo) * 0.12;
  lo -= pad; hi += pad;
  const f = (v) => bot - ((v - lo) / (hi - lo)) * (bot - top);
  f.lo = lo; f.hi = hi;
  return f;
}

function axes(y, x0, x1, top, bot, tx) {
  ctx.font = "11px 'JetBrains Mono', monospace";
  ctx.textBaseline = "middle";
  const step = niceStep(y.hi - y.lo, 6);
  for (let v = Math.ceil(y.lo / step) * step; v <= y.hi; v += step) {
    const yy = Math.round(y(v)) + 0.5;
    ctx.strokeStyle = C.grid; ctx.beginPath(); ctx.moveTo(x0, yy); ctx.lineTo(x1, yy); ctx.stroke();
    ctx.fillStyle = C.muted; ctx.textAlign = "left"; ctx.fillText(v.toFixed(2), x1 + 6, yy);
  }
  if (tx) {
    const [a, b] = tx, tstep = [15, 30, 60, 120, 300, 600, 900, 1800, 3600].find((s) => (b - a) / s <= (x1 - x0) / 90) || 3600;
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    for (let t = Math.ceil(a / tstep) * tstep; t <= b; t += tstep) {
      const xx = Math.round(x0 + ((t - a) / (b - a)) * (x1 - x0)) + 0.5;
      ctx.strokeStyle = C.grid; ctx.beginPath(); ctx.moveTo(xx, top); ctx.lineTo(xx, bot); ctx.stroke();
      ctx.fillStyle = C.muted; ctx.fillText(clock(t, tstep < 60), xx, bot + 6);
    }
  }
}

function tag(x, y, text, bg, fg = "#05080A") {
  ctx.font = "800 11px 'JetBrains Mono', monospace";
  const w = ctx.measureText(text).width + 10;
  ctx.fillStyle = bg; ctx.fillRect(x, y - 9, w, 18);
  ctx.fillStyle = fg; ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.fillText(text, x + 5, y);
}

// The open trade on this day with its mark and break-even at second i, or null
function held(i) {
  const p = S.acct.pos;
  if (!p || p.day !== S.day.id) return null;
  const m = S.acct.mark(S.day, i);
  return { p, m, be: breakeven(S.day, i, p, m.pnl) };
}
const winning = (h, spy) => (h.p.r === "C" ? spy >= h.be : spy <= h.be); // long: above break-even; short: below

// The SPY line, the same before and after you buy. In a trade, the line from your entry on is green for each second
// cashing out would have paid more than you put in (fees included) and red otherwise, and the dashed line is today's
// break-even; the head is always on the side of break-even that matches the P&L shown.
function drawLine(w, h, arcade) {
  const d = S.day, i = idx(), hd = held(i);
  const b = S.pos, span = arcade ? Math.min(ARCADE_WIN[S.speed] || 300, Math.max(60, b)) : Math.min(S.zoom, DAY_S);
  const a = arcade ? b - span : Math.max(0, Math.min(b - span, DAY_S - span));
  const right = arcade ? w - 70 : w - 64, x0 = arcade ? 0 : 8, top = arcade ? 30 : 48, bot = h - (arcade ? 30 : 28);
  const xHead = arcade ? right : x0 + ((b - a) / span) * (right - x0);
  const pts = columns(a, b, x0, xHead);
  if (!pts.length) return;
  let head = S.disp;
  if (hd && winning(hd, head) !== hd.m.pnl >= 0) head = price(d, i); // the glide never crosses break-even early
  Object.assign(pts[pts.length - 1], { x: xHead, v: head, t: i });
  const lo = Math.min(...pts.map((q) => q.lo), head), hi = Math.max(...pts.map((q) => q.hi), head);
  const minR = arcade ? 0.3 : 0.15;
  const near = hd && Math.abs(hd.be - head) < 2 * Math.max(hi - lo, minR); // far-away break-even: pin it to the edge
  const y = yScale(near ? Math.min(lo, hd.be) : lo, near ? Math.max(hi, hd.be) : hi, top, bot, minR);
  if (!arcade) axes(y, x0, right, top, bot, [a, a + span]);
  else { // faint grid only
    ctx.strokeStyle = C.grid;
    for (let gy = top; gy < bot; gy += 64) { ctx.beginPath(); ctx.moveTo(0, gy + 0.5); ctx.lineTo(w, gy + 0.5); ctx.stroke(); }
  }
  const base = arcade ? C.up : C.text;
  const headCol = hd ? (hd.m.pnl >= 0 ? C.up : C.down) : base;
  const colAt = (q, j) => !hd ? base : q.t < hd.p.i ? C.muted : j === pts.length - 1 ? headCol
    : S.acct.mark(d, q.t).pnl >= 0 ? C.up : C.down;

  // area
  const grad = ctx.createLinearGradient(0, top, 0, bot);
  grad.addColorStop(0, headCol + "33"); grad.addColorStop(1, headCol + "00");
  ctx.beginPath();
  pts.forEach((q, j) => (j ? ctx.lineTo(q.x, y(q.v)) : ctx.moveTo(q.x, y(q.v))));
  ctx.lineTo(xHead, bot); ctx.lineTo(pts[0].x, bot); ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();
  // min/max wicks when squeezed
  if (pts.length > 1 && pts[1].x - pts[0].x <= 1.01) {
    ctx.strokeStyle = base + "55"; ctx.lineWidth = 1; ctx.beginPath();
    for (const q of pts) if (q.hi > q.lo) { ctx.moveTo(q.x + 0.5, y(q.hi)); ctx.lineTo(q.x + 0.5, y(q.lo)); }
    ctx.stroke();
  }
  // line, one colour run at a time
  ctx.save();
  ctx.lineWidth = arcade ? 3 : 1.6; ctx.lineJoin = ctx.lineCap = "round";
  for (let j = 1, start = 0; j <= pts.length; j++) {
    const col = colAt(pts[start + 1] ?? pts[start], start + 1);
    if (j < pts.length && colAt(pts[j], j) === col) continue;
    if (arcade) { ctx.shadowColor = col; ctx.shadowBlur = 14; }
    ctx.strokeStyle = col; ctx.beginPath();
    for (let k = start; k < Math.min(j, pts.length); k++) (k === start ? ctx.moveTo : ctx.lineTo).call(ctx, pts[k].x, y(pts[k].v));
    ctx.stroke();
    start = j - 1;
  }
  ctx.restore();

  if (hd) {
    // break-even
    const by = Math.round(Math.min(bot, Math.max(top, y(hd.be)))) + 0.5;
    const off = by <= top + 0.5 ? " \u2191" : by >= bot + 0.5 ? " \u2193" : "";
    if (!off) {
      ctx.setLineDash([6, 6]); ctx.strokeStyle = C.amber; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x0, by); ctx.lineTo(right, by); ctx.stroke(); ctx.setLineDash([]);
    }
    tag(x0 + 4, by, `BREAK-EVEN ${hd.be.toFixed(2)}${off}`, C.amber);
    // where you bought
    const ex = x0 + ((hd.p.i - a) / span) * (right - x0);
    if (hd.p.i >= a) { ctx.fillStyle = C.amber; ctx.beginPath(); ctx.arc(ex, y(hd.p.spy), 4, 0, 7); ctx.fill(); }
  }
  // past trades of this day
  if (!arcade) for (const t of S.acct.trades) if (t.day === d.id) {
    for (const [ti, c] of [[t.i, t.side === "long" ? C.up : C.down], [t.out, C.muted]]) {
      if (ti < a || ti > b) continue;
      const tx = x0 + ((ti - a) / span) * (right - x0);
      ctx.fillStyle = c; ctx.beginPath(); ctx.arc(tx, y(price(d, ti)), 3.5, 0, 7); ctx.fill();
    }
  }
  // head
  const hy = y(head);
  ctx.fillStyle = headCol; ctx.beginPath(); ctx.arc(xHead, hy, arcade ? 6 : 3.5, 0, 7); ctx.fill();
  if (arcade) {
    const pulse = (performance.now() % 1200) / 1200;
    ctx.strokeStyle = headCol; ctx.globalAlpha = 1 - pulse; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(xHead, hy, 6 + pulse * 18, 0, 7); ctx.stroke(); ctx.globalAlpha = 1;
  }
  tag(right + 4, hy, head.toFixed(2), headCol);
}

function drawCandles(w, h) {
  const d = S.day, B = S.bar, i = idx(), p = S.acct.pos;
  const right = w - 64, x0 = 8, top = 48;
  const pane = Math.max(70, Math.round(h * 0.22)); // always shown, so buying doesn't resize the candles
  const bot = h - 28 - (pane ? pane + 16 : 0);
  const nb = Math.max(10, Math.floor((right - x0) / 9)), cur = Math.floor(i / B), first = Math.max(0, cur - nb + 1);
  const bars = [];
  for (let k = first; k <= cur; k++) {
    let o = null, hi = -Infinity, lo = Infinity, c = null;
    for (let t = k * B; t < Math.min((k + 1) * B, i + 1); t++) if (d.spyOk[t]) {
      const v = d.spy[t]; if (o == null) o = v; hi = Math.max(hi, v); lo = Math.min(lo, v); c = v;
    }
    if (o != null) bars.push({ k, o: o / 100, h: hi / 100, l: lo / 100, c: c / 100 });
  }
  if (!bars.length) return;
  let lo = Math.min(...bars.map((x) => x.l)), hi = Math.max(...bars.map((x) => x.h));
  const hd = held(i);
  if (hd && Math.abs(hd.be - price(d, i)) < 2 * Math.max(hi - lo, 0.15)) { lo = Math.min(lo, hd.be); hi = Math.max(hi, hd.be); }
  const y = yScale(lo, hi, top, bot, 0.15);
  const slot = (right - x0) / nb, X = (k) => x0 + (k - first + 0.5) * slot;
  axes(y, x0, right, top, bot, null);
  // time labels
  ctx.textAlign = "center"; ctx.textBaseline = "top"; ctx.fillStyle = C.muted;
  const every = Math.max(1, Math.ceil(90 / slot));
  for (const bar of bars) if (bar.k % every === 0) ctx.fillText(clock(bar.k * B, B < 60), X(bar.k), bot + 6);
  const cw = Math.max(1, slot * 0.68);
  for (const bar of bars) {
    const col = bar.c >= bar.o ? C.up : C.down, x = X(bar.k);
    ctx.strokeStyle = col; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, y(bar.h)); ctx.lineTo(Math.round(x) + 0.5, y(bar.l)); ctx.stroke();
    const yo = y(bar.o), yc = y(bar.c);
    ctx.fillStyle = col; ctx.fillRect(Math.round(x - cw / 2), Math.min(yo, yc), Math.round(cw), Math.max(1, Math.abs(yc - yo)));
  }
  // trades
  for (const t of S.acct.trades) if (t.day === d.id) for (const [ti, c] of [[t.i, t.side === "long" ? C.up : C.down], [t.out, C.muted]]) {
    const k = Math.floor(ti / B);
    if (k < first || k > cur) continue;
    ctx.fillStyle = c; ctx.beginPath(); ctx.arc(X(k), y(price(d, ti)), 3.5, 0, 7); ctx.fill();
  }
  const px = price(d, i), last = bars[bars.length - 1];
  const ly = Math.round(y(px)) + 0.5;
  ctx.setLineDash([3, 4]); ctx.strokeStyle = C.muted; ctx.beginPath(); ctx.moveTo(x0, ly); ctx.lineTo(right, ly); ctx.stroke(); ctx.setLineDash([]);
  if (hd) { // break-even, pinned to the edge when it's off the chart
    const by = Math.round(Math.min(bot, Math.max(top, y(hd.be)))) + 0.5;
    const off = by <= top + 0.5 ? " \u2191" : by >= bot + 0.5 ? " \u2193" : "";
    if (!off) { ctx.setLineDash([6, 6]); ctx.strokeStyle = C.amber; ctx.beginPath(); ctx.moveTo(x0, by); ctx.lineTo(right, by); ctx.stroke(); ctx.setLineDash([]); }
    tag(x0 + 4, by, `BREAK-EVEN ${hd.be.toFixed(2)}${off}`, C.amber);
  }
  tag(right + 4, ly, px.toFixed(2), last.c >= last.o ? C.up : C.down);

  // crosshair + OHLC of the hovered bar
  let shown = last;
  if (S.hover && S.hover.x >= x0 && S.hover.x <= right && S.hover.y >= top && S.hover.y <= bot) {
    const k = first + Math.floor((S.hover.x - x0) / slot);
    shown = bars.find((x) => x.k === k) || last;
    ctx.strokeStyle = "rgba(232,242,236,.25)";
    ctx.beginPath(); ctx.moveTo(X(k) + 0.5, top); ctx.lineTo(X(k) + 0.5, bot); ctx.moveTo(x0, S.hover.y + 0.5); ctx.lineTo(right, S.hover.y + 0.5); ctx.stroke();
    const v = y.lo + ((bot - S.hover.y) / (bot - top)) * (y.hi - y.lo);
    tag(right + 4, S.hover.y, v.toFixed(2), "#1F302D", C.text);
  }
  ctx.font = "11px 'JetBrains Mono', monospace"; ctx.textAlign = "right"; ctx.textBaseline = "top";
  ctx.fillStyle = C.muted;
  ctx.fillText(`${clock(shown.k * B)}  O ${shown.o.toFixed(2)}  H ${shown.h.toFixed(2)}  L ${shown.l.toFixed(2)}  C ${shown.c.toFixed(2)}`, right, 30);

  drawPremium(x0, right, h - 28 - pane, h - 28, p && p.day === d.id ? p : null);
}

// Lower pane in Pro: what CASH OUT pays since entry (fees included), against what you paid
function drawPremium(x0, x1, top, bot, p) {
  const d = S.day, i = idx();
  ctx.strokeStyle = C.line; ctx.beginPath(); ctx.moveTo(x0, top - 8.5); ctx.lineTo(x1 + 64, top - 8.5); ctx.stroke();
  if (!p) {
    ctx.font = "11px 'JetBrains Mono', monospace"; ctx.fillStyle = C.muted; ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.fillText("Cash-out value (fees included) shows here while you're in a trade", x0, top);
    return;
  }
  const a = p.i, b = Math.max(i, p.i + 1), W = x1 - x0;
  const vals = [];
  const step = Math.max(1, Math.floor((b - a) / W));
  for (let t = a; t <= i; t += step) vals.push([t, S.acct.mark(d, t).value]);
  vals.push([i, S.acct.mark(d, i).value]);
  const lo = Math.min(p.cost, ...vals.map((v) => v[1])), hi = Math.max(p.cost, ...vals.map((v) => v[1]));
  const y = yScale(lo, hi, top, bot, Math.max(1, p.cost * 0.04));
  const X = (t) => x0 + ((t - a) / (b - a)) * W;
  const ey = Math.round(y(p.cost)) + 0.5;
  ctx.setLineDash([6, 6]); ctx.strokeStyle = C.amber; ctx.beginPath(); ctx.moveTo(x0, ey); ctx.lineTo(x1, ey); ctx.stroke(); ctx.setLineDash([]);
  const cur = vals[vals.length - 1][1], col = cur >= p.cost ? C.up : C.down;
  ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.beginPath();
  vals.forEach(([t, v], j) => (j ? ctx.lineTo(X(t), y(v)) : ctx.moveTo(X(t), y(v))));
  ctx.stroke(); ctx.lineWidth = 1;
  ctx.font = "11px 'JetBrains Mono', monospace"; ctx.fillStyle = C.muted; ctx.textAlign = "left"; ctx.textBaseline = "top";
  ctx.fillText(`Cash out ${p.qty}x ${p.k}${p.r} · paid ${usd(p.cost)} incl. fees`, x0, top);
  tag(x1 + 4, y(cur), usd(cur), col);
}

init();
