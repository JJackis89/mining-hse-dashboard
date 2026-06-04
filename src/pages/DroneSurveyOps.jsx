import { useEffect, useState } from "react";
import { getDroneSurveySubmissions } from "../services/arcgisService";

// Single real aircraft — update fields here as the fleet grows
const DRONE_FLEET = [
  {
    id:      "UAV-001",
    name:    "DJI Mavic 3E",
    payload: "Hasselblad L2D-20c (20 MP, 4/3 CMOS)",
    status:  "Active",
  },
];

// ─── Helpers ──────────────────────────────────────────────────
function fmt(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function fmtDateTime(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

// ─── Survey123 Feed ───────────────────────────────────────────
function Survey123Feed({ submissions, loading }) {
  if (loading) {
    return (
      <div className="loading-state" style={{ minHeight: 200 }}>
        <div className="spinner" aria-label="Loading" />
        <p>Checking for Survey123 submissions…</p>
      </div>
    );
  }

  // Form not yet connected
  if (submissions === null) {
    return (
      <div className="s123-connect-panel">
        <div className="s123-connect-icon" aria-hidden="true">📋</div>
        <h3 className="s123-connect-title">Survey123 Form Not Yet Connected</h3>
        <p className="s123-connect-body">
          Once you have published your Drone &amp; Survey Operations form in ArcGIS Online,
          paste the Feature Service URL into <code>arcgisService.js</code> to start
          receiving submissions here automatically.
        </p>

        <div className="s123-steps">
          <div className="s123-step">
            <span className="s123-step-num">1</span>
            <div className="s123-step-body">
              <strong>Create your Survey123 form</strong>
              <span>Build the Drone &amp; Survey Operations form in Survey123 Connect or the web designer. Recommended fields are listed below.</span>
            </div>
          </div>
          <div className="s123-step">
            <span className="s123-step-num">2</span>
            <div className="s123-step-body">
              <strong>Publish and copy the Feature Service URL</strong>
              <span>In ArcGIS Online open the form's Feature Layer → Overview → copy the REST endpoint (ends in <code>/FeatureServer/0</code>).</span>
            </div>
          </div>
          <div className="s123-step">
            <span className="s123-step-num">3</span>
            <div className="s123-step-body">
              <strong>Set <code>DRONE_SURVEY_URL</code> in arcgisService.js</strong>
              <span>Replace <code>null</code> with your copied URL. The feed and notification bell activate on the next page load.</span>
            </div>
          </div>
        </div>

        <div className="s123-fields-guide">
          <h4 className="s123-fields-title">Recommended form fields</h4>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Field name</th>
                  <th scope="col">Type</th>
                  <th scope="col">Description</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ["operation_type", "Select one",  "Drone Flight / Ground Survey"],
                  ["operator_name",  "Text",        "Name of operator or survey crew lead"],
                  ["equipment_id",   "Text",        "UAV ID or instrument serial (e.g. UAV-001)"],
                  ["flight_date",    "Date / Time", "Date and start time of the operation"],
                  ["area_covered",   "Text",        "Area name or polygon reference (e.g. Pit 4 Floor)"],
                  ["datum",          "Select one",  "WGS84 / UTM 30N, Local Mine Grid, etc."],
                  ["status",         "Select one",  "Planned / In Progress / Complete / Cancelled"],
                  ["remarks",        "Multiline",   "Field notes, conditions, issues encountered"],
                  ["location",       "Geopoint",    "GPS point captured at start of operation"],
                ].map(([name, type, desc]) => (
                  <tr key={name}>
                    <td className="mono bold">{name}</td>
                    <td>{type}</td>
                    <td style={{ color: "var(--text-muted)", fontSize: 12 }}>{desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  }

  // Connected but empty
  if (submissions.length === 0) {
    return (
      <div className="empty-state" style={{ padding: "60px 20px" }}>
        <p>No submissions in the last 30 days.</p>
        <p className="empty-hint">Submit an entry via the Survey123 Drone &amp; Survey Operations form.</p>
      </div>
    );
  }

  // Live feed
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">Submitted</th>
            <th scope="col">Type</th>
            <th scope="col">Operator</th>
            <th scope="col">Equipment</th>
            <th scope="col">Area</th>
            <th scope="col">Flight Date</th>
            <th scope="col">Datum</th>
            <th scope="col">Status</th>
            <th scope="col">Remarks</th>
          </tr>
        </thead>
        <tbody>
          {submissions.map((r) => (
            <tr key={r.objectid}>
              <td className="mono" style={{ whiteSpace: "nowrap" }}>{fmtDateTime(r.CreationDate)}</td>
              <td>{r.operation_type || "—"}</td>
              <td>{r.operator_name  || "—"}</td>
              <td className="mono">{r.equipment_id || "—"}</td>
              <td>{r.area_covered   || "—"}</td>
              <td className="mono">{fmt(r.flight_date)}</td>
              <td>{r.datum          || "—"}</td>
              <td>
                {r.status
                  ? <span className={`status-pill status-pill--${r.status.toLowerCase().replace(/\s+/g, "-")}`}>{r.status}</span>
                  : "—"}
              </td>
              <td style={{ maxWidth: 220, whiteSpace: "normal", lineHeight: 1.4, fontSize: 12 }}>
                {r.remarks || "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Tabs ─────────────────────────────────────────────────────
const TABS = [
  { key: "survey123", label: "Survey123 Feed"  },
  { key: "fleet",     label: "Drone Fleet"     },
  { key: "missions",  label: "Mission Log"     },
  { key: "survey",    label: "Survey Projects" },
];

// ─── Main Page ────────────────────────────────────────────────
function DroneSurveyOps() {
  const [activeTab,    setActiveTab]    = useState("survey123");
  const [submissions,  setSubmissions]  = useState(null);
  const [loadingFeed,  setLoadingFeed]  = useState(true);

  useEffect(() => {
    let cancelled = false;
    getDroneSurveySubmissions()
      .then((rows) => { if (!cancelled) setSubmissions(rows); })
      .catch(() => { if (!cancelled) setSubmissions([]); })
      .finally(() => { if (!cancelled) setLoadingFeed(false); });
    return () => { cancelled = true; };
  }, []);

  const activeCount    = DRONE_FLEET.filter((d) => d.status === "Active").length;
  const s123Connected  = !loadingFeed && submissions !== null;
  const s123Status     = loadingFeed ? "Checking…" : submissions !== null ? "Connected" : "Awaiting Setup";
  const s123StatusColor = loadingFeed ? "#8B96A6" : submissions !== null ? "#1E9E52" : "#D4820A";
  const submissionCount = submissions !== null ? submissions.length : null;

  const kpis = [
    {
      title: "Fleet Size",
      value: DRONE_FLEET.length,
      sub:   "Registered aircraft",
      color: "#B8881A",
    },
    {
      title: "Active Aircraft",
      value: activeCount,
      sub:   "Currently operational",
      color: "#1E9E52",
    },
    {
      title: "Survey123 Form",
      value: s123Status,
      sub:   "Drone & survey data feed",
      color: s123StatusColor,
    },
    {
      title: "Submissions",
      value: s123Connected ? submissionCount : "—",
      sub:   "Past 30 days",
      color: "#1A74BC",
    },
  ];

  return (
    <div className="page-drone-survey">

      {/* ── KPI dashboard ────────────────────────────────── */}
      <section className="kpi-grid" aria-label="Operations summary">
        {kpis.map((kpi) => (
          <div className="kpi-card" key={kpi.title}>
            <div
              className="kpi-icon"
              style={{ background: kpi.color + "18", color: kpi.color }}
              aria-hidden="true"
            />
            <div className="kpi-data">
              <span className="kpi-value" style={{ fontSize: kpi.title === "Survey123 Form" ? 14 : undefined }}>
                {kpi.value}
              </span>
              <span className="kpi-title">{kpi.title}</span>
              <span className="kpi-trend">{kpi.sub}</span>
            </div>
          </div>
        ))}
      </section>

      {/* ── Tabs ─────────────────────────────────────────── */}
      <div className="tab-bar" role="tablist" aria-label="Drone and survey tabs">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            role="tab"
            aria-selected={activeTab === tab.key}
            className={`tab-btn ${activeTab === tab.key ? "tab-btn--active" : ""} ${tab.key === "survey123" ? "tab-btn--highlight" : ""}`}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.key === "survey123" && <span className="tab-s123-dot" aria-hidden="true" />}
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── Survey123 Feed ────────────────────────────────── */}
      {activeTab === "survey123" && (
        <div role="tabpanel" aria-label="Survey123 live feed">
          <Survey123Feed submissions={submissions} loading={loadingFeed} />
        </div>
      )}

      {/* ── Drone Fleet ──────────────────────────────────── */}
      {activeTab === "fleet" && (
        <div className="fleet-grid" role="tabpanel" aria-label="Drone fleet">
          {DRONE_FLEET.map((uav) => (
            <article className="fleet-card" key={uav.id}>
              <div className="fc-header">
                <span className="fc-id">{uav.id}</span>
                <span className={`fc-status fc-status--${uav.status.toLowerCase()}`}>{uav.status}</span>
              </div>
              <h4 className="fc-name">{uav.name}</h4>
              <div className="fc-details">
                <div><span className="fc-label">Payload</span> {uav.payload}</div>
              </div>
            </article>
          ))}
        </div>
      )}

      {/* ── Mission Log ──────────────────────────────────── */}
      {activeTab === "missions" && (
        <div role="tabpanel" aria-label="Mission log">
          <div className="empty-state" style={{ padding: "60px 20px" }}>
            <p>No missions logged yet.</p>
            <p className="empty-hint">Missions will appear here once the Survey123 form is connected and submissions are received.</p>
          </div>
        </div>
      )}

      {/* ── Survey Projects ───────────────────────────────── */}
      {activeTab === "survey" && (
        <div role="tabpanel" aria-label="Survey projects">
          <div className="empty-state" style={{ padding: "60px 20px" }}>
            <p>No survey projects yet.</p>
            <p className="empty-hint">Projects will be listed here once Survey123 data is connected.</p>
          </div>
        </div>
      )}

    </div>
  );
}

export default DroneSurveyOps;
