/* Regulations.gov comment counts.
 *
 * Data shape (data/dockets.json):
 *   agencies:    ["ACF", "ACL", ...]         index -> agency code
 *   agencyNames: ["Administration of Children and Families", ...]  same index
 *   types:       ["Rulemaking", "Nonrulemaking"]
 *   dockets:  [ [id, agencyIdx, title, typeIdx, total, [ym...], [comments...], rank], ... ]
 *
 * `rank` is position by lifetime comments across the whole dataset, fixed at
 * build time so filtering never renumbers it.
 *
 * `ym` is a month index: year = ym / 12 | 0, month = ym % 12 + 1.
 * Per-month counts are what make the year filter exact: filtering to 2019 shows
 * each docket's 2019 comments, not its lifetime total.
 *
 * Load order (see index.html): jQuery -> DataTables -> Chart.js -> this file.
 */

// The one owner of filter state. Nothing else writes to it.
const filters = { agency: [], year: [], type: [], title: '', minComments: null };

// Set once by loadData(); read-only afterwards.
let DATA = null;
let table = null;
let chartMonth = null;
let chartAgency = null;
let chartDockets = null;

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
function applyFilters() {
    const yearSet = filters.year.length ? new Set(filters.year.map(Number)) : null;
    const agencySet = filters.agency.length ? new Set(filters.agency) : null;
    const typeSet = filters.type.length ? new Set(filters.type) : null;
    const needle = filters.title.trim().toLowerCase();
    const out = [];

    for (const d of DATA.dockets) {
        const agency = DATA.agencies[d[1]];
        if (agencySet && !agencySet.has(agency)) continue;

        const type = d[3] >= 0 ? DATA.types[d[3]] : '';
        if (typeSet && !typeSet.has(type)) continue;

        if (needle && !d[2].toLowerCase().includes(needle) &&
            !d[0].toLowerCase().includes(needle)) continue;

        const yms = d[5];
        let comments = d[4];
        let lo = yearOf(yms[0]);
        let hi = yearOf(yms[yms.length - 1]);
        if (yearSet) {
            comments = 0;
            lo = null;
            for (let i = 0; i < yms.length; i++) {
                const y = yearOf(yms[i]);
                if (!yearSet.has(y)) continue;
                comments += d[6][i];
                if (lo === null) lo = y;
                hi = y;
            }
            if (lo === null) continue;
        }

        if (filters.minComments !== null && comments < filters.minComments) continue;

        out.push({ id: d[0], agency, title: d[2], type, comments, lo, hi, rank: d[7] });
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
    // Monthly totals need the raw per-month numbers, not the row total.
    const yearSet = filters.year.length ? new Set(filters.year.map(Number)) : null;
    const keep = new Set(rows.map(r => r.id));
    for (const d of DATA.dockets) {
        if (!keep.has(d[0])) continue;
        for (let i = 0; i < d[5].length; i++) {
            const ym = d[5][i];
            if (yearSet && !yearSet.has(yearOf(ym))) continue;
            byMonth.set(ym, (byMonth.get(ym) || 0) + d[6][i]);
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
                        title: items => topDockets[items[0].dataIndex].title || '(no title)',
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
    const data = rows.map(r => [
        r.rank,
        '<a class="docket-id" href="https://www.regulations.gov/docket/' +
            encodeURIComponent(r.id) + '" target="_blank" rel="noopener">' +
            escapeHtml(r.id) + '</a>',
        escapeHtml(r.agency),
        r.title
            ? '<div class="docket-title">' + escapeHtml(r.title) + '</div>'
            : '<span class="no-title">(no title)</span>',
        escapeHtml(r.type),
        fmt(r.comments),
        yearRange(r),
    ]);

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
            const a = DATA.agencies[d[1]];
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
        for (const d of DATA.dockets) for (const ym of d[5]) years.add(yearOf(ym));
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
        const apply = () => {
            const raw = input.value.trim();
            if (field === 'minComments') filters.minComments = raw === '' ? null : Number(raw);
            else filters.title = raw;
            close();
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
        lines.push([r.rank, r.id, r.agency, r.title, r.type, r.comments, r.lo, r.hi]
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

async function loadData() {
    const res = await fetch('data/dockets.json');
    if (!res.ok) throw new Error('could not load dockets.json: HTTP ' + res.status);
    DATA = await res.json();

    let grand = 0;
    for (const d of DATA.dockets) grand += d[4];
    document.getElementById('headerCounts').textContent =
        fmt(grand) + ' comments across ' + fmt(DATA.dockets.length) + ' dockets and ' +
        DATA.agencies.length + ' agencies.';

    readFiltersFromURL();
    refresh();

    document.getElementById('btnAddFilter').addEventListener('click', openFilterPopover);
    document.getElementById('btnClearFilters').addEventListener('click', () => {
        for (const f of Object.keys(FIELDS)) clearField(f);
        refresh();
    });
    document.getElementById('btnCopyLink').addEventListener('click', () => {
        navigator.clipboard.writeText(location.href);
    });
    document.getElementById('btnDownloadCsv').addEventListener('click', () => {
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
