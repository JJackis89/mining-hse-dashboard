import { useEffect, useState, useMemo } from "react";
import { getIssuances, getReceipts, getAllInventoryItems } from "../services/issuanceService";
import { getSuppliers } from "../services/supplierService";
import { exportToCsv } from "../utils/exportCsv";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend,
} from "recharts";

const COLORS = ["#B8881A", "#1A74BC", "#1E9E52", "#7D3C98", "#C0392B", "#D4820A", "#17A589", "#E67E22"];
const TOOLTIP_STYLE = {
  background: "#ffffff", border: "1px solid #DDE1E8",
  borderRadius: 6, fontSize: 12, color: "#1A2332",
};

function fmt(ts) {
  if (!ts) return "—";
  const d = ts?.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

const ISSUANCE_CSV = [
  { key: "issueRefNumber",  label: "Ref No." },
  { key: "dateOfIssuance",  label: "Date" },
  { key: "materialName",    label: "Material" },
  { key: "category",        label: "Category" },
  { key: "qtyIssued",       label: "Qty" },
  { key: "unit",            label: "Unit" },
  { key: "projectCode",     label: "Project" },
  { key: "issuedTo",        label: "Issued To" },
  { key: "department",      label: "Department" },
  { key: "purpose",         label: "Purpose" },
  { key: "approvalStatus",  label: "Approval" },
  { key: "issuedByEmail",   label: "Issued By" },
];

function Reports() {
  const [issuances, setIssuances]         = useState([]);
  const [receipts, setReceipts]           = useState([]);
  const [suppliers, setSuppliers]         = useState([]);
  const [inventoryItems, setInventoryItems] = useState([]);
  const [loading, setLoading]             = useState(true);
  const [error, setError]                 = useState(null);
  const [activeTab, setActiveTab]         = useState("projects");
  const [filterProject, setFilterProject] = useState("All");
  const [filterDept, setFilterDept]       = useState("All");
  const [filterItemType, setFilterItemType] = useState("All");
  const [dateFrom, setDateFrom]           = useState("");
  const [dateTo, setDateTo]               = useState("");
  const [now]                             = useState(() => Date.now());

  useEffect(() => {
    Promise.all([getIssuances(), getReceipts(), getSuppliers(), getAllInventoryItems()])
      .then(([i, r, s, items]) => { setIssuances(i); setReceipts(r); setSuppliers(s); setInventoryItems(items); })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const itemTypeMap = useMemo(() =>
    Object.fromEntries(inventoryItems.map((i) => [i.materialName, i.itemType || "Consumable"])),
  [inventoryItems]);

  // Filter issuances by date range, project, dept, and item type
  const filteredIssuances = useMemo(() => {
    return issuances.filter((i) => {
      const approved = !i.approvalStatus || i.approvalStatus === "approved" || i.approvalStatus === "auto-approved";
      if (!approved) return false;
      if (filterProject !== "All" && (i.projectCode || "Unassigned") !== filterProject) return false;
      if (filterDept !== "All" && i.department !== filterDept) return false;
      if (filterItemType !== "All" && (itemTypeMap[i.materialName] || "Consumable") !== filterItemType) return false;
      if (dateFrom) {
        const d = i.issuedAt?.toDate ? i.issuedAt.toDate() : new Date(i.dateOfIssuance || 0);
        if (d < new Date(dateFrom)) return false;
      }
      if (dateTo) {
        const d = i.issuedAt?.toDate ? i.issuedAt.toDate() : new Date(i.dateOfIssuance || 0);
        if (d > new Date(dateTo + "T23:59:59")) return false;
      }
      return true;
    });
  }, [issuances, filterProject, filterDept, filterItemType, dateFrom, dateTo, itemTypeMap]);

  // Project cost allocation
  const projectData = useMemo(() => {
    const map = {};
    filteredIssuances.forEach((i) => {
      const proj = i.projectCode?.trim() || "Unassigned";
      if (!map[proj]) map[proj] = { project: proj, totalQty: 0, issuances: 0, materials: new Set() };
      map[proj].totalQty  += Number(i.qtyIssued) || 0;
      map[proj].issuances += 1;
      if (i.materialName) map[proj].materials.add(i.materialName);
    });
    return Object.values(map)
      .map((p) => ({ ...p, materials: p.materials.size }))
      .sort((a, b) => b.totalQty - a.totalQty);
  }, [filteredIssuances]);

  // Department consumption
  const deptData = useMemo(() => {
    const map = {};
    filteredIssuances.forEach((i) => {
      const dept = i.department || "Unknown";
      map[dept] = (map[dept] || 0) + (Number(i.qtyIssued) || 0);
    });
    return Object.entries(map).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  }, [filteredIssuances]);

  // Material consumption
  const materialData = useMemo(() => {
    const map = {};
    filteredIssuances.forEach((i) => {
      const name = i.materialName || "Unknown";
      map[name] = (map[name] || 0) + (Number(i.qtyIssued) || 0);
    });
    return Object.entries(map).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value).slice(0, 10);
  }, [filteredIssuances]);

  // Supplier delivery performance
  const supplierData = useMemo(() => {
    const supplierMap = Object.fromEntries(suppliers.map((s) => [s.id, s.name]));
    const map = {};
    receipts.forEach((r) => {
      const name = (r.supplierId && supplierMap[r.supplierId]) || r.supplier || "Unknown";
      if (!map[name]) map[name] = { name, deliveries: 0, totalQty: 0 };
      map[name].deliveries += 1;
      map[name].totalQty   += Number(r.quantity_received) || 0;
    });
    return Object.values(map).sort((a, b) => b.deliveries - a.deliveries);
  }, [receipts, suppliers]);

  // Expiry alerts (receipts with expiryDate in next 60 days)
  const expiryAlerts = useMemo(() => {
    const cutoff = now + 60 * 24 * 60 * 60 * 1000;
    return receipts
      .filter((r) => r.expiryDate && r.expiryDate <= cutoff)
      .sort((a, b) => a.expiryDate - b.expiryDate);
  }, [receipts, now]);

  const allProjects = useMemo(() => {
    const set = new Set(issuances.map((i) => i.projectCode?.trim() || "Unassigned").filter(Boolean));
    return ["All", ...Array.from(set).sort()];
  }, [issuances]);

  const allDepts = useMemo(() => {
    const set = new Set(issuances.map((i) => i.department).filter(Boolean));
    return ["All", ...Array.from(set).sort()];
  }, [issuances]);

  if (loading) return <div className="loading-state" style={{ minHeight: 300 }}><div className="spinner" /><p>Loading reports…</p></div>;
  if (error)   return <div className="error-state"><span className="error-icon">!</span><p>{error}</p></div>;

  return (
    <div className="page-reports">
      {/* KPI Summary */}
      <section className="kpi-grid" style={{ marginBottom: 20 }}>
        <div className="kpi-card">
          <div className="kpi-icon" style={{ background: "rgba(184,136,26,0.1)", color: "#B8881A" }} />
          <div className="kpi-data">
            <span className="kpi-value">{filteredIssuances.length}</span>
            <span className="kpi-title">Issuances</span>
            <span className="kpi-trend">Approved transactions</span>
          </div>
        </div>
        <div className="kpi-card">
          <div className="kpi-icon" style={{ background: "rgba(26,116,188,0.1)", color: "#1A74BC" }} />
          <div className="kpi-data">
            <span className="kpi-value">{inventoryItems.filter((i) => (i.itemType || "Consumable") === "Consumable").length}</span>
            <span className="kpi-title">Consumables</span>
            <span className="kpi-trend">Replenishable stock items</span>
          </div>
        </div>
        <div className="kpi-card">
          <div className="kpi-icon" style={{ background: "rgba(125,60,152,0.1)", color: "#7D3C98" }} />
          <div className="kpi-data">
            <span className="kpi-value">{inventoryItems.filter((i) => i.itemType === "Non-Consumable").length}</span>
            <span className="kpi-title">Fixed Assets</span>
            <span className="kpi-trend">Non-consumable equipment</span>
          </div>
        </div>
        <div className="kpi-card">
          <div className="kpi-icon" style={{ background: expiryAlerts.filter((r) => r.expiryDate <= now).length > 0 ? "rgba(220,53,69,0.1)" : "rgba(30,158,82,0.1)", color: expiryAlerts.filter((r) => r.expiryDate <= now).length > 0 ? "#dc3545" : "#1E9E52" }} />
          <div className="kpi-data">
            <span className="kpi-value">{expiryAlerts.filter((r) => r.expiryDate <= now).length}</span>
            <span className="kpi-title">Expired Items</span>
            <span className="kpi-trend">Require action</span>
          </div>
        </div>
      </section>

      {/* Filter bar */}
      <div className="report-filter-bar">
        <select className="admin-role-select" value={filterItemType} onChange={(e) => setFilterItemType(e.target.value)}>
          <option value="All">All Types</option>
          <option value="Consumable">Consumables</option>
          <option value="Non-Consumable">Non-Consumables (Assets)</option>
        </select>
        <select className="admin-role-select" value={filterProject} onChange={(e) => setFilterProject(e.target.value)}>
          {allProjects.map((p) => <option key={p} value={p}>{p === "All" ? "All Projects" : p}</option>)}
        </select>
        <select className="admin-role-select" value={filterDept} onChange={(e) => setFilterDept(e.target.value)}>
          {allDepts.map((d) => <option key={d} value={d}>{d === "All" ? "All Departments" : d}</option>)}
        </select>
        <input type="date" className="issuance-input" style={{ width: 150 }} value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)} placeholder="From" />
        <input type="date" className="issuance-input" style={{ width: 150 }} value={dateTo}
          onChange={(e) => setDateTo(e.target.value)} placeholder="To" />
        {(filterItemType !== "All" || filterProject !== "All" || filterDept !== "All" || dateFrom || dateTo) && (
          <button className="photo-view-btn" onClick={() => { setFilterItemType("All"); setFilterProject("All"); setFilterDept("All"); setDateFrom(""); setDateTo(""); }}>
            Clear
          </button>
        )}
        <button className="export-btn" style={{ marginLeft: "auto" }}
          onClick={() => exportToCsv("issuances-report.csv", filteredIssuances, ISSUANCE_CSV)}
          disabled={!filteredIssuances.length}>
          Export CSV
        </button>
      </div>

      {/* Tab navigation */}
      <div className="inv-tab-bar" style={{ marginBottom: 16 }} role="tablist">
        {[
          { id: "projects",   label: "Project Allocation" },
          { id: "materials",  label: "Material Consumption" },
          { id: "suppliers",  label: "Supplier Performance" },
          { id: "expiry",     label: `Expiry Alerts${expiryAlerts.length > 0 ? ` (${expiryAlerts.length})` : ""}` },
        ].map((t) => (
          <button key={t.id} role="tab" aria-selected={activeTab === t.id}
            className={`inv-tab-btn ${activeTab === t.id ? "inv-tab-btn--active" : ""}`}
            onClick={() => setActiveTab(t.id)}>{t.label}</button>
        ))}
      </div>

      {/* Project Allocation */}
      {activeTab === "projects" && (
        <div className="report-grid">
          <section className="panel chart-panel">
            <div className="panel-header"><h3>Issuances by Project</h3></div>
            <div className="chart-wrap">
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={projectData.slice(0, 8)} margin={{ top: 8, right: 12, bottom: 40, left: -20 }}>
                  <XAxis dataKey="project" tick={{ fill: "#8B96A6", fontSize: 10 }} angle={-30} textAnchor="end" />
                  <YAxis allowDecimals={false} tick={{ fill: "#8B96A6", fontSize: 11 }} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} />
                  <Bar dataKey="totalQty" name="Total Qty" fill="#B8881A" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section className="panel">
            <div className="panel-header"><h3>Project Detail</h3><span className="panel-badge">{projectData.length} projects</span></div>
            <div className="table-scroll">
              <table className="data-table">
                <thead><tr><th>Project / Cost Centre</th><th>Issuances</th><th>Total Qty</th><th>Materials</th></tr></thead>
                <tbody>
                  {projectData.map((p) => (
                    <tr key={p.project}>
                      <td className="bold">{p.project}</td>
                      <td className="mono">{p.issuances}</td>
                      <td className="mono">{p.totalQty.toLocaleString()}</td>
                      <td className="mono">{p.materials}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}

      {/* Material Consumption */}
      {activeTab === "materials" && (
        <div className="report-grid">
          <section className="panel chart-panel">
            <div className="panel-header"><h3>Top 10 Materials by Qty Issued</h3></div>
            <div className="chart-wrap">
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={materialData} layout="vertical" margin={{ top: 8, right: 24, bottom: 0, left: 120 }}>
                  <XAxis type="number" tick={{ fill: "#8B96A6", fontSize: 11 }} />
                  <YAxis type="category" dataKey="name" tick={{ fill: "#4D5A6E", fontSize: 11 }} width={120} />
                  <Tooltip contentStyle={TOOLTIP_STYLE} />
                  <Bar dataKey="value" name="Qty Issued" fill="#1A74BC" radius={[0, 3, 3, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section className="panel chart-panel">
            <div className="panel-header"><h3>Consumption by Department</h3></div>
            <div className="chart-wrap">
              {deptData.length === 0 ? <div className="empty-state"><p>No data.</p></div> : (
                <ResponsiveContainer width="100%" height={280}>
                  <PieChart>
                    <Pie data={deptData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={90} label>
                      {deptData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                    </Pie>
                    <Tooltip contentStyle={TOOLTIP_STYLE} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </div>
          </section>
        </div>
      )}

      {/* Supplier Performance */}
      {activeTab === "suppliers" && (
        <section className="panel">
          <div className="panel-header"><h3>Supplier Delivery History</h3><span className="panel-badge">{supplierData.length} suppliers</span></div>
          {supplierData.length === 0 ? (
            <div className="empty-state"><p>No delivery data. Link suppliers to receipts in Inventory.</p></div>
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <thead><tr><th>Supplier</th><th>Deliveries</th><th>Total Qty Delivered</th></tr></thead>
                <tbody>
                  {supplierData.map((s) => (
                    <tr key={s.name}>
                      <td className="bold">{s.name}</td>
                      <td className="mono">{s.deliveries}</td>
                      <td className="mono">{s.totalQty.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* Expiry Alerts */}
      {activeTab === "expiry" && (
        <section className="panel">
          <div className="panel-header">
            <h3>Expiry Alerts</h3>
            <span className="panel-badge">{expiryAlerts.length} items expiring within 60 days</span>
          </div>
          {expiryAlerts.length === 0 ? (
            <div className="empty-state"><p>No items expiring in the next 60 days.</p></div>
          ) : (
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr><th>Material</th><th>Category</th><th>Qty</th><th>Unit</th><th>Supplier</th><th>Expiry Date</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {expiryAlerts.map((r) => {
                    const isExpired = r.expiryDate <= now;
                    const daysLeft  = Math.ceil((r.expiryDate - now) / (24 * 60 * 60 * 1000));
                    return (
                      <tr key={r.id}>
                        <td className="bold">{r.material_name || "—"}</td>
                        <td>{r.category || "—"}</td>
                        <td className="mono">{r.quantity_received ?? "—"}</td>
                        <td>{r.unit || "—"}</td>
                        <td>{r.supplier || "—"}</td>
                        <td className="mono">{fmt(r.expiryDate)}</td>
                        <td>
                          <span className={`feat-expiry-badge feat-expiry-badge--${isExpired ? "expired" : daysLeft <= 14 ? "critical" : "warning"}`}>
                            {isExpired ? "Expired" : `${daysLeft}d left`}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

export default Reports;
