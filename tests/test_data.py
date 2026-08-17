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

DATA_PATH = os.path.join(os.path.dirname(__file__), "..", "web", "data", "dockets.json")

# The site starts where regulations.gov does; build_data.py enforces this and
# the header copy states it, so a stray earlier year means they disagree.
FIRST_YEAR = 2003


@pytest.fixture(scope="module")
def data():
    if not os.path.exists(DATA_PATH):
        pytest.fail(f"{DATA_PATH} missing — run `python build_data.py` first")
    with open(DATA_PATH) as f:
        return json.load(f)


def test_top_level_keys(data):
    for key in ("agencies", "agencyNames", "types", "dockets", "generated"):
        assert key in data, f"missing top-level key: {key}"


def test_agency_names_align_with_codes(data):
    # app.js looks names up by shared index. Different lengths would silently
    # label agencies with another agency's name.
    assert len(data["agencies"]) == len(data["agencyNames"])
    assert all(n for n in data["agencyNames"]), "an agency has a blank name"


def test_agencies_are_sorted_and_unique(data):
    assert data["agencies"] == sorted(data["agencies"])
    assert len(set(data["agencies"])) == len(data["agencies"])


def test_dataset_is_not_truncated(data):
    total = sum(d[4] for d in data["dockets"])
    assert len(data["dockets"]) > 50_000, f"only {len(data['dockets'])} dockets"
    assert total > 20_000_000, f"only {total:,} comments"


def test_docket_ids_are_unique(data):
    ids = [d[0] for d in data["dockets"]]
    assert len(set(ids)) == len(ids), "duplicate docket_id would double-count"


def test_every_row_is_well_formed(data):
    n_agencies = len(data["agencies"])
    n_types = len(data["types"])
    for d in data["dockets"]:
        assert len(d) == 8, f"{d[0]}: expected 8 fields, got {len(d)}"
        docket_id, agency_idx, title, type_idx, total, yms, counts, rank = d
        assert isinstance(rank, int) and rank >= 1, f"{docket_id}: bad rank {rank}"

        assert isinstance(docket_id, str) and docket_id
        assert 0 <= agency_idx < n_agencies, f"{docket_id}: agency index out of range"
        assert isinstance(title, str)
        assert type_idx == -1 or 0 <= type_idx < n_types, f"{docket_id}: bad type index"
        assert len(yms) == len(counts), f"{docket_id}: month/count arrays differ in length"
        assert yms, f"{docket_id}: no months"


def test_totals_match_their_monthly_parts(data):
    # The stat card sums row totals; the month chart sums the per-month arrays.
    # If these drift, the two disagree on screen and neither is obviously wrong.
    for d in data["dockets"]:
        assert d[4] == sum(d[6]), f"{d[0]}: total {d[4]} != sum of months {sum(d[6])}"


def test_months_are_sorted_and_unique(data):
    # app.js takes yms[0] and yms[-1] as the year range without re-sorting.
    for d in data["dockets"]:
        assert d[5] == sorted(d[5]), f"{d[0]}: months out of order"
        assert len(set(d[5])) == len(d[5]), f"{d[0]}: duplicate month"


def test_no_data_before_the_stated_start(data):
    for d in data["dockets"]:
        year = d[5][0] // 12
        assert year >= FIRST_YEAR, f"{d[0]}: year {year} predates {FIRST_YEAR}"


def test_months_are_in_range(data):
    for d in data["dockets"]:
        for ym in d[5]:
            assert 0 <= ym % 12 <= 11, f"{d[0]}: month index {ym} decodes out of range"


def test_counts_are_positive(data):
    for d in data["dockets"]:
        assert all(c > 0 for c in d[6]), f"{d[0]}: non-positive monthly count"


def test_most_dockets_have_titles(data):
    # The table and the top-dockets tooltip are much less useful without these,
    # so a big drop means the dockets.parquet join broke.
    titled = sum(1 for d in data["dockets"] if d[2].strip())
    assert titled / len(data["dockets"]) > 0.95, f"only {titled:,} of {len(data['dockets']):,} titled"


def test_rank_is_dense_and_complete(data):
    ranks = sorted(d[7] for d in data["dockets"])
    assert ranks == list(range(1, len(ranks) + 1)), "ranks are not 1..N with no gaps"


def test_rank_follows_comment_totals(data):
    # Rank is assigned by position in a total-DESC query. If that ordering ever
    # breaks, #1 stops being the biggest docket and the column lies.
    by_rank = sorted(data["dockets"], key=lambda d: d[7])
    totals = [d[4] for d in by_rank]
    assert totals == sorted(totals, reverse=True), "rank order disagrees with comment totals"
