"""End-to-end tests for the comment-count explorer.

These are the checks that stand between a broken build and the live site. Every
failure mode here has actually happened during development: a JS syntax error
that left the page blank, clipped chart labels, a chart that kept stale data
after a filter, a docket id that was plain text instead of a link.

    python -m pytest tests/test_frontend.py -v

Expects the site served at BASE_URL (CI starts `python3 -m http.server` in web/).
"""

import os

import pytest
from playwright.sync_api import Page, expect

BASE_URL = os.environ.get("SITE_URL", "http://localhost:8899")

# The page fetches an 8.4 MB JSON, then paints ~58k rows into DataTables.
LOAD_TIMEOUT = 60_000


@pytest.fixture(scope="session")
def browser_context_args():
    return {"viewport": {"width": 1440, "height": 1000}}


def load(page: Page, query: str = ""):
    page.goto(BASE_URL + "/index.html" + query)
    page.wait_for_selector("#dockets tbody tr td", timeout=LOAD_TIMEOUT)
    return page


def stat(page: Page, which: str) -> int:
    return int(page.locator(f"#stat{which}").inner_text().replace(",", ""))


# ---------- it loads at all -------------------------------------------------

def test_no_console_errors(page: Page):
    # Chromium logs a failed request as "Failed to load resource: ... 404 ()"
    # with no URL in the text -- the URL is only in the message location. Append
    # it, or a 404 for anything is indistinguishable from a 404 for the favicon.
    errors = []
    page.on(
        "console",
        lambda m: errors.append(f"{m.text} [{m.location.get('url', '?')}]")
        if m.type == "error" else None,
    )
    page.on("pageerror", lambda e: errors.append(str(e)))
    load(page)
    # favicon 404s are noise, not a broken page.
    real = [e for e in errors if "favicon" not in e.lower()]
    assert not real, f"console errors: {real}"


def test_table_renders_rows(page: Page):
    load(page)
    assert page.locator("#dockets tbody tr").count() > 0


def test_stat_cards_are_populated(page: Page):
    load(page)
    assert stat(page, "Comments") > 20_000_000
    assert stat(page, "Dockets") > 50_000
    assert stat(page, "Agencies") > 100


def test_all_three_charts_have_data(page: Page):
    load(page)
    counts = page.evaluate("""() => ({
        month: chartMonth.data.datasets[0].data.length,
        dockets: chartDockets.data.datasets[0].data.length,
        agency: chartAgency.data.datasets[0].data.length,
    })""")
    assert counts["month"] > 100, counts
    assert counts["dockets"] == 10, counts
    assert counts["agency"] > 1, counts


# ---------- the numbers agree with each other -------------------------------

def test_stat_total_matches_the_month_chart(page: Page):
    # Two independent paths to the same number: row totals vs per-month arrays.
    load(page)
    charted = page.evaluate(
        "() => chartMonth.data.datasets[0].data.reduce((a, b) => a + b, 0)")
    assert charted == stat(page, "Comments")


def test_top_docket_chart_matches_the_table(page: Page):
    load(page)
    top_chart = page.evaluate("() => chartDockets.data.labels[0]")
    # td[0] is the rank column; the docket id is td[1].
    top_table = page.locator("#dockets tbody tr").first.locator("td").nth(1).inner_text()
    assert top_chart == top_table.strip()


# ---------- filtering -------------------------------------------------------

def test_url_filter_narrows_everything(page: Page):
    load(page)
    all_dockets = stat(page, "Dockets")

    load(page, "?agency=OMB")
    assert stat(page, "Agencies") == 1
    assert stat(page, "Dockets") < all_dockets
    assert page.evaluate("() => chartAgency.data.labels") == ["OMB"]


def test_year_filter_counts_only_that_year(page: Page):
    # The point of storing per-month counts: a year filter must report the
    # docket's comments *in that year*, not its lifetime total.
    load(page, "?agency=OMB")
    lifetime = stat(page, "Comments")
    load(page, "?agency=OMB&year=2026")
    assert stat(page, "Comments") < lifetime
    months = page.evaluate("() => chartMonth.data.labels")
    assert all(m.startswith("2026") for m in months), months


def test_filter_chips_render_and_clear(page: Page):
    load(page, "?agency=OMB&year=2026")
    assert page.locator(".filter-chip").count() == 2

    page.locator(".filter-chip-remove").first.click()
    page.wait_for_function("() => document.querySelectorAll('.filter-chip').length === 1")
    assert "agency" not in page.url

    page.locator("#btnClearFilters").click()
    page.wait_for_selector(".filters-bar-empty")


def test_title_search_matches(page: Page):
    load(page, "?title=water+quality")
    rows = page.locator("#dockets tbody tr")
    assert rows.count() > 0
    first_title = rows.first.locator("td").nth(3).inner_text().lower()
    assert "water quality" in first_title


def test_min_comments_filter(page: Page):
    load(page, "?min=100000")
    values = page.evaluate("""() => [...document.querySelectorAll('#dockets tbody tr')]
        .map(tr => Number(tr.children[5].textContent.replace(/,/g, '')))""")
    assert values, "no rows survived"
    assert all(v >= 100_000 for v in values), min(values)


def test_impossible_filter_yields_zero_not_a_crash(page: Page):
    page.goto(BASE_URL + "/index.html?agency=OMB&title=zzzznotathing")
    page.wait_for_function("() => document.getElementById('statDockets').textContent === '0'",
                           timeout=LOAD_TIMEOUT)
    assert stat(page, "Comments") == 0


# ---------- links and labels ------------------------------------------------

def test_docket_ids_link_to_regulations_gov(page: Page):
    load(page)
    link = page.locator("#dockets tbody a.docket-id").first
    docket_id = link.inner_text().strip()
    assert link.get_attribute("href") == f"https://www.regulations.gov/docket/{docket_id}"
    assert link.get_attribute("target") == "_blank"


def test_agency_tooltip_spells_the_name_out(page: Page):
    load(page)
    name = page.evaluate("() => agencyName('EPA')")
    assert "EPA" in name and len(name) > len("EPA (EPA)")


def test_docket_axis_labels_are_not_clipped(page: Page):
    # Chart.js under-measures the mono font; app.js claims the width explicitly.
    load(page)
    fits = page.evaluate("""() => {
        const longest = Math.max(...chartDockets.data.labels.map(l => l.length));
        return chartDockets.scales.y.width >= longest * 7.0;
    }""")
    assert fits, "y-axis narrower than its longest docket id"


# ---------- shareability ----------------------------------------------------

def test_filters_survive_a_reload(page: Page):
    load(page, "?agency=OMB&year=2026")
    expected = stat(page, "Comments")
    page.reload()
    page.wait_for_selector("#dockets tbody tr td", timeout=LOAD_TIMEOUT)
    assert stat(page, "Comments") == expected


def test_applying_a_filter_updates_the_url(page: Page):
    load(page)
    page.evaluate("""() => {
        filters.agency = ['OMB'];
        refresh();
    }""")
    assert "agency=OMB" in page.url


# ---------- absolute rank ---------------------------------------------------

def rank_of(page: Page, docket_id: str) -> int:
    return page.evaluate(
        "id => Number([...document.querySelectorAll('#dockets tbody tr')]"
        ".find(tr => tr.children[1].textContent.trim() === id).children[0].textContent)",
        docket_id)


def test_rank_starts_at_one_unfiltered(page: Page):
    load(page)
    first = page.locator("#dockets tbody tr").first
    assert first.locator("td").first.inner_text().strip() == "1"


def test_rank_does_not_renumber_when_filtered(page: Page):
    # The whole point of the column: OMB's biggest docket keeps its all-time
    # position instead of becoming "#1" the moment you filter to OMB.
    load(page)
    top_id = page.locator("#dockets tbody tr").first.locator("td").nth(1).inner_text().strip()
    agency = page.locator("#dockets tbody tr").first.locator("td").nth(2).inner_text().strip()

    load(page, f"?agency={agency}")
    assert rank_of(page, top_id) == 1, "top docket's rank changed under its own agency filter"

    load(page, "?agency=OMB")
    ranks = page.evaluate("""() => [...document.querySelectorAll('#dockets tbody tr')]
        .map(tr => Number(tr.children[0].textContent))""")
    assert ranks[0] > 1, f"OMB's biggest docket was renumbered to #{ranks[0]}"
    assert ranks == sorted(ranks), "ranks not ascending within a filtered view"


def test_rank_column_is_labelled(page: Page):
    # "#" was ambiguous next to a docket id that also looks like an identifier.
    load(page)
    header = page.locator("#dockets thead th").first
    assert header.inner_text().strip() == "Rank"
    assert "all time" in (header.get_attribute("title") or "")


def test_github_link_is_visible_in_the_header(page: Page):
    load(page)
    link = page.locator("header.site-nav a, .site-header .site-nav a").first
    assert link.is_visible()
    assert link.get_attribute("href") == \
        "https://github.com/abigailhaddad/regulations-comment-explorer"
