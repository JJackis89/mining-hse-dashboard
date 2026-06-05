import { useEffect, useState } from "react";
import { getMaterials } from "../services/arcgisService";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
} from "recharts";

const TOOLTIP_STYLE = {
  background: "#ffffff",
  border: "1px solid #DDE1E8",
  borderRadius: 6,
  fontSize: 12,
  color: "#1A2332",
};

const CAT_COLORS = ["#B8881A", "#1A74BC", "#1E9E52", "#7D3C98", "#C0392B", "#D4820A"];
const PAGE_SIZE = 10;

function fmt(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}


function Pagination({ page, totalPages, onChange }) {
  if (totalPages <= 1) return null;
  const pages = Array.from({ length: totalPages }, (_, i) => i + 1);
  const visible = pages.filter((p) => p === 1 || p === totalPages || Math.abs(p - page) <= 1);
  return (
    <div className="pagination" role="navigation" aria-label="Table pagination">
      <span className="pagination-info">Page {page} of {totalPages}</span>
      <div className="pagination-controls">
        <button
          className="pagination-btn"
          onClick={() => onChange(page - 1)}
          disabled={page === 1}
          aria-label="Previous page"
        >&#8249;</button>
        {visible.reduce((acc, p, i) => {
          if (i > 0 && p - visible[i - 1] > 1) acc.push(<span key={`gap-${p}`} style={{ padding: "4px 6px", color: "var(--text-muted)" }}>…</span>);
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
        <button
          className="pagination-btn"
          onClick={() => onChange(page + 1)}
          disabled={page === totalPages}
          aria-label="Next page"
        >&#8250;</button>
      </div>
    </div>
  );
}

function Dashboard() {
  const [materials, setMaterials] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);
  const [page, setPage]           = useState(1);

  useEffect(() => {
    let cancelled = false;
    getMaterials()
      .then((rows) => {
        if (!cancelled) setMaterials(rows.map((r) => ({
          ...r,
          _total: r.quantity_received != null && r.unit_cost != null
            ? r.quantity_received * r.unit_cost : null,
        })));
      })
      .catch((err) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return (
      <div className="page-dashboard">
        <div className="loading-state"><div className="spinner" /><p>Loading dashboard…</p></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="page-dashboard">
        <div className="error-state">
          <span className="error-icon" role="img" aria-label="Error">!</span>
          <p>Failed to load dashboard data</p>
          <p className="error-detail">{error}</p>
        </div>
      </div>
    );
  }

  // ── Aggregates ────────────────────────────────────────────
  const totalReceipts = materials.length;
  const totalQty      = materials.reduce((s, r) => s + (r.quantity_received || 0), 0);
  const matCategories = new Set(materials.map((r) => r.category).filter(Boolean)).size;
  const matSuppliers  = new Set(materials.map((r) => r.supplier).filter(Boolean)).size;

  const sorted = [...materials].sort((a, b) => (b.date_time_received || 0) - (a.date_time_received || 0));
  const totalPages   = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage     = Math.min(page, totalPages);
  const pageItems    = sorted.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  // Monthly receipts trend
  const monthMap = {};
  const now = new Date();
  for (let m = 5; m >= 0; m--) {
    const d = new Date(now.getFullYear(), now.getMonth() - m, 1);
    const key = d.toLocaleDateString("en-GB", { month: "short", year: "2-digit" });
    monthMap[key] = { month: key, Receipts: 0 };
  }
  materials.forEach((r) => {
    const key = r.date_time_received
      ? new Date(r.date_time_received).toLocaleDateString("en-GB", { month: "short", year: "2-digit" })
      : null;
    if (key && monthMap[key]) monthMap[key].Receipts++;
  });
  const trendData = Object.values(monthMap);

  // Receipts by category
  const catCounts = {};
  materials.forEach((r) => { const c = r.category || "Other"; catCounts[c] = (catCounts[c] || 0) + 1; });
  const catData = Object.entries(catCounts).map(([name, value]) => ({ name, value }));


  return (
    <div className="page-dashboard">

      {/* ══ KPI Cards ══════════════════════════════════════ */}
      <section className="kpi-grid" aria-label="Key performance indicators">
        {[
          { title: "Total Receipts", value: totalReceipts,             sub: "Inventory entries",       color: "#B8881A" },
          { title: "Categories",     value: matCategories,             sub: "Distinct material types", color: "#1A74BC" },
          { title: "Total Qty",      value: totalQty.toLocaleString(), sub: "Units received",          color: "#1E9E52" },
          { title: "Suppliers",      value: matSuppliers,              sub: "Unique suppliers",        color: "#7D3C98" },
        ].map((kpi, i) => (
          <div className="kpi-card" key={i}>
            <div className="kpi-icon" style={{ background: kpi.color + "18", color: kpi.color }} aria-hidden="true" />
            <div className="kpi-data">
              <span className="kpi-value">{kpi.value}</span>
              <span className="kpi-title">{kpi.title}</span>
              <span className="kpi-trend">{kpi.sub}</span>
            </div>
          </div>
        ))}
      </section>

      {/* ══ Charts ══════════════════════════════════════════ */}
      <div className="dashboard-charts" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>

        <section className="panel chart-panel" aria-label="Monthly receipts trend">
          <div className="panel-header"><h3>Monthly Receipts (6 Months)</h3></div>
          <div className="chart-wrap">
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={trendData} margin={{ top: 8, right: 12, bottom: 0, left: -20 }}>
                <XAxis dataKey="month" tick={{ fill: "#8B96A6", fontSize: 11 }} />
                <YAxis allowDecimals={false} tick={{ fill: "#8B96A6", fontSize: 11 }} />
                <Tooltip contentStyle={TOOLTIP_STYLE} />
                <Bar dataKey="Receipts" fill="#B8881A" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>

        <section className="panel chart-panel" aria-label="Receipts by category">
          <div className="panel-header"><h3>Receipts by Category</h3></div>
          <div className="chart-wrap">
            {catData.length === 0 ? (
              <div className="empty-state" style={{ minHeight: 220 }}><p>No data yet.</p></div>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <PieChart>
                  <Pie data={catData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={75} label>
                    {catData.map((_, idx) => (
                      <Cell key={idx} fill={CAT_COLORS[idx % CAT_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={TOOLTIP_STYLE} />
                  <Legend wrapperStyle={{ fontSize: 11, color: "#4D5A6E" }} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>
        </section>


      </div>

      {/* ══ Recent Receipts table ════════════════════════════ */}
      <section className="panel" aria-label="Materials receipts table">
        <div className="panel-header">
          <h3>Materials Receipts</h3>
          <span className="panel-badge">{totalReceipts} total</span>
        </div>
        {sorted.length === 0 ? (
          <div className="empty-state" style={{ padding: "32px 16px" }}>
            <p>No receipts yet.</p>
            <p className="empty-hint">Submit via the Survey123 Materials Receipt form.</p>
          </div>
        ) : (
          <>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">Material</th>
                    <th scope="col">Category</th>
                    <th scope="col">Qty</th>
                    <th scope="col">Unit</th>
                    <th scope="col">Supplier</th>
                    <th scope="col">Received By</th>
                  </tr>
                </thead>
                <tbody>
                  {pageItems.map((r) => (
                    <tr key={r.objectid}>
                      <td className="mono" style={{ whiteSpace: "nowrap" }}>{fmt(r.date_time_received)}</td>
                      <td className="bold">{r.material_name || "—"}</td>
                      <td>{r.category || "—"}</td>
                      <td className="mono">{r.quantity_received ?? "—"}</td>
                      <td>{r.unit || "—"}</td>
                      <td>{r.supplier || "—"}</td>
                      <td>{r.received_by || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination page={safePage} totalPages={totalPages} onChange={setPage} />
          </>
        )}
      </section>

    </div>
  );
}

export default Dashboard;
