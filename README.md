# Regulations.gov Comment Counts

Every docket on regulations.gov and how many public comments it got — 25.4M comments across 58,026
dockets and 179 agencies, 2003 to present. Filter by agency, year, docket type, title text, or a
minimum comment count; every chart, the stat cards and the CSV all follow the filters. Docket
IDs link to the docket on regulations.gov.

**Live:** https://regulations-comments.pages.dev

## What's here

```
web/
  index.html          the page
  app.js              all the logic, plain functions, no build step
  shared/shared.css   design system, shared with usajobs_historical
  data/dockets.json   the whole dataset — NOT in git, run build_data.py
build_data.py         regenerates data/dockets.json from spicy-regs
.github/workflows/    daily rebuild + deploy to Cloudflare Pages
```

`data/dockets.json` is gitignored: 8.7 MB changing daily would bloat the repo for nothing, and CI
rebuilds it on every deploy. **After cloning, run `python build_data.py` once** or the page loads
to an empty table.

No bundler, no framework. jQuery + DataTables + Chart.js + Bootstrap from CDN, one JSON file, all
filtering client-side. `python3 -m http.server` in `web/` is a full dev environment.

## Why a single JSON

139,640 docket-month rows is small. Shipping it whole and filtering in the browser is simpler and
faster than a query layer, and every filter is instant with no round trip.

The month index `ym` packs a date into one integer: `year = ym / 12 | 0`, `month = ym % 12 + 1`.
Per-month counts are what make the year filter exact — filtering to 2019 shows each docket's 2019
comments, not its lifetime total.

## Running it locally

```bash
pip install duckdb
python build_data.py
cd web && python3 -m http.server     # open localhost:8000
```

`build_data.py` reads `comments_index.parquet` (counts) and `dockets.parquet` (titles) from
[spicy-regs](https://r2.spicy-regs.dev) over HTTP range requests — no download, no API key.

## Deployment

`.github/workflows/update.yml` rebuilds the data and deploys to Cloudflare Pages daily at 09:17 UTC,
on any push touching `web/` or `build_data.py`, and on manual dispatch. It sanity-checks the rebuilt
JSON (file size, docket count, comment total) before deploying — a truncated build would otherwise
publish a broken site that still returns 200.

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

## Tests

```bash
pip install pytest pytest-playwright && python -m playwright install chromium
python build_data.py
cd web && python3 -m http.server 8899 &      # frontend tests need it served
python -m pytest tests/ -q                    # 33 tests
```

`tests/test_data.py` checks invariants on the rebuilt JSON — row totals equal the sum of their
monthly parts, months are sorted and unique, agency codes and names stay index-aligned, ranks are
1..N with no gaps and in comment order, nothing predates 2003, and the dataset isn't truncated.

`tests/test_frontend.py` drives a real browser: no console errors, all three charts populate, the
stat total agrees with the month chart, filters narrow every panel together, a year filter reports
that year's comments rather than lifetime totals, chips clear, docket IDs link out, chart labels
aren't clipped, and rank does not renumber under a filter.

CI runs both and **only deploys if they pass**, then re-checks that the live URL serves. A broken
build still returns HTTP 200, so a successful deploy proves nothing on its own.
