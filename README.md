# Regulations.gov Comment Counts

Every docket on regulations.gov and how many public comments it got — 25.7M comments across 59,594
dockets and 179 agencies, 1990 to present. Filter by agency, year, docket type, title text, or a
minimum comment count; the monthly chart, the stat cards and the CSV all follow the filters.

**Live:** https://regulations-comments.abigailhaddad.com

## What's here

```
web/
  index.html          the page
  app.js              all the logic, plain functions, no build step
  shared/shared.css   design system, shared with usajobs_historical
  data/dockets.json   8.7 MB (2.9 MB gzipped) — the whole dataset
build_data.py         regenerates data/dockets.json from spicy-regs
```

No bundler, no framework. jQuery + DataTables + Chart.js + Bootstrap from CDN, one JSON file, all
filtering client-side. `python3 -m http.server` in `web/` is a full dev environment.

## Why a single JSON

139,640 docket-month rows is small. Shipping it whole and filtering in the browser is simpler and
faster than a query layer, and every filter is instant with no round trip.

The month index `ym` packs a date into one integer: `year = ym / 12 | 0`, `month = ym % 12 + 1`.
Per-month counts are what make the year filter exact — filtering to 2019 shows each docket's 2019
comments, not its lifetime total.

## Regenerating the data

```bash
pip install duckdb
python build_data.py
```

Reads `comments_index.parquet` (counts) and `dockets.parquet` (titles) from
[spicy-regs](https://r2.spicy-regs.dev) over HTTP range requests — no download, no API key.

## Caveats that matter

- **Only posted comments are counted.** Every regulations.gov mirror is API-derived, so a backlog
  waiting to be posted is invisible. An agency sitting on one reads low here and nothing in the data
  says by how much. See [omb-comment-queue](https://github.com/abigailhaddad/omb-comment-queue).
- **Agencies that file elsewhere are absent.** The FCC runs its own system (ECFS), so its
  net-neutrality dockets — ~22M comments — are not in this data at all. "All agencies" means all
  agencies *on regulations.gov*.
- **Coverage ramps.** Records start in 1990, before regulations.gov existed (agencies backfilled),
  and the number of agencies present grows over time: 10 by 1991, 25 by 2005, 50 by 2007, 100 by
  2010. Only 5.6% of all comments predate the 100-agency mark.
- **46 impossible years dropped** (year 0, 1753, 1894…) — mis-keyed receive dates, 34,233 comments.

## Related

- [omb-historical-comment-counts](https://github.com/abigailhaddad/omb-historical-comment-counts) —
  the notebook this grew out of, which counts one agency straight from the Mirrulations S3 mirror.
- [omb-comment-queue](https://github.com/abigailhaddad/omb-comment-queue) — estimating the comments
  that *haven't* been posted.
