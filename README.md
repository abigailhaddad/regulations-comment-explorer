# Regulations.gov Comment Counts

Every docket on regulations.gov and how many public comments it got — 25.4M comments across 58,026
dockets and 179 agencies, 2003 to present. Filter by agency, year, docket type, title text, or a
minimum comment count; every chart, the stat cards and the CSV all follow the filters. Docket
IDs link to the docket on regulations.gov.

**Live:** https://regulations-comments.pages.dev

## What's here

```
web/
  index.html            the page
  app.js                all the logic, plain functions, no build step
  shared/shared.css     design system, shared with usajobs_historical
  data/dockets.v2.json  counts, months, agencies — blocks first paint
  data/titles.v2.json   docket titles — loads in the background
build_data.py           regenerates both from spicy-regs
.github/workflows/      daily rebuild + deploy to Cloudflare Pages
```

Both data files are gitignored: 8.7 MB changing daily would bloat the repo for nothing, and CI
rebuilds them on every deploy. **After cloning, run `python build_data.py` once** or the page loads
to an empty table.

No bundler, no framework. jQuery + DataTables + Chart.js + Bootstrap from CDN, all filtering
client-side. `python3 -m http.server` in `web/` is a full dev environment.

## Why the data is shaped this way

Everything ships to the browser and filters there. 131,226 docket-month rows is small, and that
beats a query layer with a round trip on every filter change.

Titles ship separately because they were 62% of the payload for a table that shows 25 at a time.
Splitting them took the blocking fetch from 2.6 MB to 0.8 MB — the old single file spent 1045 ms on
the wire against ~230 ms of parsing, filtering and drawing, so the fix was sending less, not faster
code. `dockets.v2.json` inlines the first 2000 titles so the opening screen needs no second fetch;
the rest stream in behind it. A title search and the CSV export await the full list rather than
quietly matching against the head.

`dockets` is ordered by comments desc, so a docket's **index** is its all-time rank (`index + 1`)
and its key into the titles array. Nothing may reorder it.

`ym` packs a date into one integer: `year = ym / 12 | 0`, `month = ym % 12 + 1`. Per-month counts
make the year filter exact — 2019 shows each docket's 2019 comments, not its lifetime total.

**The `v2` in the filenames is the row shape.** Bump it, the `schema` field, and `SCHEMA` in
`app.js` together whenever the shape changes. It's there because a shape change under the old
filename let cached browsers read new rows at old offsets and print a wrong total without erroring.

`__perf()` in the console dumps phase timings, left in production so "it felt slow" is diagnosable.

## Running it

```bash
pip install duckdb
python build_data.py
cd web && python3 -m http.server     # open localhost:8000
```

`build_data.py` reads `comments_index.parquet` (counts) and `dockets.parquet` (titles) from
[spicy-regs](https://r2.spicy-regs.dev) over HTTP range requests — no download, no API key.

Tests need a served copy and a browser:

```bash
pip install pytest pytest-playwright && python -m playwright install chromium
cd web && python3 -m http.server 8899 &
python -m pytest tests/ -q
```

`test_data.py` covers invariants on the rebuilt JSON; `test_frontend.py` drives a real browser.
CI runs both and **only deploys if they pass**, then re-checks that the live URL serves — a broken
build still returns HTTP 200, so a successful deploy proves nothing on its own.

## Deployment

`.github/workflows/update.yml` rebuilds and deploys to Cloudflare Pages daily at 09:17 UTC, on any
push touching `web/` or `build_data.py`, and on manual dispatch.

Needs two repo secrets: `CLOUDFLARE_API_TOKEN` (account-scoped, Cloudflare Pages: Edit) and
`CLOUDFLARE_ACCOUNT_ID`.

## Caveats that matter

- **Only posted comments are counted.** Every regulations.gov mirror is API-derived, so a backlog
  waiting to be posted is invisible. An agency sitting on one reads low here and nothing in the data
  says by how much. See [omb-comment-queue](https://github.com/abigailhaddad/omb-comment-queue).
- **Agencies that file elsewhere are absent.** The FCC runs its own system (ECFS), so its
  net-neutrality dockets — ~22M comments — are not in this data at all. "All agencies" means all
  agencies *on regulations.gov*.
- **Pre-2003 is excluded on purpose.** Regulations.gov launched in 2003. The source data goes back
  to 1990, but that era is 9–16 agencies out of 179 and ~1% of comments — DOT's modes (FMCSA, FAA,
  NHTSA, FHWA, PHMSA, USCG, FRA, MARAD, FTA) plus OSHA and EPA, migrating their own legacy docket
  systems. Nothing else from those years is in regulations.gov at all, so showing them invites
  reading a partial sample as a census. Set `FIRST_YEAR` in `build_data.py` to get them back.
- **Coverage still ramps after 2003:** 25 agencies by 2005, 50 by 2007, 100 by 2010. Early years are
  thinner than they look.
- **Impossible receive dates dropped** (year 0, 1753, 1894…) — mis-keyed, not history.
- **Agency names** come from `agency_names.json`, a committed snapshot of regulations.gov's
  `/v4/agencies`, so the daily build needs no API key. Refresh with `refresh_agency_names.py`.
  Two codes (`ERULE`, `TRAIN`) have no published name and fall back to the code.

## Related

- [omb-historical-comment-counts](https://github.com/abigailhaddad/omb-historical-comment-counts) —
  the notebook this grew out of, which counts one agency straight from the Mirrulations S3 mirror.
- [omb-comment-queue](https://github.com/abigailhaddad/omb-comment-queue) — estimating the comments
  that *haven't* been posted.
