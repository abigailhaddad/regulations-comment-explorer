/* Regulations.gov comment counts.
 *
 * Data shape (data/dockets.json):
 *   agencies:    ["ACF", "ACL", ...]         index -> agency code
 *   agencyNames: ["Administration of Children and Families", ...]  same index
 *   types:       ["Rulemaking", "Nonrulemaking"]
 *   titlesHead:  titles for the first 2000 dockets
 *   dockets:  [ [id, agencyIdx, typeIdx, total, [ym...], [comments...]], ... ]
 *
 * `dockets` is ordered by lifetime comments desc, so a docket's INDEX is its
 * all-time rank minus one, and titles line up with it by index. Nothing here
 * may reorder that array -- three separate things read position as meaning.
 *
 * Titles arrive separately, from data/titles.json. They were 62% of the payload
 * when everything shipped in one file, and the page shows 25 of them at a time,
 * so the big fetch no longer blocks the first paint: the core file draws the
 * whole page, `titlesHead` covers the opening screen, and the rest stream in
 * behind it. See loadData() for the one case that still has to wait.
 *
 * `ym` is a month index: year = ym / 12 | 0, month = ym % 12 + 1.
 * Per-month counts are what make the year filter exact: filtering to 2019 shows
 * each docket's 2019 comments, not its lifetime total.
 *
 * Load order (see index.html): jQuery -> DataTables -> Chart.js -> this file.
 */

// Field positions within a docket row. Named because the row is a bare array
// and d[3] vs d[4] is exactly the kind of thing that silently charts the wrong
// column after an edit.
const ID = 0, AGENCY = 1, TYPE = 2, TOTAL = 3, YMS = 4, COUNTS = 5;

// The one owner of filter state. Nothing else writes to it.
const filters = { agency: [], year: [], type: [], title: '', minComments: null };

// Set once by loadData(); read-only afterwards.
let DATA = null;
let table = null;
let chartMonth = null;
let chartAgency = null;
let chartDockets = null;

// Titles by docket index. Starts as the head slice from the core file and is
// replaced by the full array when titles.json lands. Never null, so every
// reader can just call titleOf().
let TITLES = [];
let titlesReady = false;

function titleOf(i) {
    return TITLES[i] || '';
}

const FIELDS = {
    agency: { label: 'Agency', kind: 'list' },
    year: { label: 'Year', kind: 'list' },
    type: { label: 'Type', kind: 'list' },
    title: { label: 'Title contains', kind: 'text' },
    minComments: { label: 'Min comments', kind: 'number' },
};

function fmt(n) {
    return n.toLocaleString('en-US');
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

/* ---------- filtering ---------------------------------------------------- */

// Returns plain row objects. `comments` respects the year filter, so the table,
// the stat cards and the CSV all agree by construction.
//
// `idx` is the docket's position in DATA.dockets, which is both its all-time
// rank (idx + 1) and its key into TITLES.
function applyFilters() {
    const yearSet = filters.year.length ? new Set(filters.year.map(Number)) : null;
    const agencySet = filters.agency.length ? new Set(filters.agency) : null;
    const typeSet = filters.type.length ? new Set(filters.type) : null;
    const needle = filters.title.trim().toLowerCase();
    const out = [];

    for (let i = 0; i < DATA.dockets.length; i++) {
        const d = DATA.dockets[i];
        const agency = DATA.agencies[d[AGENCY]];
        if (agencySet && !agencySet.has(agency)) continue;

        const type = d[TYPE] >= 0 ? DATA.types[d[TYPE]] : '';
        if (typeSet && !typeSet.has(type)) continue;

        // loadData() awaits titles before any refresh that could hit this, so a
        // title search is never silently matched against a half-loaded list.
        if (needle && !titleOf(i).toLowerCase().includes(needle) &&
            !d[ID].toLowerCase().includes(needle)) continue;

        const yms = d[YMS];
        let comments = d[TOTAL];
        let lo = yearOf(yms[0]);
        let hi = yearOf(yms[yms.length - 1]);
        if (yearSet) {
            comments = 0;
            lo = null;
            for (let j = 0; j < yms.length; j++) {
                const y = yearOf(yms[j]);
                if (!yearSet.has(y)) continue;
                comments += d[COUNTS][j];
                if (lo === null) lo = y;
                hi = y;
            }
            if (lo === null) continue;
        }

        if (filters.minComments !== null && comments < filters.minComments) continue;

        out.push({ id: d[ID], agency, type, comments, lo, hi, idx: i, rank: i + 1 });
    }
    return out;
}

/* ---------- rendering ---------------------------------------------------- */

function renderStats(rows) {
    let total = 0;
    const agencies = new Set();
    for (const r of rows) {
        total += r.comments;
        agencies.add(r.agency);
    }
    document.getElementById('statComments').textContent = fmt(total);
    document.getElementById('statDockets').textContent = fmt(rows.length);
    document.getElementById('statAgencies').textContent = fmt(agencies.size);
}

function renderCharts(rows) {
    const byMonth = new Map();
    const byAgency = new Map();
    for (const r of rows) {
        byAgency.set(r.agency, (byAgency.get(r.agency) || 0) + r.comments);
    }
    // Monthly totals need the raw per-month numbers, not the row total. Walking
    // `rows` and looking each docket up by index visits only the survivors;
    // this used to build a Set of every surviving id and rescan all 58k rows.
    const yearSet = filters.year.length ? new Set(filters.year.map(Number)) : null;
    for (const r of rows) {
        const d = DATA.dockets[r.idx];
        for (let i = 0; i < d[YMS].length; i++) {
            const ym = d[YMS][i];
            if (yearSet && !yearSet.has(yearOf(ym))) continue;
            byMonth.set(ym, (byMonth.get(ym) || 0) + d[COUNTS][i]);
        }
    }

    // Fill the gaps so a quiet month reads as zero, not as a missing point.
    const months = [];
    if (byMonth.size) {
        const keys = [...byMonth.keys()];
        const first = Math.min(...keys);
        const last = Math.max(...keys);
        for (let ym = first; ym <= last; ym++) months.push(ym);
    }
    const topAgencies = [...byAgency.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
    const topDockets = [...rows].sort((a, b) => b.comments - a.comments).slice(0, 10);

    const accent = '#2D6A4F';
    const gold = '#D4A03C';
    const grid = 'rgba(61,43,31,0.08)';
    const tick = '#7A6E62';

    if (chartMonth) chartMonth.destroy();
    chartMonth = new Chart(document.getElementById('chartMonth'), {
        type: 'bar',
        data: {
            labels: months.map(monthLabel),
            datasets: [{
                data: months.map(ym => byMonth.get(ym) || 0),
                backgroundColor: accent,
                borderRadius: 2,
            }],
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: { callbacks: { label: c => fmt(c.parsed.y) + ' comments' } },
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: {
                        color: tick, autoSkip: true, maxTicksLimit: 14, maxRotation: 0,
                        // Across many years the year alone is enough; zoomed into one
                        // or two, every tick would read the same year, so keep the month.
                        callback(i) {
                            const label = String(this.getLabelForValue(i));
                            return months.length > 36 ? label.slice(0, 4) : label;
                        },
                    },
                },
                y: { grid: { color: grid }, ticks: { color: tick, callback: v => fmt(v) } },
            },
        },
    });

    if (chartDockets) chartDockets.destroy();
    chartDockets = new Chart(document.getElementById('chartDockets'), {
        type: 'bar',
        data: {
            labels: topDockets.map(r => r.id),
            datasets: [{
                data: topDockets.map(r => r.comments),
                backgroundColor: accent,
                borderRadius: 3,
            }],
        },
        options: {
            indexAxis: 'y',
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        // The axis has room for the docket id only; the tooltip is
                        // where you find out what the rulemaking actually was.
                        title: items => titleOf(topDockets[items[0].dataIndex].idx) || '(no title)',
                        label: c => fmt(c.parsed.x) + ' comments · ' +
                            topDockets[c.dataIndex].agency,
                    },
                },
            },
            scales: {
                x: { grid: { color: grid }, ticks: { color: tick, callback: v => fmt(v) } },
                y: {
                    grid: { display: false },
                    ticks: {
                        color: tick, autoSkip: false,
                        font: { family: 'JetBrains Mono, monospace', size: 11 },
                    },
                    // Chart.js under-measures the mono font here and clips the left
                    // of long ids ("EPA-R08-OAR-2024-0389"), so claim the width
                    // outright from the longest label actually being drawn.
                    afterFit(scale) {
                        const longest = Math.max(...topDockets.map(r => r.id.length));
                        scale.width = Math.min(300, longest * 7.4 + 18);
                    },
                },
            },
        },
    });

    if (chartAgency) chartAgency.destroy();
    chartAgency = new Chart(document.getElementById('chartAgency'), {
        type: 'bar',
        data: {
            labels: topAgencies.map(a => a[0]),
            datasets: [{ data: topAgencies.map(a => a[1]), backgroundColor: gold, borderRadius: 3 }],
        },
        options: {
            indexAxis: 'y',
            responsive: true, maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        // The axis only has room for the code; the tooltip is where
                        // "FWS" becomes "Fish and Wildlife Service".
                        title: items => agencyName(items[0].label),
                        label: c => fmt(c.parsed.x) + ' comments',
                    },
                },
            },
            scales: {
                x: { grid: { color: grid }, ticks: { color: tick, callback: v => fmt(v) } },
                // autoSkip drops every other agency, which mislabels the bars.
                y: { grid: { display: false }, ticks: { color: tick, autoSkip: false } },
            },
        },
    });
}

function agencyName(code) {
    const i = DATA.agencies.indexOf(code);
    return i >= 0 ? DATA.agencyNames[i] + ' (' + code + ')' : code;
}

function yearOf(ym) {
    return (ym / 12) | 0;
}

function monthLabel(ym) {
    return yearOf(ym) + '-' + String(ym % 12 + 1).padStart(2, '0');
}

function yearRange(r) {
    return r.lo === r.hi ? String(r.lo) : r.lo + '–' + r.hi;
}

function renderTable(rows) {
    const data = rows.map(r => {
        const title = titleOf(r.idx);
        return [
            r.rank,
            '<a class="docket-id" href="https://www.regulations.gov/docket/' +
                encodeURIComponent(r.id) + '" target="_blank" rel="noopener">' +
                escapeHtml(r.id) + '</a>',
            escapeHtml(r.agency),
            title
                ? '<div class="docket-title">' + escapeHtml(title) + '</div>'
                // Before titles.json lands this is "not loaded yet", after it
                // lands it is "this docket genuinely has no title". Saying
                // "(no title)" during the load would be a claim about the data.
                : (titlesReady
                    ? '<span class="no-title">(no title)</span>'
                    : '<span class="no-title">&hellip;</span>'),
            escapeHtml(r.type),
            fmt(r.comments),
            yearRange(r),
        ];
    });

    if (!table) {
        table = new DataTable('#dockets', {
            data,
            deferRender: true,
            pageLength: 25,
            order: [[5, 'desc']],
            columnDefs: [
                { targets: [0], className: 'num rank-col' },
                { targets: [5], className: 'num', type: 'num-fmt' },
                { targets: [6], className: 'num' },
            ],
        });
        document.getElementById('loading').style.display = 'none';
        document.getElementById('dockets').style.display = '';
    } else {
        table.clear();
        table.rows.add(data);
        table.draw();
    }
}

function refresh() {
    const rows = applyFilters();
    renderStats(rows);
    renderCharts(rows);
    renderTable(rows);
    renderChips();
    writeFiltersToURL();
    return rows;
}

/* ---------- filter chips ------------------------------------------------- */

function chipText(field) {
    const v = filters[field];
    if (field === 'title') return '"' + v + '"';
    if (field === 'minComments') return '≥ ' + fmt(v);
    return v.length <= 2 ? v.join(', ') : v.length + ' selected';
}

function activeFields() {
    return Object.keys(FIELDS).filter(f => {
        const v = filters[f];
        return Array.isArray(v) ? v.length > 0 : (v !== '' && v !== null);
    });
}

function renderChips() {
    const bar = document.getElementById('filtersBar');
    const active = activeFields();
    if (!active.length) {
        bar.innerHTML = '<span class="filters-bar-empty">No filters applied</span>';
        return;
    }
    bar.innerHTML = '<span class="bar-label">Filters:</span>' + active.map(f =>
        '<span class="filter-chip">' +
            '<span class="filter-chip-label">' + FIELDS[f].label + ':</span>' +
            '<span class="filter-chip-value" title="' + escapeHtml(chipText(f)) + '">' +
                escapeHtml(chipText(f)) + '</span>' +
            '<span class="filter-chip-remove" data-field="' + f + '">&times;</span>' +
        '</span>'
    ).join('');
}

function clearField(field) {
    filters[field] = Array.isArray(filters[field]) ? [] : (field === 'title' ? '' : null);
}

/* ---------- filter popover ----------------------------------------------- */

function optionsFor(field) {
    if (field === 'agency') {
        const counts = new Map();
        for (const d of DATA.dockets) {
            const a = DATA.agencies[d[AGENCY]];
            counts.set(a, (counts.get(a) || 0) + 1);
        }
        return [...counts.entries()].sort((a, b) => b[1] - a[1])
            .map(([v, n]) => ({
                value: v,
                hint: DATA.agencyNames[DATA.agencies.indexOf(v)] + ' · ' + fmt(n) + ' dockets',
            }));
    }
    if (field === 'year') {
        const years = new Set();
        for (const d of DATA.dockets) for (const ym of d[YMS]) years.add(yearOf(ym));
        return [...years].sort((a, b) => b - a).map(y => ({ value: String(y), hint: '' }));
    }
    if (field === 'type') {
        return DATA.types.map(t => ({ value: t, hint: '' }));
    }
    throw new Error('no option list for field: ' + field);
}

// Builds a fresh popover each time and removes it on close, so its listeners
// go with it — nothing to unbind.
function openFilterPopover() {
    const modal = document.createElement('div');
    modal.className = 'filter-modal';
    modal.innerHTML =
        '<div class="filter-popover">' +
            '<div class="filter-title">Add a filter</div>' +
            '<div class="filter-options" id="popBody"></div>' +
            '<div class="filter-buttons">' +
                '<button class="btn" id="popCancel">Cancel</button>' +
                '<button class="btn btn-apply" id="popApply">Apply</button>' +
            '</div>' +
        '</div>';
    document.body.appendChild(modal);

    const body = modal.querySelector('#popBody');
    body.innerHTML = Object.keys(FIELDS).map(f =>
        '<label class="filter-option"><input type="radio" name="whichField" value="' + f + '"> ' +
        FIELDS[f].label + '</label>'
    ).join('');

    const close = () => modal.remove();
    modal.querySelector('#popCancel').addEventListener('click', close);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });

    body.addEventListener('change', e => {
        if (e.target.name !== 'whichField') return;
        close();
        openFieldEditor(e.target.value);
    });

    modal.querySelector('#popApply').addEventListener('click', () => {
        const picked = body.querySelector('input:checked');
        if (!picked) { close(); return; }
        close();
        openFieldEditor(picked.value);
    });
}

function openFieldEditor(field) {
    const spec = FIELDS[field];
    const modal = document.createElement('div');
    modal.className = 'filter-modal';
    modal.innerHTML =
        '<div class="filter-popover">' +
            '<div class="filter-title">' + spec.label + '</div>' +
            (spec.kind === 'list'
                ? '<input class="filter-search" id="popSearch" placeholder="Search…">' +
                  '<div class="filter-options" id="popBody"></div>'
                : '<input class="filter-search" id="popBody" ' +
                  (spec.kind === 'number' ? 'type="number" min="0" ' : '') + 'placeholder="' +
                  (spec.kind === 'number' ? 'e.g. 1000' : 'e.g. water quality') + '">') +
            '<div class="filter-buttons">' +
                '<button class="btn" id="popCancel">Cancel</button>' +
                '<button class="btn btn-apply" id="popApply">Apply</button>' +
            '</div>' +
        '</div>';
    document.body.appendChild(modal);

    const close = () => modal.remove();
    modal.querySelector('#popCancel').addEventListener('click', close);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });

    if (spec.kind === 'list') {
        const opts = optionsFor(field);
        const chosen = new Set(filters[field]);
        const body = modal.querySelector('#popBody');
        const paint = (needle) => {
            body.innerHTML = opts
                .filter(o => !needle || o.value.toLowerCase().includes(needle))
                .slice(0, 400)
                .map(o =>
                    '<label class="filter-option"><input type="checkbox" value="' +
                    escapeHtml(o.value) + '"' + (chosen.has(o.value) ? ' checked' : '') + '> ' +
                    escapeHtml(o.value) +
                    (o.hint ? ' <span class="text-muted">(' + o.hint + ')</span>' : '') +
                    '</label>'
                ).join('');
        };
        paint('');
        body.addEventListener('change', e => {
            if (e.target.checked) chosen.add(e.target.value);
            else chosen.delete(e.target.value);
        });
        modal.querySelector('#popSearch').addEventListener('input', e => {
            paint(e.target.value.trim().toLowerCase());
        });
        modal.querySelector('#popApply').addEventListener('click', () => {
            filters[field] = [...chosen];
            close();
            refresh();
        });
    } else {
        const input = modal.querySelector('#popBody');
        input.value = filters[field] === null ? '' : filters[field];
        input.focus();
        const apply = async () => {
            const raw = input.value.trim();
            if (field === 'minComments') filters.minComments = raw === '' ? null : Number(raw);
            else filters.title = raw;
            close();
            // Searching titles against the 2000-title head would quietly return
            // "no matches" for anything further down the list.
            if (field === 'title' && raw) await ensureTitles();
            refresh();
        };
        modal.querySelector('#popApply').addEventListener('click', apply);
        input.addEventListener('keydown', e => { if (e.key === 'Enter') apply(); });
    }
}

/* ---------- URL round-trip ----------------------------------------------- */

function writeFiltersToURL() {
    const p = new URLSearchParams();
    if (filters.agency.length) p.set('agency', filters.agency.join(','));
    if (filters.year.length) p.set('year', filters.year.join(','));
    if (filters.type.length) p.set('type', filters.type.join(','));
    if (filters.title) p.set('title', filters.title);
    if (filters.minComments !== null) p.set('min', filters.minComments);
    const qs = p.toString();
    history.replaceState(null, '', qs ? '?' + qs : location.pathname);
}

function readFiltersFromURL() {
    const p = new URLSearchParams(location.search);
    if (p.get('agency')) filters.agency = p.get('agency').split(',');
    if (p.get('year')) filters.year = p.get('year').split(',');
    if (p.get('type')) filters.type = p.get('type').split(',');
    if (p.get('title')) filters.title = p.get('title');
    if (p.get('min')) filters.minComments = Number(p.get('min'));
}

/* ---------- CSV ---------------------------------------------------------- */

function downloadCsv(rows) {
    const esc = v => '"' + String(v).replace(/"/g, '""') + '"';
    const lines = ['overall_rank,docket_id,agency,title,docket_type,comments,first_year,last_year'];
    for (const r of rows) {
        lines.push([r.rank, r.id, r.agency, titleOf(r.idx), r.type, r.comments, r.lo, r.hi]
            .map(esc).join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'regulations_comment_counts.csv';
    a.click();
    URL.revokeObjectURL(a.href);
}

/* ---------- boot --------------------------------------------------------- */

// Phase timing, left in production on purpose — the same reasoning as
// usajobs_historical's __perf(): every piece measures fast on its own (parse
// 18ms, filter 5ms, charts 37ms, table 150ms) while the page took 1.6s, so
// without this a "the site was slow" report is unactionable. Run __perf() in
// the console after a slow load to see which phase owned it.
const PERF = [];
const perfMark = (phase) => PERF.push({ phase, ms: Math.round(performance.now()) });
window.__perf = () => { console.table(PERF); return PERF; };
perfMark('script-start');

// The row shape this file knows how to read. It is in the data URLs and checked
// against the payload, because the alternative failed in production: the split
// changed `dockets` from 8 fields to 6 under the same filename, and browsers
// holding a cached app.js read new rows at old offsets. The headline summed
// d[4] -- once the total, now the months array -- and printed a mile of
// concatenated month indices instead of 25.4M. Wrong, and silent.
//
// Versioned names mean a stale app.js requests a URL that no longer exists and
// fails visibly; the assert below catches anything that slips past that.
const SCHEMA = 2;

// Started, not awaited. Titles are the biggest thing on the wire and the least
// urgent — nothing on the opening screen needs the tail of this list, so the
// page paints from the core file and this fills in behind it.
const titlesPromise = fetch(`data/titles.v${SCHEMA}.json`)
    .then(r => (r.ok ? r.json() : null))
    .catch(() => null);

/** Resolves once the full title list is in TITLES (or has failed to load).
 *  Anything that reads titles for ALL dockets — a title search, a CSV export —
 *  has to await this or it silently works off the 2000-title head. */
async function ensureTitles() {
    if (titlesReady) return;
    const full = await titlesPromise;
    if (full) TITLES = full;
    titlesReady = true;
    perfMark(full ? 'titles-ready' : 'titles-FAILED');
}

async function loadData() {
    const url = `data/dockets.v${SCHEMA}.json`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`could not load ${url}: HTTP ${res.status}`);
    DATA = await res.json();
    // Belt and braces with the versioned filename. Reading rows at the wrong
    // offsets does not throw in JS -- it produces a plausible-looking wrong
    // number -- so refuse to render rather than publish one.
    if (DATA.schema !== SCHEMA) {
        throw new Error(
            `data schema ${DATA.schema} but this app.js reads ${SCHEMA} — reload the page`);
    }
    perfMark('core-data-ready');

    // The head slice covers the opening screen; ensureTitles() swaps in the
    // full list. Both are indexed by docket position, so this is a widening,
    // not a different shape.
    TITLES = DATA.titlesHead || [];

    let grand = 0;
    for (const d of DATA.dockets) grand += d[TOTAL];
    document.getElementById('headerCounts').textContent =
        fmt(grand) + ' comments across ' + fmt(DATA.dockets.length) + ' dockets and ' +
        DATA.agencies.length + ' agencies.';

    readFiltersFromURL();

    // A shared link carrying ?title= must not paint a wrong result set first and
    // correct itself a second later, so that one case waits. Every other filter
    // draws immediately off the core file.
    if (filters.title) await ensureTitles();
    refresh();
    perfMark('first-render');

    // Fill in the rest of the titles whenever they arrive. Only the table and
    // the top-dockets tooltip read them, so this is a table redraw, not a full
    // refresh — no recompute of stats or charts that titles cannot affect.
    if (!titlesReady) {
        ensureTitles().then(() => {
            renderTable(applyFilters());
            perfMark('titles-painted');
        });
    }

    document.getElementById('btnAddFilter').addEventListener('click', openFilterPopover);
    document.getElementById('btnClearFilters').addEventListener('click', () => {
        for (const f of Object.keys(FIELDS)) clearField(f);
        refresh();
    });
    document.getElementById('btnCopyLink').addEventListener('click', () => {
        navigator.clipboard.writeText(location.href);
    });
    // The CSV carries a title column, so it needs the full list even though the
    // screen may only have shown the head.
    document.getElementById('btnDownloadCsv').addEventListener('click', async () => {
        await ensureTitles();
        downloadCsv(applyFilters());
    });
    // Delegated: the chips themselves are replaced on every render.
    document.getElementById('filtersBar').addEventListener('click', e => {
        const field = e.target.dataset.field;
        if (!field) return;
        clearField(field);
        refresh();
    });
}

loadData();
