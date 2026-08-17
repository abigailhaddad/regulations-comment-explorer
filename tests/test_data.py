"""Invariants on web/data/dockets.json.

These run before the site is deployed. The failure they exist to catch is a
build that *looks* fine — valid JSON, page still returns 200 — but is silently
truncated, misaligned, or double-counted. Every one of these has a specific way
the front end breaks if it's violated.

    python -m pytest tests/test_data.py -v
"""

import json
import os

import pytest

SCHEMA = 2
DATA_PATH = os.path.join(
    os.path.dirname(__file__), "..", "web", "data", f"dockets.v{SCHEMA}.json")
TITLES_PATH = os.path.join(
    os.path.dirname(__file__), "..", "web", "data", f"titles.v{SCHEMA}.json")

# The site starts where regulations.gov does; build_data.py enforces this and
# the header copy states it, so a stray earlier year means they disagree.
FIRST_YEAR = 2003


# Field positions inside a docket row, mirroring the names in app.js.
ID, AGENCY, TYPE, TOTAL, YMS, COUNTS = 0, 1, 2, 3, 4, 5


@pytest.fixture(scope="module")
def data():
    if not os.path.exists(DATA_PATH):
        pytest.fail(f"{DATA_PATH} missing — run `python build_data.py` first")
    with open(DATA_PATH) as f:
        return json.load(f)


@pytest.fixture(scope="module")
def titles():
    if not os.path.exists(TITLES_PATH):
        pytest.fail(f"{TITLES_PATH} missing — run `python build_data.py` first")
    with open(TITLES_PATH) as f:
        return json.load(f)


def test_top_level_keys(data):
    for key in ("agencies", "agencyNames", "types", "dockets", "generated",
                "titlesHead", "schema"):
        assert key in data, f"missing top-level key: {key}"


def test_schema_matches_the_filename_and_app_js(data):
    # These three have to move together. When they did not, browsers with a
    # cached app.js read the new rows at the old offsets and the page printed
    # concatenated month indices where the comment total belonged.
    assert data["schema"] == SCHEMA, f"payload says schema {data['schema']}, path says {SCHEMA}"
    app_js = os.path.join(os.path.dirname(__file__), "..", "web", "app.js")
    with open(app_js) as f:
        src = f.read()
    assert f"const SCHEMA = {SCHEMA};" in src, "app.js SCHEMA disagrees with the data"


def test_agency_names_align_with_codes(data):
    # app.js looks names up by shared index. Different lengths would silently
    # label agencies with another agency's name.
    assert len(data["agencies"]) == len(data["agencyNames"])
    assert all(n for n in data["agencyNames"]), "an agency has a blank name"


def test_agencies_are_sorted_and_unique(data):
    assert data["agencies"] == sorted(data["agencies"])
    assert len(set(data["agencies"])) == len(data["agencies"])


def test_dataset_is_not_truncated(data):
    total = sum(d[TOTAL] for d in data["dockets"])
    assert len(data["dockets"]) > 50_000, f"only {len(data['dockets'])} dockets"
    assert total > 20_000_000, f"only {total:,} comments"


def test_docket_ids_are_unique(data):
    ids = [d[ID] for d in data["dockets"]]
    assert len(set(ids)) == len(ids), "duplicate docket_id would double-count"


def test_every_row_is_well_formed(data):
    n_agencies = len(data["agencies"])
    n_types = len(data["types"])
    for d in data["dockets"]:
        assert len(d) == 6, f"{d[ID]}: expected 6 fields, got {len(d)}"
        docket_id, agency_idx, type_idx, total, yms, counts = d

        assert isinstance(docket_id, str) and docket_id
        assert 0 <= agency_idx < n_agencies, f"{docket_id}: agency index out of range"
        assert type_idx == -1 or 0 <= type_idx < n_types, f"{docket_id}: bad type index"
        assert len(yms) == len(counts), f"{docket_id}: month/count arrays differ in length"
        assert yms, f"{docket_id}: no months"


def test_totals_match_their_monthly_parts(data):
    # The stat card sums row totals; the month chart sums the per-month arrays.
    # If these drift, the two disagree on screen and neither is obviously wrong.
    for d in data["dockets"]:
        assert d[TOTAL] == sum(d[COUNTS]), \
            f"{d[ID]}: total {d[TOTAL]} != sum of months {sum(d[COUNTS])}"


def test_months_are_sorted_and_unique(data):
    # app.js takes yms[0] and yms[-1] as the year range without re-sorting.
    for d in data["dockets"]:
        assert d[YMS] == sorted(d[YMS]), f"{d[ID]}: months out of order"
        assert len(set(d[YMS])) == len(d[YMS]), f"{d[ID]}: duplicate month"


def test_no_data_before_the_stated_start(data):
    for d in data["dockets"]:
        year = d[YMS][0] // 12
        assert year >= FIRST_YEAR, f"{d[ID]}: year {year} predates {FIRST_YEAR}"


def test_months_are_in_range(data):
    for d in data["dockets"]:
        for ym in d[YMS]:
            assert 0 <= ym % 12 <= 11, f"{d[ID]}: month index {ym} decodes out of range"


def test_counts_are_positive(data):
    for d in data["dockets"]:
        assert all(c > 0 for c in d[COUNTS]), f"{d[ID]}: non-positive monthly count"


def test_most_dockets_have_titles(titles):
    # The table and the top-dockets tooltip are much less useful without these,
    # so a big drop means the dockets.parquet join broke.
    titled = sum(1 for t in titles if t.strip())
    assert titled / len(titles) > 0.95, f"only {titled:,} of {len(titles):,} titled"


def test_titles_align_with_dockets(data, titles):
    # app.js reads TITLES[i] for the docket at index i. A length mismatch would
    # label dockets with another docket's title -- silently, and worst at the
    # end of the list where nobody looks.
    assert len(titles) == len(data["dockets"]), (
        f"{len(titles):,} titles for {len(data['dockets']):,} dockets")


def test_titles_head_is_a_prefix_of_the_full_list(data, titles):
    # The core file ships the head so the opening screen needs no second fetch;
    # if it ever drifts from titles.json the visible titles would change under
    # the reader when the background load lands.
    head = data["titlesHead"]
    assert head, "titlesHead is empty"
    assert head == titles[:len(head)], "titlesHead disagrees with titles.json"


def test_core_file_stays_small(data):
    # The reason titles were split out at all. dockets.json blocks the first
    # paint; titles.json does not. Measured before the split, the single file
    # was 8.7 MB raw / ~2.6 MB on the wire and took 1045 ms to download, against
    # ~230 ms for all the parsing, filtering and drawing combined -- the wait was
    # the wire, not the work. If a new per-docket field pushes the blocking file
    # back up, that should fail here rather than resurface later as "the site
    # got slow again".
    mb = os.path.getsize(DATA_PATH) / 1e6
    assert mb < 4.5, f"dockets.json is {mb:.1f} MB — does the new field belong in a side file?"


def test_dockets_are_ordered_by_comments_desc(data):
    # Rank is no longer stored: app.js derives it as index + 1, and titles.json
    # aligns by index. Both are wrong the moment this ordering breaks.
    totals = [d[TOTAL] for d in data["dockets"]]
    assert totals == sorted(totals, reverse=True), "dockets are not ordered by total desc"
