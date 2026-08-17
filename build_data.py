"""Regenerate web/data/dockets.json from the spicy-regs mirror.

Reads two parquet files over HTTP range requests (no download, no API key):
  comments_index.parquet  agency_code, docket_id, year, month, row_count
  dockets.parquet         docket_id, title, docket_type, ...

Output is one row per docket carrying its per-month counts, which is what lets
the site filter by year exactly rather than by a first/last-year range.
"""

import gzip
import json
import os
from datetime import date

import duckdb

SPICY = "https://r2.spicy-regs.dev"
OUT = "web/data/dockets.json"
TYPES = ["Rulemaking", "Nonrulemaking"]

# Receive dates are occasionally mis-keyed (year 0, 1753, 1894). Those are data
# entry, not history, and they wreck any axis they touch.
FIRST_YEAR, LAST_YEAR = 1990, 2030


def main():
    rows = duckdb.sql(f"""
        WITH m AS (
          SELECT docket_id, agency_code,
                 year * 12 + (month - 1) AS ym,
                 sum(row_count)::BIGINT AS c
          FROM read_parquet('{SPICY}/comments_index.parquet')
          WHERE year BETWEEN {FIRST_YEAR} AND {LAST_YEAR}
          GROUP BY 1, 2, 3
        )
        SELECT m.docket_id, m.agency_code,
               any_value(d.title) AS title,
               any_value(d.docket_type) AS docket_type,
               sum(m.c)::BIGINT AS total,
               list(m.ym ORDER BY m.ym) AS yms,
               list(m.c ORDER BY m.ym) AS counts
        FROM m
        LEFT JOIN read_parquet('{SPICY}/dockets.parquet') d USING (docket_id)
        GROUP BY 1, 2
        ORDER BY 5 DESC
    """).fetchall()

    agencies = sorted({r[1] for r in rows})
    agency_index = {a: i for i, a in enumerate(agencies)}

    data = {
        "generated": date.today().isoformat(),
        "agencies": agencies,
        "types": TYPES,
        # [id, agencyIdx, title, typeIdx, total, [ym...], [comments...]]
        "dockets": [
            [
                r[0],
                agency_index[r[1]],
                r[2] or "",
                TYPES.index(r[3]) if r[3] in TYPES else -1,
                int(r[4]),
                list(r[5]),
                [int(x) for x in r[6]],
            ]
            for r in rows
        ],
    }

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(data, f, separators=(",", ":"), ensure_ascii=False)

    raw = os.path.getsize(OUT)
    gz = len(gzip.compress(open(OUT, "rb").read(), 6))
    months = sum(len(d[5]) for d in data["dockets"])
    total = sum(d[4] for d in data["dockets"])
    print(f"{len(data['dockets']):,} dockets · {len(agencies)} agencies · "
          f"{months:,} docket-months · {total:,} comments")
    print(f"{OUT}: {raw / 1e6:.1f} MB raw, {gz / 1e6:.2f} MB gzipped")


if __name__ == "__main__":
    main()
