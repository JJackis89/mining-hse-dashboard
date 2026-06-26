import { useEffect, useState, useMemo } from "react";
import { getReceipts, getIssuanceTotals, getAdjustments, getAllInventoryItems } from "../services/issuanceService";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
} from "recharts";

const TOOLTIP_STYLE = {
  background: "#ffffff", border: "1px solid #DDE1E8",
  borderRadius: 6, fontSize: 12, color: "#1A2332",
};
const CAT_COLORS = ["#B8881A", "#1A74BC", "#1E9E52", "#7D3C98", "#C0392B", "#D4820A"];
const ADJ_ADDS   = new Set(["Correction (Add)", "Transfer In"]);
const PAGE_SIZE  = 10;

function fmt(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function Pagination({ page, totalPages, onChange }) {
  if (totalPages <= 1) return null;
  const pages   = Array.from({ length: totalPages }, (_, i) => i + 1);
  const visible = pages.filter((p) => p === 1 || p === totalPages || Math.abs(p - page) <= 1);
  return (
    <div className="pagination" role="navigation" aria-label="Pagination">
      <span className="pagination-info">Page {page} of {totalPages}</span>
      <div className="pagination-controls">
        <button className="pagination-btn" onClick={() => onChange(page - 1)} disabled={page === 1}>&#8249;</button>
        {visible.reduce((acc, p, i) => {
          if (i > 0 && p - visible[i - 1] > 1) acc.push(<span key={`g-${p}`} style={{ padding: "4px 6px", color: "var(--text-muted)" }}>…</span>);
          acc.push(<button key={p} className={`pagination-btn ${p === page ? "pagination-btn--active" : ""}`} onClick={() => onChange(p)}>{p}</button>);
          return acc;
        }, [])}
        <button className="pagination-btn" onClick={() => onChange(page + 1)} disabled={page === totalPages}>&#8250;</button>
      </div>
    </div>
  );
}

function Dashboard() {
  const [receipts, setReceipts]         = useState([]);
  const [issuanceTotals, setTotals]     = useState({});
  const [adjustments, setAdjustments]   = useState([]);
  const [inventoryItems, setItems]      = useState([]);
  const [loading, setLoading]           = useState(true);
  const [error, setError]               = useState(null);
  const [page, setPage]                 = useState(1);
  const [now]                           = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    Promise.all([getReceipts(), getIssuanceTotals(), getAdjustments(), getAllInventoryItems()])
      .then(([r, t, a, items]) => {
        if (cancelled) return;
        setReceipts(r);
        setTotals(t);
        setAdjustments(a);
        setItems(items);
      })
      .catch((err) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // Stock balances per material
  const stockBalances = useMemo(() => {
    const map = {};
    receipts.forEach((r) => {
      const name = r.material_name;
      if (!name) return;
      if (!map[name]) map[name] = { received: 0, issued: 0, adjusted: 0, unit: r.unit || "" };
      map[name].received += Number(r.quantity_received) || 0;
      if (!map[name].unit && r.unit) map[name].unit = r.unit;
    });
    Object.entries(issuanceTotals).forEach(([name, qty]) => {
      if (map[name]) map[name].issued = qty;
    });
    adjustments.forEach((adj) => {
      const name = adj.materialName;
      if (!name) return;
      if (!map[name]) map[name] = { received: 0, issued: 0, adjusted: 0, unit: adj.unit || "" };
      map[name].adjusted += (ADJ_ADDS.has(adj.adjustmentType) ? 1 : -1) * (Number(adj.quantity) || 0);
    });
    return map;
  }, [receipts, issuanceTotals, adjustments]);

  // Low-stock alerts — Consumables only, below reorder point
  const lowStockAlerts = useMemo(() => {
    return inventoryItems
      .filter((item) => (item.itemType || "Consumable") === "Consumable")
      .map((item) => {
        const bal = stockBalances[item.materialName];
        if (!bal) return null;
        const balance = bal.received + bal.adjusted - bal.issued;
        const rp = Number(item.reorderPoint) || 0;
        if (balance <= rp) return { ...item, balance, reorderPoint: rp };
        return null;
      })
      .filter(Boolean)
      .sort((a, b) => a.balance - b.balance);
  }, [inventoryItems, stockBalances]);

  // Expiry alerts — receipts expiring within 30 days
  const expiryAlerts = useMemo(() => {
    const cutoff = now + 30 * 24 * 60 * 60 * 1000;
    return receipts
      .filter((r) => r.expiryDate && r.expiryDate <= cutoff)
      .sort((a, b) => a.expiryDate - b.expiryDate)
      .slice(0, 5);
  }, [receipts, now]);

  // KPI aggregates
  const totalReceipts  = receipts.length;
  const totalQty       = receipts.reduce((s, r) => s + (r.quantity_received || 0), 0);
  const matCategories  = new Set(receipts.map((r) => r.category).filter(Boolean)).size;
  const matSuppliers   = new Set(receipts.map((r) => r.supplier).filter(Boolean)).size;

  // Monthly trend (last 6 months)
  const trendData = useMemo(() => {
    const now     = new Date();
    const monthMap = {};
    for (let m = 5; m >= 0; m--) {
      const d   = new Date(now.getFullYear(), now.getMonth() - m, 1);
      const key = d.toLocaleDateString("en-GB", { month: "short", year: "2-digit" });
      monthMap[key] = { month: key, Receipts: 0 };
    }
    receipts.forEach((r) => {
      const ts  = r.date_time_received;
      const key = ts ? new Date(ts).toLocaleDateString("en-GB", { month: "short", year: "2-digit" }) : null;
      if (key && monthMap[key]) monthMap[key].Receipts++;
    });
    return Object.values(monthMap);
  }, [receipts]);

  // Category breakdown
  const catData = useMemo(() => {
    const map = {};
    receipts.forEach((r) => { const c = r.category || "Other"; map[c] = (map[c] || 0) + 1; });
    return Object.entries(map).map(([name, value]) => ({ name, value }));
  }, [receipts]);

  // Recent receipts table
  const sorted     = useMemo(() => [...receipts].sort((a, b) => (b.date_time_received ?? 0) - (a.date_time_received ?? 0)), [receipts]);
  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage   = Math.min(page, totalPages);
  const pageItems  = sorted.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  if (loading) return <div className="page-dashboard"><div className="loading-state"><div className="spinner" /><p>Loading dashboard…</p></div></div>;
  if (error)   return <div className="page-dashboard"><div className="error-state"><span className="error-icon">!</span><p>Failed to load dashboard</p><p className="error-detail">{error}</p></div></div>;

  return (
    <div className="page-dashboard">

      {/* ── Alert banners ─────────────────────────── */}
      {(lowStockAlerts.length > 0 || expiryAlerts.length > 0) && (
        <div className="dash-alert-row">
          {lowStockAlerts.length > 0 && (
            <div className="dash-alert-card dash-alert-card--warn">
              <div className="dash-alert-header">
                <span className="dash-alert-icon">⚠</span>
                <strong>{lowStockAlerts.length} Low Stock Alert{lowStockAlerts.length !== 1 ? "s" : ""} — Consumables</strong>
              </div>
              <ul className="dash-alert-list">
                {lowStockAlerts.slice(0, 4).map((item) => (
                  <li key={item.id}>
                    <span className="bold">{item.materialName}</span>
                    <span style={{ color: item.balance <= 0 ? "#dc3545" : "var(--warning)", marginLeft: 8 }}>
                      {item.balance <= 0 ? "Out of stock" : `${item.balance} ${item.unit} (reorder ≤ ${item.reorderPoint})`}
                    </span>
                  </li>
                ))}
                {lowStockAlerts.length > 4 && <li style={{ color: "var(--text-muted)", fontStyle: "italic" }}>+{lowStockAlerts.length - 4} more…</li>}
              </ul>
            </div>
          )}
          {expiryAlerts.length > 0 && (
            <div className="dash-alert-card dash-alert-card--danger">
              <div className="dash-alert-header">
                <span className="dash-alert-icon">⏱</span>
                <strong>{expiryAlerts.length} Item{expiryAlerts.length !== 1 ? "s" : ""} Expiring Soon</strong>
              </div>
              <ul className="dash-alert-list">
                {expiryAlerts.map((r) => {
                  const isExpired = r.expiryDate <= now;
                  const daysLeft  = Math.ceil((r.expiryDate - now) / (24 * 60 * 60 * 1000));
                  return (
                    <li key={r.id}>
                      <span className="bold">{r.material_name}</span>
                      <span style={{ color: isExpired ? "#dc3545" : "#D4820A", marginLeft: 8 }}>
                        {isExpired ? "Expired" : `expires in ${daysLeft}d`}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}

      {/* ── KPI Cards ──────────────────────────────── */}
      <section className="kpi-grid" aria-label="Key performance indicators">
        {[
          { title: "Total Receipts",  value: totalReceipts,             sub: "Inventory entries",       color: "#B8881A" },
          { title: "Categories",      value: matCategories,             sub: "Distinct material types", color: "#1A74BC" },
          { title: "Total Qty",       value: totalQty.toLocaleString(), sub: "Units received",          color: "#1E9E52" },
          { title: "Suppliers",       value: matSuppliers,              sub: "Unique suppliers",        color: "#7D3C98" },
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

      {/* ── Charts ─────────────────────────────────── */}
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
                    {catData.map((_, idx) => <Cell key={idx} fill={CAT_COLORS[idx % CAT_COLORS.length]} />)}
                  </Pie>
                  <Tooltip contentStyle={TOOLTIP_STYLE} />
                  <Legend wrapperStyle={{ fontSize: 11, color: "#4D5A6E" }} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>
        </section>
      </div>

      {/* ── Recent Receipts ─────────────────────────── */}
      <section className="panel" aria-label="Materials receipts table">
        <div className="panel-header">
          <h3>Materials Receipts</h3>
          <span className="panel-badge">{totalReceipts} total</span>
        </div>
        {sorted.length === 0 ? (
          <div className="empty-state" style={{ padding: "32px 16px" }}>
            <p>No receipts yet.</p>
            <p className="empty-hint">Use Add Receipt in Inventory to record goods received.</p>
          </div>
        ) : (
          <>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Date</th><th>Material</th><th>Category</th>
                    <th>Qty</th><th>Unit</th><th>Supplier</th><th>Received By</th>
                  </tr>
                </thead>
                <tbody>
                  {pageItems.map((r) => (
                    <tr key={r.id}>
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
