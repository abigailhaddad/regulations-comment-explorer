"""Regenerate web/data/dockets.json and web/data/titles.json from spicy-regs.

Reads two parquet files over HTTP range requests (no download, no API key):
  comments_index.parquet  agency_code, docket_id, year, month, row_count
  dockets.parquet         docket_id, title, docket_type, ...

Output is one row per docket carrying its per-month counts, which is what lets
the site filter by year exactly rather than by a first/last-year range.

Titles ship SEPARATELY, in titles.json, because they were 62% of a single-file
payload (5.4 MB of 8.7 MB raw; 1.0 MB of 1.7 MB brotli) while the page shows 25
of them at a time. Splitting them out is what takes the blocking first fetch
from ~2.6 MB to ~0.5 MB. Measured before the split: 1045 ms on a wired
connection just to download, against ~230 ms for all the JSON parsing, filtering
and drawing combined -- the wait was the wire, not the work.

The first HEAD_TITLES titles ride along in the core file as `titlesHead`, so the
opening screen (sorted by comments desc, 25 rows) is complete on first paint
instead of showing a column of placeholders. titles.json then carries ALL of
them, aligned by docket index; the ~0.2 MB of overlap is duplicated rather than
offset-indexed because it costs ~40 KB compressed on a fetch that blocks nothing
and it keeps both sides indexing the same way.

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

# The row shape is IN the filename, and SCHEMA goes in the payload. Both exist
# because of a real outage: splitting titles out changed `dockets` from 8 fields
# to 6 while the file kept its name, so browsers holding a cached app.js read the
# new rows with the old offsets. d[4] went from "total comments" to "the months
# array", and the page headline rendered `0 + [24208,24209,...]` -- a mile of
# concatenated month indices where a comment count belonged. It never errored;
# it just published a wrong number.
#
# Renaming on every shape change is what makes that impossible: a stale app.js
# asks for a URL that no longer exists and fails loudly instead of misreading
# live data. Bump BOTH when the row shape changes.
SCHEMA = 2
OUT = f"web/data/dockets.v{SCHEMA}.json"
TITLES_OUT = f"web/data/titles.v{SCHEMA}.json"
TYPES = ["Rulemaking", "Nonrulemaking"]

# Titles inlined into the core file. 2000 covers the default first page many
# times over, so scrolling or sorting within the top of the table never waits.
HEAD_TITLES = 2000

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

    # The query orders by total DESC, so a docket's position in this list IS its
    # all-time rank. It used to be written into every row as an eighth field;
    # that spent 0.34 MB restating the array order, and the front end now derives
    # it as index + 1. Nothing else may reorder `dockets` -- rank, the top-dockets
    # chart and titles.json alignment all read position as meaning.
    titles = [r[2] or "" for r in rows]

    data = {
        "schema": SCHEMA,
        "generated": date.today().isoformat(),
        "agencies": agencies,
        "agencyNames": agency_names,
        "types": TYPES,
        # Titles for the head of the list, so the opening screen needs no second
        # fetch. The rest arrive in titles.json.
        "titlesHead": titles[:HEAD_TITLES],
        # [id, agencyIdx, typeIdx, total, [ym...], [comments...]]
        # Rank is index + 1; the title is titles[index].
        "dockets": [
            [
                r[0],
                agency_index[r[1]],
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
    with open(TITLES_OUT, "w") as f:
        json.dump(titles, f, separators=(",", ":"), ensure_ascii=False)

    def sizes(path):
        raw = os.path.getsize(path)
        gz = len(gzip.compress(open(path, "rb").read(), 6))
        return raw, gz

    months = sum(len(d[4]) for d in data["dockets"])
    total = sum(d[3] for d in data["dockets"])
    print(f"{len(data['dockets']):,} dockets · {len(agencies)} agencies · "
          f"{months:,} docket-months · {total:,} comments "
          f"({FIRST_YEAR}-present)")
    if unnamed:
        print(f"no published name for {len(unnamed)}: {', '.join(unnamed)}")
    for path in (OUT, TITLES_OUT):
        raw, gz = sizes(path)
        blocking = " (blocks first paint)" if path == OUT else " (background)"
        print(f"{path}: {raw / 1e6:.1f} MB raw, {gz / 1e6:.2f} MB gzipped{blocking}")


if __name__ == "__main__":
    main()
