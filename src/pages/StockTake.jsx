import { useEffect, useState, useMemo, useCallback } from "react";
import { useUser } from "../context/UserContext";
import { usePermissionMatrix } from "../context/PermissionMatrixContext";
import { canPerform } from "../utils/permissions";
import {
  getStockTakes, createStockTake, updateStockTakeItems, completeStockTake,
} from "../services/stockTakeService";
import {
  getReceipts, getIssuanceTotals, getAdjustments, addAdjustment,
} from "../services/issuanceService";

const ADJ_ADDS = new Set(["Correction (Add)", "Transfer In"]);

function todayISO() {
  return new Date().toISOString().split("T")[0];
}

function fmt(ts) {
  if (!ts) return "—";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function StockTake() {
  const user      = useUser();
  const matrix    = usePermissionMatrix();
  const canCreate = canPerform(user, matrix, "stockTake", "create");
  const canEdit   = canPerform(user, matrix, "stockTake", "edit");

  const [takes, setTakes]         = useState([]);
  const [loading, setLoading]     = useState(true);
  const [activeTake, setActiveTake] = useState(null);

  // Stock balance data (for expected quantities)
  const [receipts, setReceipts]           = useState([]);
  const [issuanceTotals, setIssuanceTotals] = useState({});
  const [adjustments, setAdjustments]     = useState([]);
  const [dataLoading, setDataLoading]     = useState(false);

  const [counts, setCounts]       = useState({});    // { materialName: actualCount }
  const [notes, setNotes]         = useState("");
  const [date, setDate]           = useState(todayISO());
  const [saving, setSaving]       = useState(false);
  const [completing, setCompleting] = useState(false);
  const [applyingAdj, setApplyingAdj] = useState(false);
  const [successMsg, setSuccessMsg]   = useState("");
  const [refresh, setRefresh]         = useState(0);

  useEffect(() => {
    setLoading(true);
    getStockTakes()
      .then(setTakes)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [refresh]);

  // Load current stock data whenever we enter/open a stock take
  useEffect(() => {
    if (!activeTake) return;
    setDataLoading(true);
    Promise.all([getReceipts(), getIssuanceTotals(), getAdjustments()])
      .then(([r, t, a]) => { setReceipts(r); setIssuanceTotals(t); setAdjustments(a); })
      .catch(console.error)
      .finally(() => setDataLoading(false));
  }, [activeTake]);

  // Compute expected stock balances per material
  const expectedBalances = useMemo(() => {
    const map = {};
    receipts.forEach((r) => {
      const name = r.material_name;
      if (!name) return;
      if (!map[name]) map[name] = { unit: r.unit || "", received: 0, issued: 0, adjusted: 0 };
      map[name].received += Number(r.quantity_received) || 0;
      if (!map[name].unit && r.unit) map[name].unit = r.unit;
    });
    Object.entries(issuanceTotals).forEach(([name, qty]) => {
      if (map[name]) map[name].issued = qty;
    });
    adjustments.forEach((adj) => {
      const name = adj.materialName;
      if (!name) return;
      if (!map[name]) map[name] = { unit: adj.unit || "", received: 0, issued: 0, adjusted: 0 };
      map[name].adjusted += (ADJ_ADDS.has(adj.adjustmentType) ? 1 : -1) * (Number(adj.quantity) || 0);
    });
    return Object.entries(map).map(([name, d]) => ({
      materialName: name,
      unit:     d.unit,
      expected: d.received + d.adjusted - d.issued,
    })).sort((a, b) => a.materialName.localeCompare(b.materialName));
  }, [receipts, issuanceTotals, adjustments]);

  const handleStartNew = useCallback(async () => {
    setSaving(true);
    try {
      const ref = await createStockTake({ date, notes, items: [] }, user.email);
      setRefresh((n) => n + 1);
      // Open the new take immediately
      setActiveTake({ id: ref.id, date, notes, items: [], status: "in-progress", conductedBy: user.email });
      setCounts({});
      setNotes("");
    } catch (err) {
      alert("Failed to start stock take: " + err.message);
    } finally {
      setSaving(false);
    }
  }, [date, notes, user.email]);

  const handleCountChange = (materialName, value) => {
    setCounts((p) => ({ ...p, [materialName]: value }));
  };

  const handleSaveCounts = useCallback(async () => {
    if (!activeTake) return;
    setSaving(true);
    const items = expectedBalances.map((m) => {
      const actual   = counts[m.materialName] !== undefined ? Number(counts[m.materialName]) : null;
      const variance = actual !== null ? actual - m.expected : null;
      return { ...m, actual, variance };
    });
    try {
      await updateStockTakeItems(activeTake.id, items);
      setActiveTake((p) => ({ ...p, items }));
      setSuccessMsg("Counts saved.");
      setTimeout(() => setSuccessMsg(""), 3000);
    } catch (err) {
      alert("Save failed: " + err.message);
    } finally {
      setSaving(false);
    }
  }, [activeTake, expectedBalances, counts]);

  const handleComplete = useCallback(async () => {
    if (!activeTake) return;
    if (!window.confirm("Mark this stock take as complete? You won't be able to edit counts afterward.")) return;
    setCompleting(true);
    try {
      await completeStockTake(activeTake.id);
      setActiveTake((p) => ({ ...p, status: "completed" }));
      setRefresh((n) => n + 1);
    } catch (err) {
      alert("Failed: " + err.message);
    } finally {
      setCompleting(false);
    }
  }, [activeTake]);

  // Apply variances as inventory adjustments
  const handleApplyAdjustments = useCallback(async () => {
    if (!activeTake?.items) return;
    const variances = activeTake.items.filter((i) => i.variance !== null && i.variance !== 0);
    if (variances.length === 0) { alert("No variances to apply."); return; }
    if (!window.confirm(`Apply ${variances.length} variance adjustment${variances.length !== 1 ? "s" : ""} to stock?`)) return;

    setApplyingAdj(true);
    try {
      for (const item of variances) {
        const adjType = item.variance > 0 ? "Correction (Add)" : "Write-off";
        await addAdjustment({
          materialName:    item.materialName,
          unit:            item.unit || "",
          adjustmentType:  adjType,
          quantity:        Math.abs(item.variance),
          reason:          `Stock take on ${activeTake.date || fmt(activeTake.createdAt)} — variance correction`,
          date:            activeTake.date || todayISO(),
          adjustedByEmail: user.email,
        });
      }
      setSuccessMsg(`${variances.length} adjustment${variances.length !== 1 ? "s" : ""} applied.`);
      setTimeout(() => setSuccessMsg(""), 4000);
    } catch (err) {
      alert("Failed to apply adjustments: " + err.message);
    } finally {
      setApplyingAdj(false);
    }
  }, [activeTake, user.email]);

  const isCompleted = activeTake?.status === "completed";

  if (activeTake) {
    return (
      <div className="page-stocktake">
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
          <button className="photo-view-btn" onClick={() => setActiveTake(null)}>← Back</button>
          <h2 style={{ fontSize: 18, fontWeight: 700, color: "var(--text-primary)" }}>
            Stock Take — {activeTake.date || fmt(activeTake.createdAt)}
          </h2>
          <span className={`feat-status-badge feat-status-badge--${isCompleted ? "done" : "progress"}`}>
            {isCompleted ? "Completed" : "In Progress"}
          </span>
        </div>

        {successMsg && <div className="issuance-success-banner" role="status">{successMsg}</div>}

        {dataLoading ? (
          <div className="loading-state"><div className="spinner" /><p>Loading stock data…</p></div>
        ) : (
          <>
            <section className="panel" style={{ marginBottom: 16 }}>
              <div className="panel-header">
                <h3>Count Sheet</h3>
                <div style={{ display: "flex", gap: 8 }}>
                  {!isCompleted && (
                    <>
                      <button className="issue-btn" onClick={handleSaveCounts} disabled={saving}>
                        {saving ? "Saving…" : "Save Counts"}
                      </button>
                      <button className="issue-btn" onClick={handleComplete} disabled={completing}
                        style={{ background: "#1E9E52", borderColor: "#1E9E52" }}>
                        {completing ? "Completing…" : "Complete Take"}
                      </button>
                    </>
                  )}
                  {isCompleted && activeTake.items?.some((i) => i.variance !== 0 && i.variance !== null) && (
                    <button className="issue-btn" onClick={handleApplyAdjustments} disabled={applyingAdj}
                      style={{ background: "#7D3C98", borderColor: "#7D3C98" }}>
                      {applyingAdj ? "Applying…" : "Apply Variances to Stock"}
                    </button>
                  )}
                </div>
              </div>

              <div className="table-scroll" style={{ maxHeight: 520 }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Material</th>
                      <th>Unit</th>
                      <th>Expected (System)</th>
                      <th>Actual (Physical Count)</th>
                      <th>Variance</th>
                    </tr>
                  </thead>
                  <tbody>
                    {expectedBalances.map((m) => {
                      const saved    = activeTake.items?.find((i) => i.materialName === m.materialName);
                      const actual   = !isCompleted
                        ? (counts[m.materialName] ?? "")
                        : (saved?.actual ?? "—");
                      const variance = !isCompleted
                        ? (counts[m.materialName] !== undefined && counts[m.materialName] !== ""
                            ? Number(counts[m.materialName]) - m.expected : null)
                        : (saved?.variance ?? null);

                      return (
                        <tr key={m.materialName}>
                          <td className="bold">{m.materialName}</td>
                          <td>{m.unit || "—"}</td>
                          <td className="mono">{m.expected.toLocaleString()}</td>
                          <td>
                            {isCompleted ? (
                              <span className="mono">{actual}</span>
                            ) : (
                              <input
                                type="number"
                                value={actual}
                                onChange={(e) => handleCountChange(m.materialName, e.target.value)}
                                className="issuance-input"
                                style={{ width: 100, padding: "4px 8px" }}
                                min="0"
                                step="any"
                                placeholder="0"
                              />
                            )}
                          </td>
                          <td className="mono" style={{
                            fontWeight: 700,
                            color: variance === null ? "var(--text-muted)"
                              : variance === 0 ? "#1E9E52"
                              : variance > 0 ? "#1A74BC"
                              : "#dc3545",
                          }}>
                            {variance === null ? "—"
                              : variance === 0 ? "✓ 0"
                              : variance > 0 ? `+${variance.toLocaleString()}`
                              : variance.toLocaleString()}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Summary */}
              {activeTake.items?.length > 0 && (
                <div className="admin-panel-footer">
                  <span>{activeTake.items.filter((i) => i.variance === 0).length} match</span>
                  <span style={{ color: "#dc3545", marginLeft: 12 }}>
                    {activeTake.items.filter((i) => i.variance < 0).length} short
                  </span>
                  <span style={{ color: "#1A74BC", marginLeft: 12 }}>
                    {activeTake.items.filter((i) => i.variance > 0).length} over
                  </span>
                </div>
              )}
            </section>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="page-stocktake">
      <section className="kpi-grid" style={{ marginBottom: 20 }}>
        <div className="kpi-card">
          <div className="kpi-icon" style={{ background: "rgba(125,60,152,0.1)", color: "#7D3C98" }} />
          <div className="kpi-data">
            <span className="kpi-value">{loading ? "—" : takes.length}</span>
            <span className="kpi-title">Total Stock Takes</span>
            <span className="kpi-trend">All time</span>
          </div>
        </div>
        <div className="kpi-card">
          <div className="kpi-icon" style={{ background: "rgba(212,130,10,0.1)", color: "var(--warning)" }} />
          <div className="kpi-data">
            <span className="kpi-value">{loading ? "—" : takes.filter((t) => t.status === "in-progress").length}</span>
            <span className="kpi-title">In Progress</span>
            <span className="kpi-trend">Incomplete takes</span>
          </div>
        </div>
        <div className="kpi-card">
          <div className="kpi-icon" style={{ background: "rgba(30,158,82,0.1)", color: "#1E9E52" }} />
          <div className="kpi-data">
            <span className="kpi-value">{loading ? "—" : takes.filter((t) => t.status === "completed").length}</span>
            <span className="kpi-title">Completed</span>
            <span className="kpi-trend">Reconciled</span>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h3>Stock Takes / Cycle Counts</h3>
        </div>

        {/* New stock take form */}
        {canCreate && (
          <div style={{ padding: "16px", borderBottom: "1px solid var(--border-color)", background: "var(--bg-card)" }}>
            <p className="admin-section-title" style={{ marginBottom: 10 }}>Start a New Stock Take</p>
            <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
              <div className="issuance-field" style={{ marginBottom: 0 }}>
                <label style={{ fontSize: 12 }}>Date</label>
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)}
                  className="issuance-input" style={{ width: 160 }} />
              </div>
              <div className="issuance-field" style={{ flex: 1, marginBottom: 0, minWidth: 200 }}>
                <label style={{ fontSize: 12 }}>Notes (optional)</label>
                <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)}
                  className="issuance-input" placeholder="e.g. Monthly count, Q2 audit…" />
              </div>
              <button className="issue-btn" onClick={handleStartNew} disabled={saving}>
                {saving ? "Starting…" : "Start Stock Take"}
              </button>
            </div>
          </div>
        )}

        {/* History */}
        {loading ? (
          <div className="loading-state"><div className="spinner" /><p>Loading…</p></div>
        ) : takes.length === 0 ? (
          <div className="empty-state" style={{ padding: "48px 20px" }}>
            <p>No stock takes yet.</p>
            <p className="empty-hint">Start a stock take above to begin counting.</p>
          </div>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Conducted By</th>
                  <th>Status</th>
                  <th>Items Counted</th>
                  <th>Variances</th>
                  <th>Notes</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {takes.map((t) => {
                  const variances = (t.items || []).filter((i) => i.variance !== 0 && i.variance !== null).length;
                  return (
                    <tr key={t.id}>
                      <td className="mono">{t.date || fmt(t.createdAt)}</td>
                      <td style={{ fontSize: 12 }}>{t.conductedBy || "—"}</td>
                      <td>
                        <span className={`feat-status-badge feat-status-badge--${t.status === "completed" ? "done" : "progress"}`}>
                          {t.status === "completed" ? "Completed" : "In Progress"}
                        </span>
                      </td>
                      <td className="mono">{(t.items || []).length || "—"}</td>
                      <td className="mono" style={{ color: variances > 0 ? "#dc3545" : "var(--text-muted)" }}>
                        {(t.items || []).length > 0 ? variances : "—"}
                      </td>
                      <td style={{ fontSize: 12, color: "var(--text-muted)", maxWidth: 180, whiteSpace: "normal" }}>
                        {t.notes || "—"}
                      </td>
                      <td>
                        {(canEdit || t.status === "in-progress") && (
                          <button className="photo-view-btn" onClick={() => {
                            setActiveTake(t);
                            // Pre-populate counts from saved items
                            const saved = {};
                            (t.items || []).forEach((i) => {
                              if (i.actual !== null && i.actual !== undefined) saved[i.materialName] = i.actual;
                            });
                            setCounts(saved);
                          }}>
                            {t.status === "completed" ? "View" : "Continue"}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

export default StockTake;
