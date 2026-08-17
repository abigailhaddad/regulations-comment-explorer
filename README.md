# Regulations.gov Comment Counts

Every docket on regulations.gov and how many public comments got posted, 2003 to present. Filter by
agency, year, docket type, title text, or a minimum comment count; every chart, the stat cards and
the CSV all follow the filters. Docket IDs link to the docket on regulations.gov.

**Live:** https://regulations-comments.pages.dev

## Where the data comes from

Counts come from the [spicy-regs](https://r2.spicy-regs.dev) mirror of the regulations.gov API,
cross-checked against [Mirrulations](https://github.com/MoravianUniversity/mirrulations). Two
parquet files: `comments_index.parquet`, one row per docket per month with a count, and
`dockets.parquet` for titles and types. `build_data.py` joins them and writes what the site loads;
CI reruns it daily, so the site tracks the mirror within a day.

Counting per docket per month is what makes the year filter exact — filtering to 2019 shows each
docket's 2019 comments, not the lifetime total of every docket that was active in 2019.

Agency display names come from a committed snapshot of regulations.gov's `/v4/agencies`.

## What the numbers don't include

- Only posted comments are counted. Every regulations.gov mirror is API-derived, so a backlog
  waiting to be posted is invisible — an agency sitting on one reads low, and nothing in the data
  says by how much.
- Agencies that file elsewhere are missing. The FCC runs its own system (ECFS), so its
  net-neutrality dockets — ~22M comments — aren't here at all.
- Pre-2003 is excluded. Regulations.gov launched in 2003; the source goes back to 1990, but that era
  is 9–16 agencies out of 179 and ~1% of comments, mostly DOT's modes plus OSHA and EPA migrating
  legacy systems. Set `FIRST_YEAR` in `build_data.py` to include them.
- Coverage keeps ramping after that: 25 agencies by 2005, 50 by 2007, 100 by 2010.
- Impossible receive dates (year 0, 1753, 1894…) are dropped as mis-keyed.
- `ERULE` and `TRAIN` have no published agency name and fall back to the code.

## Running it

```bash
pip install duckdb
python build_data.py            # reads the parquet over HTTP range requests; no API key
cd web && python3 -m http.server
```

The data files are gitignored — ~8.7 MB that changes daily — so run `build_data.py` once after
cloning or the page loads to an empty table. No bundler and no framework: jQuery, DataTables,
Chart.js and Bootstrap from CDN, everything filtered client-side.

Tests need it served, and a browser:

```bash
pip install pytest pytest-playwright && python -m playwright install chromium
cd web && python3 -m http.server 8899 &
python -m pytest tests/ -q
```

CI runs both suites daily and on any push touching `web/` or `build_data.py`, and only deploys to
Cloudflare Pages if they pass — a broken build still returns HTTP 200, so a green deploy proves
nothing on its own. Notes on the data layout and why it's split the way it is are in `app.js` and
`build_data.py`.

## Related

- [omb-historical-comment-counts](https://github.com/abigailhaddad/omb-historical-comment-counts) —
  the notebook this grew out of, which counts one agency straight from the Mirrulations S3 mirror.
