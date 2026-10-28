"""python3 -m unittest discover -s tools  (standard library only)"""

import json
import sqlite3
import tempfile
import unittest
from datetime import date, datetime, time
from pathlib import Path

import export_day as ex

DAY = date(2026, 10, 27)
T0 = datetime.combine(DAY, time(9, 30), ex.NY).timestamp()
C580 = "SPY   261027C00580000"
P580 = "SPY   261027P00580000"


def make_db(path: Path, rows) -> None:
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE q (ts REAL NOT NULL, symbol TEXT NOT NULL, bid REAL, ask REAL, last REAL, mark REAL)")
    con.executemany("INSERT INTO q VALUES (?,?,?,?,?,?)", [(T0 + t, *r) for t, *r in rows])
    con.commit()
    con.close()


def heartbeat(start: int, end: int):  # a row every second (the recorder sees some change every tick)
    return [(t + 0.2, "QQQ", 500.0, 500.02, 500.01, 500.01) for t in range(start, end)]


class PackTest(unittest.TestCase):
    def test_roundtrip(self):
        vals = [57845, 57845, 57845, 57850, 57849, 57849, 0, 0, 0, 0]
        self.assertEqual(ex.unpack(ex.pack(vals), len(vals)), vals)
        self.assertEqual(ex.pack([5, 5, 5, 6]), "5,~2,1")
        self.assertEqual(ex.pack([0, 0]), "~2")


class ExportTest(unittest.TestCase):
    def run_export(self, rows, **kw):
        with tempfile.TemporaryDirectory() as tmp:
            db = Path(tmp) / f"{DAY}.sqlite"
            make_db(db, rows)
            return ex.export(db, DAY, **kw)

    def series(self, data, r, k):
        o = next(o for o in data["opts"] if o["r"] == r and o["k"] == k)
        ok = [False] * data["n"]
        ok[o["i0"]:o["i0"] + o["len"]] = [True] * o["len"]
        for a, b in o["g"]:
            ok[a:b] = [False] * (b - a)
        bid = ex.unpack(o["b"], o["len"])
        spr = ex.unpack(o["s"], o["len"])
        return o, ok, bid, spr

    def test_carries_quotes_forward_and_marks_outage(self):
        rows = heartbeat(0, 100) + heartbeat(200, 300) + [
            (0.5, "SPY", 579.99, 580.01, 580.0, 580.0),
            (10.5, C580, 1.20, 1.22, None, 1.21),
            (50.5, C580, 1.30, 1.31, None, 1.305),
        ]
        d = self.run_export(rows)
        o, ok, bid, spr = self.series(d, "C", 580.0)
        self.assertEqual(o["i0"], 10)
        at = lambda i: (bid[i - o["i0"]], bid[i - o["i0"]] + spr[i - o["i0"]])
        self.assertEqual(at(10), (120, 122))
        self.assertEqual(at(49), (120, 122))  # carried forward
        self.assertEqual(at(50), (130, 131))
        self.assertTrue(ok[99])
        self.assertTrue(ok[108])  # inside STALE_S of the last row
        self.assertFalse(ok[109])  # recorder down: no row for STALE_S
        self.assertFalse(ok[150])
        self.assertTrue(ok[200])  # back: last quote still holds (only changes are written)
        spy = ex.unpack(d["spy"]["d"], d["n"])
        self.assertEqual(spy[0], 58000)
        self.assertEqual(d["spy"]["g"][0], [109, 200])

    def test_only_todays_contracts_and_band(self):
        rows = heartbeat(0, 60) + [
            (0.5, "SPY", 579.99, 580.01, 580.0, 580.0),
            (30.5, "SPY", 589.99, 590.01, 590.0, 590.0),
            (1.5, C580, 1.20, 1.22, None, 1.21),
            (1.5, "SPY   261028C00580000", 2.0, 2.02, None, 2.01),  # tomorrow's: not 0DTE
            (1.5, "QQQ   261027C00500000", 1.0, 1.02, None, 1.01),
        ]
        d = self.run_export(rows)
        self.assertEqual([(o["r"], o["k"]) for o in d["opts"]], [("C", 580.0)])
        o, ok, _, _ = self.series(d, "C", 580.0)
        self.assertTrue(ok[29])
        self.assertFalse(ok[30])  # SPY at 590: 580 is 10 strikes away, the recorder (band 8) stopped asking

    def test_zero_bid_and_missing_quote(self):
        rows = heartbeat(0, 30) + [
            (0.5, "SPY", 579.99, 580.01, 580.0, 580.0),
            (1.5, P580, 0.0, 0.01, None, 0.005),
            (5.5, P580, None, None, None, None),
        ]
        d = self.run_export(rows)
        o, ok, bid, spr = self.series(d, "P", 580.0)
        self.assertTrue(ok[1])
        self.assertEqual((bid[0], spr[0]), (0, 1))
        self.assertFalse(ok[5])

    def test_write_index_newest_first_samples_last(self):
        rows = heartbeat(0, 10) + [(0.5, "SPY", 579.99, 580.01, 580.0, 580.0)]
        d = self.run_export(rows)
        s = self.run_export(rows, synthetic=True, day_id="sample-1")
        old = dict(d, id="2026-10-20", date="2026-10-20")
        with tempfile.TemporaryDirectory() as tmp:
            for x in (s, old, d, d):
                ex.write(x, Path(tmp))
            idx = json.loads((Path(tmp) / "index.json").read_text())
        self.assertEqual([x["id"] for x in idx["days"]], ["2026-10-27", "2026-10-20", "sample-1"])
        self.assertEqual(idx["days"][0]["open"], 580.0)


if __name__ == "__main__":
    unittest.main()
