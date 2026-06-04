import { useEffect, useState, useMemo, useCallback } from "react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
  PieChart, Pie, Legend,
  LineChart, Line,
} from "recharts";
import { getWorkSchedule } from "../services/arcgisService";
import { exportToCsv } from "../utils/exportCsv";

// ─── Field resolution ─────────────────────────────────────────
// Tries common Survey123 field name patterns for each logical field.
// If your form uses different names, add them to the relevant array.
const CANDIDATES = {
  project_name:  ["project_name", "project", "projectName", "project_title", "site_name", "Project_Name", "name"],
  activity:      ["activity", "activity_name", "activityName", "work_activity", "task", "work_description", "Activity"],
  stage:         ["current_stage", "stage", "phase", "work_stage", "currentStage", "Current_Stage", "phase_name", "work_phase"],
  supervisor:    ["supervisor", "supervisor_name", "supervisorName", "site_supervisor", "foreman", "crew_lead", "inspector_name", "Supervisor"],
  date_ms:       ["EditDate", "date_updated", "dateUpdated", "last_updated", "update_date", "CreationDate"],
  status:        ["status", "work_status", "activity_status", "workStatus", "Status", "completion_status"],
  progress:      ["completion_progress", "progress", "percent_complete", "completion", "progress_percent", "percentComplete", "Progress"],
  location:      ["site_location", "location", "site", "area", "work_area", "Site_Location", "Location"],
  remarks:       ["remarks", "notes", "comments", "description", "Notes", "Remarks"],
};

function pick(r, key) {
  for (const f of CANDIDATES[key]) {
    const v = r[f];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}

// ─── Status helpers ───────────────────────────────────────────
function classifyStatus(s) {
  if (!s) return "other";
  const v = s.toLowerCase();
  if (/complet|done|finish|closed/.test(v))          return "completed";
  if (/delay|overdue|behind|late|stall/.test(v))      return "delayed";
  if (/ongoing|progress|active|started|underway|running/.test(v)) return "ongoing";
  if (/plan|pending|schedul/.test(v))                 return "planned";
  return "other";
}

const STATUS_CSS = {
  completed: "status-pill--completed",
  ongoing:   "status-pill--in-progress",
  delayed:   "status-pill--expiring",
  planned:   "status-pill--planned",
  other:     "status-pill--closed",
};

function StatusBadge({ status }) {
  if (!status) return <span style={{ color: "var(--text-muted)" }}>—</span>;
  const cls = STATUS_CSS[classifyStatus(status)] || "status-pill--closed";
  return <span className={`status-pill ${cls}`}>{status}</span>;
}

// ─── Progress cell ────────────────────────────────────────────
function ProgressCell({ value }) {
  const num = value === null ? null : typeof value === "number" ? value : parseFloat(String(value));
  if (num === null || isNaN(num)) return <span style={{ color: "var(--text-muted)" }}>—</span>;
  const pct = Math.min(100, Math.max(0, num));
  const color = pct === 100 ? "#1E9E52" : pct >= 70 ? "#B8881A" : pct >= 40 ? "#1A74BC" : "#D4820A";
  return (
    <div className="progress-cell">
      <div className="progress-bar-inline">
        <div className="progress-fill-inline" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="progress-pct-inline">{pct}%</span>
    </div>
  );
}

// ─── Pagination ───────────────────────────────────────────────
function Pagination({ page, totalPages, onChange }) {
  if (totalPages <= 1) return null;
  const pages   = Array.from({ length: totalPages }, (_, i) => i + 1);
  const visible = pages.filter((p) => p === 1 || p === totalPages || Math.abs(p - page) <= 1);
  return (
    <div className="pagination" role="navigation" aria-label="Table pagination">
      <span className="pagination-info">Page {page} of {totalPages}</span>
      <div className="pagination-controls">
        <button className="pagination-btn" onClick={() => onChange(page - 1)} disabled={page === 1} aria-label="Previous page">&#8249;</button>
        {visible.reduce((acc, p, i) => {
          if (i > 0 && p - visible[i - 1] > 1)
            acc.push(<span key={`gap-${p}`} style={{ padding: "4px 6px", color: "var(--text-muted)" }}>…</span>);
          acc.push(
            <button
              key={p}
              className={`pagination-btn ${p === page ? "pagination-btn--active" : ""}`}
              onClick={() => onChange(p)}
              aria-label={`Page ${p}`}
              aria-current={p === page ? "page" : undefined}
            >{p}</button>
          );
          return acc;
        }, [])}
        <button className="pagination-btn" onClick={() => onChange(page + 1)} disabled={page === totalPages} aria-label="Next page">&#8250;</button>
      </div>
    </div>
  );
}

// ─── Constants ────────────────────────────────────────────────
const PAGE_SIZE    = 20;
const COLORS       = ["#B8881A", "#1A74BC", "#1E9E52", "#D4820A", "#7D3C98", "#C0392B"];
const TOOLTIP_STYLE = { background: "#fff", border: "1px solid #DDE1E8", borderRadius: 6, fontSize: 12, color: "#1A2332" };
const CSV_COLUMNS = [
  { key: "_project",    label: "Project" },
  { key: "_activity",   label: "Activity" },
  { key: "_stage",      label: "Stage" },
  { key: "_supervisor", label: "Supervisor" },
  { key: "_dateStr",    label: "Date Updated" },
  { key: "_status",     label: "Status" },
  { key: "_progress",   label: "Progress (%)" },
  { key: "_location",   label: "Site Location" },
  { key: "_remarks",    label: "Remarks" },
];

function fmtDate(ms) {
  if (!ms) return "—";
  return new Date(ms).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function parseProgress(v) {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return isNaN(n) ? null : Math.min(100, Math.max(0, n));
}

// ─── Main Component ───────────────────────────────────────────
function WorkSchedule() {
  const [records,     setRecords]     = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState(null);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [page,        setPage]        = useState(1);

  // Filters
  const [fProject,  setFProject]  = useState("All");
  const [fStage,    setFStage]    = useState("All");
  const [fSuper,    setFSuper]    = useState("All");
  const [fStatus,   setFStatus]   = useState("All");
  const [fLocation, setFLocation] = useState("All");
  const [fFrom,     setFFrom]     = useState("");
  const [fTo,       setFTo]       = useState("");
  const [search,    setSearch]    = useState("");

  // ── Load + 30-second auto-refresh ──────────────────────────
  useEffect(() => {
    let cancelled = false;

    const load = () => {
      getWorkSchedule()
        .then((rows) => {
          if (cancelled) return;
          setRecords(rows.map((r) => {
            const rawDate = pick(r, "date_ms");
            const dateMs  = typeof rawDate === "number" ? rawDate : null;
            return {
              ...r,
              _project:    pick(r, "project_name"),
              _activity:   pick(r, "activity"),
              _stage:      pick(r, "stage"),
              _supervisor: pick(r, "supervisor"),
              _dateMs:     dateMs,
              _dateStr:    fmtDate(dateMs),
              _status:     pick(r, "status"),
              _progress:   parseProgress(pick(r, "progress")),
              _location:   pick(r, "location"),
              _remarks:    pick(r, "remarks"),
            };
          }));
          setLastRefresh(new Date());
          setError(null);
        })
        .catch((err) => { if (!cancelled) setError(err.message); })
        .finally(() => { if (!cancelled) setLoading(false); });
    };

    load();
    const id = setInterval(load, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // ── Filter options (unique values from all records) ─────────
  const projects    = useMemo(() => [...new Set(records.map((r) => r._project).filter(Boolean))].sort(), [records]);
  const stages      = useMemo(() => [...new Set(records.map((r) => r._stage).filter(Boolean))].sort(), [records]);
  const supervisors = useMemo(() => [...new Set(records.map((r) => r._supervisor).filter(Boolean))].sort(), [records]);
  const locations   = useMemo(() => [...new Set(records.map((r) => r._location).filter(Boolean))].sort(), [records]);
  const statuses    = useMemo(() => [...new Set(records.map((r) => r._status).filter(Boolean))].sort(), [records]);

  // ── Apply filters ───────────────────────────────────────────
  const filtered = useMemo(() => records.filter((r) => {
    if (fProject  !== "All" && r._project    !== fProject)  return false;
    if (fStage    !== "All" && r._stage      !== fStage)    return false;
    if (fSuper    !== "All" && r._supervisor !== fSuper)    return false;
    if (fStatus   !== "All" && r._status     !== fStatus)   return false;
    if (fLocation !== "All" && r._location   !== fLocation) return false;
    if (fFrom && r._dateMs && r._dateMs < new Date(fFrom).getTime()) return false;
    if (fTo   && r._dateMs && r._dateMs > new Date(fTo).getTime() + 86_400_000) return false;
    if (search) {
      const q = search.toLowerCase();
      const hay = [r._project, r._activity, r._stage, r._supervisor, r._location, r._status]
        .filter(Boolean).join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }), [records, fProject, fStage, fSuper, fStatus, fLocation, fFrom, fTo, search]);

  const resetPage    = useCallback(() => setPage(1), []);
  const clearFilters = useCallback(() => {
    setFProject("All"); setFStage("All"); setFSuper("All");
    setFStatus("All"); setFLocation("All"); setFFrom(""); setFTo(""); setSearch("");
    setPage(1);
  }, []);

  const hasFilter = fProject !== "All" || fStage !== "All" || fSuper !== "All" ||
    fStatus !== "All" || fLocation !== "All" || fFrom || fTo || search;

  // ── KPI aggregates ──────────────────────────────────────────
  const kpis = useMemo(() => ({
    total:     filtered.length,
    ongoing:   filtered.filter((r) => classifyStatus(r._status) === "ongoing").length,
    completed: filtered.filter((r) => classifyStatus(r._status) === "completed").length,
    delayed:   filtered.filter((r) => classifyStatus(r._status) === "delayed").length,
  }), [filtered]);

  // ── Chart data ──────────────────────────────────────────────
  const stageData = useMemo(() => {
    const m = {};
    filtered.forEach((r) => { const s = r._stage || "Unknown"; m[s] = (m[s] || 0) + 1; });
    return Object.entries(m).map(([stage, count]) => ({ stage, count })).sort((a, b) => b.count - a.count);
  }, [filtered]);

  const statusData = useMemo(() => {
    const m = {};
    filtered.forEach((r) => { const s = r._status || "Unknown"; m[s] = (m[s] || 0) + 1; });
    return Object.entries(m).map(([name, value]) => ({ name, value }));
  }, [filtered]);

  const trendData = useMemo(() => {
    const now = new Date();
    const monthMap = {};
    for (let i = 5; i >= 0; i--) {
      const d   = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const key = d.toLocaleDateString("en-GB", { month: "short", year: "2-digit" });
      monthMap[key] = { month: key, Activities: 0 };
    }
    filtered.forEach((r) => {
      if (!r._dateMs) return;
      const key = new Date(r._dateMs).toLocaleDateString("en-GB", { month: "short", year: "2-digit" });
      if (monthMap[key]) monthMap[key].Activities++;
    });
    return Object.values(monthMap);
  }, [filtered]);

  // ── Recent submissions (latest 5, unfiltered) ───────────────
  const recent = useMemo(() =>
    [...records].sort((a, b) => (b._dateMs || 0) - (a._dateMs || 0)).slice(0, 5),
  [records]);

  // ── Pagination ──────────────────────────────────────────────
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage   = Math.min(page, totalPages);
  const pageItems  = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  // ── Export ──────────────────────────────────────────────────
  const exportData = useMemo(() => filtered, [filtered]);

  // ═══════════════════════════════════════════════════════════════
  if (loading) {
    return (
      <div className="page-schedule">
        <div className="loading-state"><div className="spinner" aria-label="Loading" /><p>Loading work schedule data…</p></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="page-schedule">
        <div className="error-state">
          <span className="error-icon" role="img" aria-label="Error">!</span>
          <p>Failed to load work schedule data</p>
          <p className="error-detail">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-schedule">

      {/* ══ KPI Cards ══════════════════════════════════════ */}
      <section className="kpi-grid" aria-label="Work schedule summary">
        {[
          { title: "Total Activities",   value: kpis.total,     sub: "Filtered entries",       color: "#B8881A" },
          { title: "Ongoing Works",      value: kpis.ongoing,   sub: "Currently in progress",  color: "#1A74BC" },
          { title: "Completed Works",    value: kpis.completed, sub: "Finished activities",    color: "#1E9E52" },
          { title: "Delayed Activities", value: kpis.delayed,   sub: "Behind schedule",        color: "#C0392B" },
        ].map((kpi) => (
          <div className="kpi-card" key={kpi.title}>
            <div className="kpi-icon" style={{ background: kpi.color + "18", color: kpi.color }} aria-hidden="true" />
            <div className="kpi-data">
              <span className="kpi-value">{kpi.value}</span>
              <span className="kpi-title">{kpi.title}</span>
              <span className="kpi-trend">{kpi.sub}</span>
            </div>
          </div>
        ))}
      </section>

      {/* ══ Charts ═══════════════════════════════════════════ */}
      <div className="schedule-charts-grid">

        <section className="panel chart-panel" aria-label="Activities by stage">
          <div className="panel-header">
            <h3>Activities by Stage</h3>
            <span className="panel-badge">{stageData.length} stages</span>
          </div>
          <div className="chart-wrap">
            {stageData.length === 0 ? (
              <div className="empty-state" style={{ minHeight: 180 }}><p>No stage data yet.</p></div>
            ) : (
              <ResponsiveContainer width="100%" height={Math.max(160, stageData.length * 38)}>
                <BarChart data={stageData} layout="vertical" margin={{ top: 4, right: 20, bottom: 4, left: 110 }}>
                  <XAxis type="number" allowDecimals={false} tick={{ fill: "#8B96A6", fontSize: 11 }} />
                  <YAxis type="category" dataKey="stage" tick={{ fill: "#4D5A6E", fontSize: 11 }} width={106} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} />
                  <Bar dataKey="count" radius={[0, 3, 3, 0]}>
                    {stageData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </section>

        <section className="panel chart-panel" aria-label="Status distribution">
          <div className="panel-header"><h3>Status Distribution</h3></div>
          <div className="chart-wrap">
            {statusData.length === 0 ? (
              <div className="empty-state" style={{ minHeight: 180 }}><p>No status data yet.</p></div>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie data={statusData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={72} label>
                    {statusData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                  </Pie>
                  <Tooltip contentStyle={TOOLTIP_STYLE} />
                  <Legend wrapperStyle={{ fontSize: 11, color: "#4D5A6E" }} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>
        </section>

        <section className="panel chart-panel" aria-label="Activity trend over 6 months">
          <div className="panel-header"><h3>Activity Trend (6 Months)</h3></div>
          <div className="chart-wrap">
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={trendData} margin={{ top: 8, right: 12, bottom: 0, left: -20 }}>
                <XAxis dataKey="month" tick={{ fill: "#8B96A6", fontSize: 11 }} />
                <YAxis allowDecimals={false} tick={{ fill: "#8B96A6", fontSize: 11 }} />
                <Tooltip contentStyle={TOOLTIP_STYLE} />
                <Line type="monotone" dataKey="Activities" stroke="#1A74BC" strokeWidth={2} dot={{ fill: "#1A74BC", r: 3 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </section>

      </div>

      {/* ══ Recent Submissions ═══════════════════════════════ */}
      <section className="panel" aria-label="Recent field submissions">
        <div className="panel-header">
          <h3>Recent Field Submissions</h3>
          {lastRefresh && (
            <span className="panel-badge">
              Auto-refreshes every 30 s · last at {lastRefresh.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
            </span>
          )}
        </div>
        {recent.length === 0 ? (
          <div className="empty-state" style={{ padding: "28px 20px" }}>
            <p>No submissions yet.</p>
            <p className="empty-hint">Records will appear here as Survey123 forms are submitted.</p>
          </div>
        ) : (
          <ul className="recent-submissions-list" aria-label="Recent submissions">
            {recent.map((r, i) => (
              <li key={r.objectid ?? i} className="recent-sub-item">
                <span className="recent-sub-dot" style={{ background: COLORS[i % COLORS.length] }} aria-hidden="true" />
                <div className="recent-sub-body">
                  <span className="recent-sub-title">
                    {r._project || "—"}{r._activity ? ` — ${r._activity}` : ""}
                  </span>
                  <div className="recent-sub-meta">
                    {r._stage      && <span className="recent-sub-tag">{r._stage}</span>}
                    {r._supervisor && <span>{r._supervisor}</span>}
                    {r._status     && <StatusBadge status={r._status} />}
                    <span className="recent-sub-time">{r._dateStr}</span>
                  </div>
                </div>
                {r._progress !== null && (
                  <div style={{ width: 90, flexShrink: 0 }}>
                    <ProgressCell value={r._progress} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ══ Data Table ═══════════════════════════════════════ */}
      <section className="panel" aria-label="All activities table">
        <div className="panel-header">
          <h3>All Activities</h3>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span className="panel-badge">{filtered.length} records</span>
            <button
              className="export-btn"
              onClick={() => exportToCsv("work-schedule.csv", exportData, CSV_COLUMNS)}
              disabled={!filtered.length}
              aria-label="Export filtered records to CSV"
            >Export CSV</button>
          </div>
        </div>

        {/* Filters */}
        <div className="schedule-filters" role="search" aria-label="Filter activities">
          <input
            className="table-search"
            style={{ width: 200 }}
            placeholder="Search project, activity…"
            value={search}
            onChange={(e) => { setSearch(e.target.value); resetPage(); }}
            aria-label="Search activities"
          />

          <select className="schedule-select" value={fProject} onChange={(e) => { setFProject(e.target.value); resetPage(); }} aria-label="Filter by project">
            <option value="All">All Projects</option>
            {projects.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>

          <select className="schedule-select" value={fStage} onChange={(e) => { setFStage(e.target.value); resetPage(); }} aria-label="Filter by stage">
            <option value="All">All Stages</option>
            {stages.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>

          <select className="schedule-select" value={fSuper} onChange={(e) => { setFSuper(e.target.value); resetPage(); }} aria-label="Filter by supervisor">
            <option value="All">All Supervisors</option>
            {supervisors.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>

          <select className="schedule-select" value={fStatus} onChange={(e) => { setFStatus(e.target.value); resetPage(); }} aria-label="Filter by status">
            <option value="All">All Statuses</option>
            {statuses.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>

          <select className="schedule-select" value={fLocation} onChange={(e) => { setFLocation(e.target.value); resetPage(); }} aria-label="Filter by location">
            <option value="All">All Locations</option>
            {locations.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>

          <input type="date" className="table-date-input" value={fFrom} onChange={(e) => { setFFrom(e.target.value); resetPage(); }} aria-label="From date" />
          <span style={{ fontSize: 11, color: "var(--text-muted)", flexShrink: 0 }}>to</span>
          <input type="date" className="table-date-input" value={fTo} onChange={(e) => { setFTo(e.target.value); resetPage(); }} aria-label="To date" />

          {hasFilter && (
            <button className="filter-btn" onClick={clearFilters} aria-label="Clear all filters">
              Clear filters
            </button>
          )}
        </div>

        {/* Table */}
        <div className="table-scroll" style={{ maxHeight: 540 }}>
          {filtered.length === 0 ? (
            <div className="empty-state" style={{ padding: "48px 20px" }}>
              <p>No records match your filters.</p>
              {hasFilter && (
                <p className="empty-hint">
                  <button className="filter-btn" style={{ marginTop: 4 }} onClick={clearFilters}>Clear filters</button>
                </p>
              )}
            </div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Project</th>
                  <th scope="col">Activity</th>
                  <th scope="col">Stage</th>
                  <th scope="col">Supervisor</th>
                  <th scope="col">Date Updated</th>
                  <th scope="col">Status</th>
                  <th scope="col">Progress</th>
                  <th scope="col">Location</th>
                </tr>
              </thead>
              <tbody>
                {pageItems.map((r, i) => (
                  <tr key={r.objectid ?? i}>
                    <td className="bold">{r._project    || "—"}</td>
                    <td>{r._activity   || "—"}</td>
                    <td>{r._stage      || "—"}</td>
                    <td>{r._supervisor || "—"}</td>
                    <td className="mono" style={{ whiteSpace: "nowrap" }}>{r._dateStr}</td>
                    <td><StatusBadge status={r._status} /></td>
                    <td><ProgressCell value={r._progress} /></td>
                    <td>{r._location   || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <Pagination page={safePage} totalPages={totalPages} onChange={setPage} />
      </section>

    </div>
  );
}

export default WorkSchedule;
