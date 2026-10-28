#!/usr/bin/env python3
"""Turn one zdte-bot replay day (data/replay/YYYY-MM-DD.sqlite) into a QuillJay Play data file.

    python3 tools/export_day.py ~/zdte-bot/data/replay/2026-10-27.sqlite

writes play/days/2026-10-27.json and adds the day to play/days/index.json. Reads the sqlite read-only
(the bot may be writing today's file); standard library only.

Input: the recorder's table q(ts unix seconds, symbol, bid, ask, last, mark), one row per symbol whenever its
quote changed, 09:30-16:00 New York. Option symbols are Schwab's ("SPY   261027C00580000").

Output (v1), one slot per second from 09:30:00 (n = 23400):
    {"v": 1, "id", "date", "und", "t0": unix 09:30, "n", "synthetic",
     "spy":  {"i0": 0, "len": n, "d": packed mark in cents, "g": [[a, b), ...]},
     "opts": [{"r": "C"|"P", "k": strike, "i0", "len", "b": packed bid cents, "s": packed ask - bid cents, "g"}]}
A series covers seconds [i0, i0 + len). "Packed" = the per-second values as comma-separated deltas from the
previous second, a run of k unchanged seconds written "~k" (see pack(); play/engine.js unpack() reads it).
Quotes are carried forward (the recorder writes only changes). "g" lists the seconds (absolute) with no usable
quote: the recorder was down (no row from any symbol for STALE_S) or the strike was outside its band.
"""

from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from datetime import date, datetime, time
from pathlib import Path
from zoneinfo import ZoneInfo

NY = ZoneInfo("America/New_York")
DAY_S = 6 * 3600 + 30 * 60  # 09:30-16:00
STALE_S = 10  # no row from any symbol for this long = the recorder wasn't running
SITE = Path(__file__).resolve().parent.parent
OPT_RE = re.compile(r"^(\w+)\s+(\d{6})([CP])(\d{8})$")


def gaps(ok: list[bool]) -> list[list[int]]:
    """[a, b) runs where ok is False."""
    out, start = [], None
    for i, good in enumerate(ok):
        if not good and start is None:
            start = i
        elif good and start is not None:
            out.append([start, i])
            start = None
    if start is not None:
        out.append([start, len(ok)])
    return out


def pack(vals: list[int]) -> str:
    out, prev, zeros = [], 0, 0
    for v in vals:
        d = v - prev
        prev = v
        if d == 0:
            zeros += 1
            continue
        if zeros:
            out.append("0" if zeros == 1 else f"~{zeros}")
            zeros = 0
        out.append(str(d))
    if zeros:
        out.append("0" if zeros == 1 else f"~{zeros}")
    return ",".join(out)


def cents(x) -> int | None:
    return None if x is None else round(x * 100)


def export(db_path: Path, day: date, und: str = "SPY", band: int = 8, synthetic: bool = False,
           day_id: str | None = None) -> dict:
    t0 = datetime.combine(day, time(9, 30), NY).timestamp()
    n = DAY_S
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    rows = con.execute("SELECT ts, symbol, bid, ask, last, mark FROM q WHERE ts >= ? AND ts < ? ORDER BY ts",
                       (t0, t0 + n)).fetchall()
    con.close()

    seen = [False] * n  # a row from any symbol in this second
    spy_ev: list[tuple[int, int]] = []
    opt_ev: dict[tuple[str, float], list[tuple[int, int | None, int | None]]] = {}
    expiry = f"{day:%y%m%d}"
    for ts, sym, bid, ask, last, mark in rows:
        i = int(ts - t0)
        seen[i] = True
        if sym == und:
            px = mark if mark else last if last else (bid + ask) / 2 if bid and ask else None
            if px:
                spy_ev.append((i, cents(px)))
            continue
        m = OPT_RE.match(sym)
        if not m or m.group(1) != und or m.group(2) != expiry:  # only this day's 0DTE contracts
            continue
        k = int(m.group(4)) / 1000
        opt_ev.setdefault((m.group(3), k), []).append((i, cents(bid), cents(ask)))

    live, last_seen = [False] * n, -10**9
    for i in range(n):
        if seen[i]:
            last_seen = i
        live[i] = i - last_seen < STALE_S

    spy, spy_ok, v, j = [0] * n, [False] * n, None, 0
    for i in range(n):
        while j < len(spy_ev) and spy_ev[j][0] <= i:
            v = spy_ev[j][1]
            j += 1
        if v is not None:
            spy[i] = v
            spy_ok[i] = live[i]
    if not any(spy_ok):
        raise SystemExit(f"{db_path}: no {und} quotes between 09:30 and 16:00 on {day}")
    first = next(i for i in range(n) if spy_ok[i])
    spy[:first] = [spy[first]] * first  # so the line doesn't start at 0

    opts = []
    for (right, k), ev in sorted(opt_ev.items()):
        bid, spr, ok = [0] * n, [0] * n, [False] * n
        b = a = None
        j = 0
        kc = round(k * 100)
        for i in range(n):
            while j < len(ev) and ev[j][0] <= i:
                _, b, a = ev[j]
                j += 1
            if b is not None and a is not None:
                bid[i], spr[i] = b, a - b
            in_band = abs(kc - round(spy[i] / 100) * 100) <= band * 100
            ok[i] = live[i] and spy_ok[i] and in_band and b is not None and a is not None and a > 0 and a >= b
        if not any(ok):
            continue
        i0 = ok.index(True)
        i1 = n - ok[::-1].index(True)
        g = [[a + i0, b + i0] for a, b in gaps(ok[i0:i1])]
        opts.append({"r": right, "k": k, "i0": i0, "len": i1 - i0, "b": pack(bid[i0:i1]), "s": pack(spr[i0:i1]),
                     "g": g})

    return {"v": 1, "id": day_id or str(day), "date": str(day), "und": und, "t0": int(t0), "n": n,
            "synthetic": synthetic, "spy": {"i0": 0, "len": n, "d": pack(spy), "g": gaps(spy_ok)}, "opts": opts}


def unpack(s: str, n: int) -> list[int]:
    out, v = [], 0
    for tok in s.split(",") if s else []:
        if tok[0] == "~":
            out += [v] * int(tok[1:])
        else:
            v += int(tok)
            out.append(v)
    assert len(out) == n, (len(out), n)
    return out


def summary(data: dict, file: str, note: str = "") -> dict:
    vals = unpack(data["spy"]["d"], data["n"])
    ok = [True] * data["n"]
    for a, b in data["spy"]["g"]:
        ok[a:b] = [False] * (b - a)
    good = [x for x, g in zip(vals, ok) if g]
    return {"id": data["id"], "date": data["date"], "und": data["und"], "file": file, "synthetic": data["synthetic"],
            "open": good[0] / 100, "close": good[-1] / 100, "high": max(good) / 100, "low": min(good) / 100,
            "note": note}


def write(data: dict, days_dir: Path, note: str = "") -> Path:
    days_dir.mkdir(parents=True, exist_ok=True)
    file = f"{data['id']}.json"
    out = days_dir / file
    out.write_text(json.dumps(data, separators=(",", ":")))
    idx_path = days_dir / "index.json"
    idx = json.loads(idx_path.read_text()) if idx_path.exists() else {"days": []}
    idx["days"] = [d for d in idx["days"] if d["id"] != data["id"]] + [summary(data, file, note)]
    real = [d for d in idx["days"] if not d["synthetic"]]
    idx["days"] = sorted(real, key=lambda d: d["date"], reverse=True) + [d for d in idx["days"] if d["synthetic"]]
    idx_path.write_text(json.dumps(idx, indent=1) + "\n")
    return out


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("sqlite", type=Path, nargs="+", help="data/replay/YYYY-MM-DD.sqlite (one or more)")
    p.add_argument("--und", default="SPY")
    p.add_argument("--band", type=int, default=8, help="strikes each side the recorder keeps (zdte: 8)")
    p.add_argument("--out", type=Path, default=SITE / "play" / "days", help="days folder (default: play/days)")
    p.add_argument("--note", default="")
    a = p.parse_args(argv)
    for path in a.sqlite:
        m = re.search(r"(\d{4}-\d{2}-\d{2})", path.name)
        if not m:
            sys.exit(f"{path}: name must contain the date (YYYY-MM-DD)")
        data = export(path, date.fromisoformat(m.group(1)), a.und, a.band)
        out = write(data, a.out, a.note)
        print(f"{out}  {out.stat().st_size / 1e6:.1f} MB, {len(data['opts'])} contracts")


if __name__ == "__main__":
    main()
