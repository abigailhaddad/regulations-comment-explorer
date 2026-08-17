"""Regenerate web/data/dockets.json from the spicy-regs mirror.

Reads two parquet files over HTTP range requests (no download, no API key):
  comments_index.parquet  agency_code, docket_id, year, month, row_count
  dockets.parquet         docket_id, title, docket_type, ...

Output is one row per docket carrying its per-month counts, which is what lets
the site filter by year exactly rather than by a first/last-year range.

Agency display names come from agency_names.json, a committed snapshot of
regulations.gov's /v4/agencies. Keeping it in the repo means the daily rebuild
needs no API key; refresh it with refresh_agency_names.py when agencies change.
"""

import gzip
import json
import os
from datetime import date

import duckdb

SPICY = "https://r2.spicy-regs.dev"
OUT = "web/data/dockets.json"
TYPES = ["Rulemaking", "Nonrulemaking"]

# Regulations.gov launched in 2003. Records exist back to 1990, but they are a
# handful of agencies (mostly DOT's modes, plus OSHA and EPA) who migrated their
# own legacy docket systems -- 9-16 agencies of 179 and ~1% of comments. Showing
# them next to the modern data invites reading a partial sample as a census, so
# the site starts where regulations.gov does.
FIRST_YEAR, LAST_YEAR = 2003, 2030


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

    with open("agency_names.json") as f:
        known = json.load(f)
    # Codes with no published name (test/training accounts) fall back to the code
    # itself, so the chart tooltip always says something.
    agency_names = [known.get(a, a) for a in agencies]
    unnamed = [a for a in agencies if a not in known]

    data = {
        "generated": date.today().isoformat(),
        "agencies": agencies,
        "agencyNames": agency_names,
        "types": TYPES,
        # [id, agencyIdx, title, typeIdx, total, [ym...], [comments...], rank]
        #
        # `rank` is the docket's position by lifetime comments across the whole
        # dataset, assigned here rather than in the browser so that filtering
        # never renumbers it -- "#3 of all time" has to keep meaning that when
        # you narrow to one agency. It moves only when the data is rebuilt.
        # The query orders by total DESC, so position is the rank.
        "dockets": [
            [
                r[0],
                agency_index[r[1]],
                r[2] or "",
                TYPES.index(r[3]) if r[3] in TYPES else -1,
                int(r[4]),
                list(r[5]),
                [int(x) for x in r[6]],
                i + 1,
            ]
            for i, r in enumerate(rows)
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
          f"{months:,} docket-months · {total:,} comments "
          f"({FIRST_YEAR}-present)")
    if unnamed:
        print(f"no published name for {len(unnamed)}: {', '.join(unnamed)}")
    print(f"{OUT}: {raw / 1e6:.1f} MB raw, {gz / 1e6:.2f} MB gzipped")


if __name__ == "__main__":
    main()
