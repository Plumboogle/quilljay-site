#!/usr/bin/env python3
"""Make a SYNTHETIC practice day (play/days/sample-1.json) so the page works without recorded data.

Simulates what the zdte-bot recorder writes (SPY plus the 0DTE calls and puts within 8 strikes, one row per
change, a short recorder outage at 12:40) and runs it through export_day.py like a real day. The page labels
it "synthetic": the prices are made up (random walk, Black-Scholes premiums), not market data.
"""

from __future__ import annotations

import argparse
import math
import random
import sqlite3
import tempfile
from datetime import date, datetime, time
from pathlib import Path

import export_day as ex

SCHEMA = "CREATE TABLE q (ts REAL NOT NULL, symbol TEXT NOT NULL, bid REAL, ask REAL, last REAL, mark REAL)"
YEAR_S = 252 * ex.DAY_S  # trading seconds a year


def ncdf(x: float) -> float:
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def bs(s: float, k: float, t: float, iv: float, right: str) -> float:
    if t <= 0:
        return max(0.0, s - k) if right == "C" else max(0.0, k - s)
    sd = iv * math.sqrt(t)
    d1 = (math.log(s / k) + sd * sd / 2) / sd
    call = s * ncdf(d1) - k * ncdf(d1 - sd)
    return call if right == "C" else call - s + k


def symbol(day: date, right: str, k: float) -> str:  # zdte.broker.schwab_symbol
    return f"{'SPY':<6}{day:%y%m%d}{right}{round(k * 1000):08d}"


def simulate(path: Path, day: date, seed: int, s0: float = 578.40) -> None:
    rnd = random.Random(seed)
    t0 = datetime.combine(day, time(9, 30), ex.NY).timestamp()
    con = sqlite3.connect(path)
    con.execute(SCHEMA)
    s, last, rows = s0, {}, []
    drift = 0.0
    for i in range(ex.DAY_S):
        if 11_400 <= i < 11_490:  # 12:40:00-12:41:30: the recorder was down
            continue
        hour = i / 3600
        vol = 0.13 * (1.9 if hour < 0.5 else 1.0) * (1.7 if 4.4 < hour < 4.7 else 1.0) * (1.4 if hour > 6.2 else 1.0)
        if rnd.random() < 1 / 1800:  # a new short trend now and then
            drift = rnd.gauss(0, 0.004) / 3600  # +-0.4% an hour
        s *= math.exp(rnd.gauss(drift, vol / math.sqrt(YEAR_S)))
        mark = round(s, 2)
        quotes = {"SPY": (round(mark - 0.01, 2), round(mark + 0.01, 2), mark, mark)}
        t_left = max(ex.DAY_S - i, 1) / YEAR_S
        atm = round(mark)
        for k in range(atm - 8, atm + 9):
            for right in "CP":
                iv = 0.14 + 0.9 * ((k - mark) / mark) ** 2 * 100 + (0.03 if right == "P" and k < mark else 0)
                mid = bs(mark, k, t_left, iv, right)
                spread = 0.01 if mid < 1.5 else 0.02 if mid < 5 else 0.03
                if rnd.random() < 0.02:
                    spread += 0.01
                bid = max(0.0, math.floor((mid - spread / 2) * 100) / 100)
                ask = round(bid + spread, 2) if bid > 0 else 0.01
                quotes[symbol(day, right, k)] = (bid, ask, None, round((bid + ask) / 2, 3))
        ts = t0 + i + 0.31
        for sym, q in quotes.items():
            if last.get(sym) != q:
                last[sym] = q
                rows.append((ts, sym, *q))
        if len(rows) > 50_000:
            con.executemany("INSERT INTO q VALUES (?,?,?,?,?,?)", rows)
            rows = []
    con.executemany("INSERT INTO q VALUES (?,?,?,?,?,?)", rows)
    con.commit()
    con.close()


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--seed", type=int, default=7)
    p.add_argument("--id", default="sample-1")
    p.add_argument("--out", type=Path, default=ex.SITE / "play" / "days")
    a = p.parse_args()
    day = date(2026, 10, 27)
    with tempfile.TemporaryDirectory() as tmp:
        db = Path(tmp) / f"{day}.sqlite"
        simulate(db, day, a.seed)
        data = ex.export(db, day, synthetic=True, day_id=a.id)
    out = ex.write(data, a.out, note="Synthetic practice day: made-up prices, not market data")
    print(f"{out}  {out.stat().st_size / 1e6:.1f} MB, {len(data['opts'])} contracts")


if __name__ == "__main__":
    main()
