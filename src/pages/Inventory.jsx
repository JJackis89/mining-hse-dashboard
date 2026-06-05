import { useEffect, useState, useMemo, useCallback } from "react";
import { getMaterials, getMaterialAttachments } from "../services/arcgisService";
import {
  addIssuance, getIssuances,
  getIssuanceTotals, generateIssueRef, getOrCreateInventoryItem,
} from "../services/issuanceService";
import { exportToCsv } from "../utils/exportCsv";
import { useUser } from "../context/UserContext";

const ISSUANCE_ROLES = ["admin", "storekeeper"];

const CSV_COLUMNS = [
  { key: "date_time_received", label: "Date Received" },
  { key: "material_name",      label: "Material" },
  { key: "category",           label: "Category" },
  { key: "quantity_received",  label: "Qty" },
  { key: "unit",               label: "Unit" },
  { key: "supplier",           label: "Supplier" },
  { key: "received_by",        label: "Received By" },
  { key: "remarks",            label: "Remarks" },
];

const PAGE_SIZE = 20;

function fmt(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function todayISO() {
  return new Date().toISOString().split("T")[0];
}

// ─── Pagination ───────────────────────────────────────────────
function Pagination({ page, totalPages, onChange }) {
  if (totalPages <= 1) return null;
  const pages = Array.from({ length: totalPages }, (_, i) => i + 1);
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
            <button key={p} className={`pagination-btn ${p === page ? "pagination-btn--active" : ""}`} onClick={() => onChange(p)} aria-label={`Page ${p}`} aria-current={p === page ? "page" : undefined}>{p}</button>
          );
          return acc;
        }, [])}
        <button className="pagination-btn" onClick={() => onChange(page + 1)} disabled={page === totalPages} aria-label="Next page">&#8250;</button>
      </div>
    </div>
  );
}

// ─── Photo Modal ──────────────────────────────────────────────
function PhotoModal({ record, onClose }) {
  const [attachments, setAttachments] = useState([]);
  const [loadingPhotos, setLoadingPhotos] = useState(true);
  const [photoError, setPhotoError]   = useState(null);
  const [activeIdx, setActiveIdx]     = useState(0);

  useEffect(() => {
    getMaterialAttachments(record.objectid)
      .then(setAttachments)
      .catch((err) => setPhotoError(err.message))
      .finally(() => setLoadingPhotos(false));
  }, [record.objectid]);

  useEffect(() => {
    const handler = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const images     = attachments.filter((a) => a.contentType?.startsWith("image/"));
  const isSignature = (a) => /signature/i.test(a.name);

  return (
    <div className="photo-modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="Photo viewer">
      <div className="photo-modal" onClick={(e) => e.stopPropagation()}>
        <div className="photo-modal-header">
          <div>
            <span className="photo-modal-title">{record.material_name || "Receipt"}</span>
            <span className="photo-modal-sub">{fmt(record.date_time_received)}</span>
          </div>
          <button className="photo-modal-close" onClick={onClose} aria-label="Close photo viewer">&#x2715;</button>
        </div>
        <div className="photo-modal-body">
          {loadingPhotos && (
            <div className="loading-state" style={{ minHeight: 200 }}>
              <div className="spinner" aria-label="Loading" /><p>Loading attachments…</p>
            </div>
          )}
          {!loadingPhotos && photoError && (
            <div className="error-state" style={{ minHeight: 200 }}>
              <span className="error-icon" role="img" aria-label="Error">!</span>
              <p>Could not load attachments</p>
              <p className="error-detail">{photoError}</p>
            </div>
          )}
          {!loadingPhotos && !photoError && images.length === 0 && (
            <div className="empty-state" style={{ padding: "40px 20px" }}>
              <p>No attachments on this receipt.</p>
            </div>
          )}
          {!loadingPhotos && !photoError && images.length > 0 && (
            <>
              <div className="photo-main-wrap">
                <img key={images[activeIdx].url} src={images[activeIdx].url} alt={images[activeIdx].name} className="photo-main-img" />
                {images.length > 1 && (
                  <>
                    <button className="photo-nav photo-nav--prev" onClick={() => setActiveIdx((i) => (i - 1 + images.length) % images.length)} aria-label="Previous image">&#8249;</button>
                    <button className="photo-nav photo-nav--next" onClick={() => setActiveIdx((i) => (i + 1) % images.length)} aria-label="Next image">&#8250;</button>
                  </>
                )}
                <span className="photo-counter" aria-label={`Image ${activeIdx + 1} of ${images.length}`}>{activeIdx + 1} / {images.length}</span>
                <span className={`photo-type-badge ${isSignature(images[activeIdx]) ? "photo-type-badge--sig" : "photo-type-badge--photo"}`}>
                  {isSignature(images[activeIdx]) ? "Signature" : "Photo"}
                </span>
              </div>
              <div className="photo-thumbs" role="list" aria-label="Image thumbnails">
                {images.map((img, i) => (
                  <div key={img.id} className={`photo-thumb-wrap ${i === activeIdx ? "photo-thumb-wrap--active" : ""}`} onClick={() => setActiveIdx(i)} role="listitem" aria-label={`Thumbnail ${i + 1}: ${isSignature(img) ? "Signature" : "Photo"}`}>
                    <img src={img.url} alt={img.name} className="photo-thumb" />
                    <span className={`photo-thumb-label ${isSignature(img) ? "photo-thumb-label--sig" : ""}`}>{isSignature(img) ? "Signature" : "Photo"}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Issuance Modal ───────────────────────────────────────────
function IssuanceModal({ prefill, allRecords, user, onClose, onSuccess }) {
  const isPrefilled = !!prefill?.material_name;

  // Unique material list derived from all receipt records
  const materialOptions = useMemo(() => {
    const seen = new Map();
    allRecords.forEach((r) => {
      if (r.material_name && !seen.has(r.material_name)) {
        seen.set(r.material_name, {
          material_name: r.material_name,
          category:      r.category || "",
          unit:          r.unit     || "",
        });
      }
    });
    return [...seen.values()].sort((a, b) => a.material_name.localeCompare(b.material_name));
  }, [allRecords]);

  const [selectedName, setSelectedName] = useState(prefill?.material_name || "");
  const [allTotals, setAllTotals]       = useState(null);
  const [itemMeta, setItemMeta]         = useState(null);
  const [initLoading, setInitLoading]   = useState(true);
  const [metaLoading, setMetaLoading]   = useState(false);
  const [form, setForm] = useState({
    qtyIssued:  "",
    issuedTo:   "",
    department: "",
    purpose:    "",
    remarks:    "",
    date:       todayISO(),
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError]           = useState("");

  useEffect(() => {
    const h = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  // Load all issuance totals once on mount (needed for balance calculation)
  useEffect(() => {
    getIssuanceTotals()
      .then(setAllTotals)
      .catch(() => setAllTotals({}))
      .finally(() => setInitLoading(false));
  }, []);

  // When the selected material changes, load / create its inventory-item metadata
  useEffect(() => {
    if (!selectedName) { setItemMeta(null); return; }
    const mat = materialOptions.find((m) => m.material_name === selectedName)
      || { category: prefill?.category || "", unit: prefill?.unit || "" };
    setMetaLoading(true);
    getOrCreateInventoryItem(selectedName, { category: mat.category, unit: mat.unit })
      .then(setItemMeta)
      .catch(() => setItemMeta({ itemCode: "—", warehouseLocation: "Main Store" }))
      .finally(() => setMetaLoading(false));
  }, [selectedName]); // eslint-disable-line react-hooks/exhaustive-deps

  // Stock balance derived values
  const totalReceived = useMemo(() =>
    allRecords
      .filter((r) => r.material_name === selectedName)
      .reduce((s, r) => s + (Number(r.quantity_received) || 0), 0),
    [allRecords, selectedName]
  );
  const totalIssued = allTotals ? (allTotals[selectedName] || 0) : 0;
  const balance     = totalReceived - totalIssued;

  const selectedUnit = itemMeta?.unit
    || materialOptions.find((m) => m.material_name === selectedName)?.unit
    || prefill?.unit
    || "";

  const selectedCategory = materialOptions.find((m) => m.material_name === selectedName)?.category
    || prefill?.category
    || "";

  const set = (f) => (e) => setForm((prev) => ({ ...prev, [f]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!selectedName) { setError("Please select a material."); return; }
    const qty = Number(form.qtyIssued);
    if (!qty || qty <= 0)        { setError("Quantity must be greater than 0."); return; }
    if (qty > balance)           { setError(`Cannot issue ${qty.toLocaleString()} — only ${balance.toLocaleString()} ${selectedUnit} available.`); return; }
    if (!form.issuedTo.trim())   { setError("Recipient is required."); return; }
    if (!form.department.trim()) { setError("Department is required."); return; }

    setSubmitting(true);
    setError("");
    try {
      const issueRefNumber = await generateIssueRef();
      await addIssuance({
        issueRefNumber,
        materialName:      selectedName,
        itemCode:          itemMeta?.itemCode          || "",
        category:          selectedCategory,
        unit:              selectedUnit,
        warehouseLocation: itemMeta?.warehouseLocation || "Main Store",
        qtyIssued:         qty,
        stockBefore:       balance,
        stockAfter:        balance - qty,
        issuedTo:          form.issuedTo.trim(),
        department:        form.department.trim(),
        purpose:           form.purpose.trim(),
        remarks:           form.remarks.trim(),
        issuedByEmail:     user.email,
        dateOfIssuance:    form.date,
      });
      onSuccess(selectedName, issueRefNumber);
    } catch {
      setError("Failed to record issuance. Please try again.");
      setSubmitting(false);
    }
  };

  const stockState = balance <= 0 ? "zero" : balance <= 10 ? "low" : "ok";
  const todayPrefix = new Date().toISOString().slice(0, 10).replace(/-/g, "");

  return (
    <div className="photo-modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="Issue item">
      <div className="photo-modal issuance-modal" onClick={(e) => e.stopPropagation()}>

        {/* Header */}
        <div className="photo-modal-header">
          <div>
            <span className="photo-modal-title">Issue Item</span>
            <span className="photo-modal-sub">Record an item issuance from inventory</span>
          </div>
          <button className="photo-modal-close" onClick={onClose} aria-label="Close">&#x2715;</button>
        </div>

        <div className="photo-modal-body">
          {error && <div className="issuance-error" role="alert">{error}</div>}

          {initLoading ? (
            <div className="loading-state" style={{ minHeight: 140 }}>
              <div className="spinner" aria-label="Loading" /><p>Loading inventory data…</p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="issuance-form" noValidate>

              {/* ── Item Selection ─────────────────────── */}
              <p className="issuance-section-title">Item Selection</p>
              <div className="issuance-field" style={{ marginBottom: 16 }}>
                <label>Material <span className="issuance-required">*</span></label>
                {isPrefilled ? (
                  <input
                    className="issuance-input issuance-input--readonly"
                    value={selectedName}
                    readOnly
                    aria-label="Material name"
                  />
                ) : (
                  <select
                    className="issuance-item-select"
                    value={selectedName}
                    onChange={(e) => { setSelectedName(e.target.value); setError(""); }}
                    required
                    aria-label="Select material"
                  >
                    <option value="">— Select a material —</option>
                    {materialOptions.map((m) => (
                      <option key={m.material_name} value={m.material_name}>
                        {m.material_name}
                      </option>
                    ))}
                  </select>
                )}
              </div>

              {/* ── Item Details (auto-populated once material is known) ── */}
              {selectedName && (
                <>
                  <p className="issuance-section-title">Item Details</p>

                  {metaLoading ? (
                    <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 14 }}>
                      Loading item details…
                    </div>
                  ) : (
                    <div className="issuance-meta-grid">
                      <div className="issuance-meta-item">
                        <span className="issuance-meta-label">Item Code / Asset No.</span>
                        <span className="issuance-meta-value mono">{itemMeta?.itemCode || "—"}</span>
                      </div>
                      <div className="issuance-meta-item">
                        <span className="issuance-meta-label">Category</span>
                        <span className="issuance-meta-value">{selectedCategory || "—"}</span>
                      </div>
                      <div className="issuance-meta-item">
                        <span className="issuance-meta-label">Unit of Measure</span>
                        <span className="issuance-meta-value">{selectedUnit || "—"}</span>
                      </div>
                      <div className="issuance-meta-item">
                        <span className="issuance-meta-label">Warehouse / Store</span>
                        <span className="issuance-meta-value">{itemMeta?.warehouseLocation || "Main Store"}</span>
                      </div>
                    </div>
                  )}

                  {/* ── Stock Balance Card ──────────────── */}
                  <div className={`issuance-stock-card issuance-stock-card--${stockState}`}>
                    <div style={{ flex: 1 }}>
                      <span className="issuance-stock-label">Available Stock</span>
                      <div>
                        <span className={`issuance-stock-number issuance-stock-number--${stockState}`}>
                          {balance.toLocaleString()}
                        </span>
                        {selectedUnit && (
                          <span className="issuance-stock-unit">{selectedUnit}</span>
                        )}
                      </div>
                      <span className="issuance-stock-detail">
                        Received: {totalReceived.toLocaleString()} · Issued: {totalIssued.toLocaleString()}
                      </span>
                    </div>
                    {stockState === "zero" && (
                      <span className="issuance-stock-badge issuance-stock-badge--zero">No stock</span>
                    )}
                    {stockState === "low" && (
                      <span className="issuance-stock-badge issuance-stock-badge--low">Low stock</span>
                    )}
                  </div>

                  {/* ── Transaction Details ─────────────── */}
                  <div className="issuance-section-divider" />
                  <p className="issuance-section-title">Transaction Details</p>

                  <div className="issuance-form-grid">
                    <div className="issuance-field">
                      <label>Qty to Issue <span className="issuance-required">*</span></label>
                      <input
                        type="number"
                        value={form.qtyIssued}
                        onChange={set("qtyIssued")}
                        min="0.01"
                        max={balance > 0 ? balance : undefined}
                        step="any"
                        className="issuance-input"
                        placeholder="0"
                        required
                        disabled={balance <= 0}
                        aria-describedby="qty-hint"
                      />
                      {balance > 0 && (
                        <span id="qty-hint" style={{ fontSize: 11, color: "var(--text-muted)" }}>
                          Max: {balance.toLocaleString()} {selectedUnit}
                        </span>
                      )}
                    </div>

                    <div className="issuance-field">
                      <label>Recipient <span className="issuance-required">*</span></label>
                      <input
                        type="text"
                        value={form.issuedTo}
                        onChange={set("issuedTo")}
                        className="issuance-input"
                        placeholder="Name or employee ID"
                        required
                      />
                    </div>

                    <div className="issuance-field">
                      <label>Department <span className="issuance-required">*</span></label>
                      <input
                        type="text"
                        value={form.department}
                        onChange={set("department")}
                        className="issuance-input"
                        placeholder="e.g. Operations"
                        required
                      />
                    </div>

                    <div className="issuance-field">
                      <label>Date of Issuance <span className="issuance-required">*</span></label>
                      <input
                        type="date"
                        value={form.date}
                        onChange={set("date")}
                        className="issuance-input"
                        required
                      />
                    </div>
                  </div>

                  <div className="issuance-field" style={{ marginTop: 12 }}>
                    <label>Purpose</label>
                    <textarea
                      value={form.purpose}
                      onChange={set("purpose")}
                      rows={2}
                      className="issuance-textarea"
                      placeholder="Reason for issuance (optional)"
                    />
                  </div>

                  <div className="issuance-field" style={{ marginTop: 10 }}>
                    <label>Remarks</label>
                    <textarea
                      value={form.remarks}
                      onChange={set("remarks")}
                      rows={2}
                      className="issuance-textarea"
                      placeholder="Additional notes (optional)"
                    />
                  </div>
                </>
              )}

              {/* ── Footer ─────────────────────────────── */}
              <div className="issuance-form-footer">
                <div className="issuance-footer-meta">
                  <span className="issuance-ref-preview">
                    Ref: ISS-{todayPrefix}-auto
                  </span>
                  <span className="issuance-by-label">
                    Issued by: <strong>{user.email}</strong>
                  </span>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button type="button" className="issuance-cancel-btn" onClick={onClose} disabled={submitting}>
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="issuance-submit-btn"
                    disabled={submitting || !selectedName || balance <= 0}
                  >
                    {submitting ? "Saving…" : "Record Issuance"}
                  </button>
                </div>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Issuances Tab Content ────────────────────────────────────
function IssuancesPanel({ refresh }) {
  const [issuances, setIssuances] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    getIssuances()
      .then(setIssuances)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [refresh]);

  if (loading) {
    return (
      <div className="loading-state" style={{ minHeight: 200 }}>
        <div className="spinner" aria-label="Loading" /><p>Loading issuance records…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="error-state" style={{ minHeight: 200 }}>
        <span className="error-icon" role="img" aria-label="Error">!</span>
        <p>Failed to load issuance records</p>
        <p className="error-detail">{error}</p>
      </div>
    );
  }

  if (issuances.length === 0) {
    return (
      <div className="empty-state" style={{ padding: "48px 20px" }}>
        <p>No issuances recorded yet.</p>
        <p className="empty-hint">Use the Issue Item button to record items issued from inventory.</p>
      </div>
    );
  }

  return (
    <>
      <div className="table-scroll table-mobile-cards" style={{ maxHeight: 520 }}>
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Ref No.</th>
              <th scope="col">Date</th>
              <th scope="col">Material</th>
              <th scope="col">Code</th>
              <th scope="col">Category</th>
              <th scope="col">Qty Issued</th>
              <th scope="col">Unit</th>
              <th scope="col">Stock After</th>
              <th scope="col">Issued To</th>
              <th scope="col">Department</th>
              <th scope="col">Purpose</th>
              <th scope="col">Issued By</th>
            </tr>
          </thead>
          <tbody>
            {issuances.map((r) => (
              <tr key={r.id}>
                <td data-label="Ref No.">
                  {r.issueRefNumber
                    ? <span className="issuance-ref-chip">{r.issueRefNumber}</span>
                    : <span style={{ color: "var(--text-muted)" }}>—</span>}
                </td>
                <td className="mono" data-label="Date">{r.dateOfIssuance || "—"}</td>
                <td className="bold" data-label="Material">{r.materialName || "—"}</td>
                <td className="mono" data-label="Code" style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  {r.itemCode || "—"}
                </td>
                <td data-label="Category">
                  {r.category
                    ? <span className="inv-category-badge">{r.category}</span>
                    : "—"}
                </td>
                <td className="mono" data-label="Qty Issued">{r.qtyIssued ?? "—"}</td>
                <td data-label="Unit">{r.unit || "—"}</td>
                <td data-label="Stock After">
                  {r.stockAfter != null
                    ? <span className={`issuance-balance-chip ${r.stockAfter <= 0 ? "issuance-balance-chip--zero" : r.stockAfter <= 10 ? "issuance-balance-chip--low" : ""}`}>
                        {r.stockAfter.toLocaleString()}
                      </span>
                    : "—"}
                </td>
                <td data-label="Issued To">{r.issuedTo || "—"}</td>
                <td data-label="Department">{r.department || "—"}</td>
                <td data-label="Purpose" style={{ maxWidth: 180, whiteSpace: "normal", lineHeight: 1.4 }}>
                  {r.purpose || r.remarks || "—"}
                </td>
                <td data-label="Issued By" style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  {r.issuedByEmail || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="issuance-panel-footer">
        {issuances.length} issuance record{issuances.length !== 1 ? "s" : ""}
      </div>
    </>
  );
}

// ─── Main Page ────────────────────────────────────────────────
function Inventory() {
  const user     = useUser();
  const canIssue = ISSUANCE_ROLES.includes(user?.role);

  const [records, setRecords]         = useState([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState(null);
  const [search, setSearch]           = useState("");
  const [filterCat, setFilterCat]     = useState("All");
  const [photoRecord, setPhotoRecord] = useState(null);
  const [page, setPage]               = useState(1);

  const [activeTab, setActiveTab]               = useState("receipts");
  const [issuanceTarget, setIssuanceTarget]     = useState(null);
  const [issuanceSuccess, setIssuanceSuccess]   = useState("");
  const [issuancesRefresh, setIssuancesRefresh] = useState(0);

  useEffect(() => {
    if (!issuanceSuccess) return;
    const t = setTimeout(() => setIssuanceSuccess(""), 5000);
    return () => clearTimeout(t);
  }, [issuanceSuccess]);

  useEffect(() => {
    let cancelled = false;
    getMaterials()
      .then((rows) => {
        if (!cancelled) setRecords(
          rows
            .map((r) => ({ ...r }))
            .sort((a, b) => (b.date_time_received || 0) - (a.date_time_received || 0))
        );
      })
      .catch((err) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const categories = useMemo(() => {
    const cats = [...new Set(records.map((r) => r.category).filter(Boolean))].sort();
    return ["All", ...cats];
  }, [records]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return records.filter((r) => {
      const matchCat    = filterCat === "All" || r.category === filterCat;
      const matchSearch = !q ||
        (r.material_name || "").toLowerCase().includes(q) ||
        (r.received_by   || "").toLowerCase().includes(q) ||
        (r.remarks       || "").toLowerCase().includes(q);
      return matchCat && matchSearch;
    });
  }, [records, search, filterCat]);

  const handleSearch = useCallback((val) => { setSearch(val); setPage(1); }, []);
  const handleFilter = useCallback((cat) => { setFilterCat(cat); setPage(1); }, []);

  const totals = useMemo(() => ({
    count:      filtered.length,
    categories: new Set(filtered.map((r) => r.category).filter(Boolean)).size,
    totalQty:   filtered.reduce((s, r) => s + (r.quantity_received || 0), 0),
    suppliers:  new Set(filtered.map((r) => r.supplier).filter(Boolean)).size,
  }), [filtered]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage   = Math.min(page, totalPages);
  const pageItems  = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const closeModal = useCallback(() => setPhotoRecord(null), []);

  const handleIssuanceSuccess = useCallback((materialName, refNumber) => {
    setIssuanceTarget(null);
    setIssuanceSuccess(`${refNumber} — "${materialName}" issued successfully.`);
    setIssuancesRefresh((n) => n + 1);
  }, []);

  if (loading) {
    return (
      <div className="page-inventory">
        <div className="loading-state"><div className="spinner" aria-label="Loading" /><p>Loading materials receipts…</p></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="page-inventory">
        <div className="error-state">
          <span className="error-icon" role="img" aria-label="Error">!</span>
          <p>Failed to load inventory data</p>
          <p className="error-detail">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page-inventory">
      {/* ── KPI Summary ───────────────────────────── */}
      <section className="kpi-grid" style={{ marginBottom: 20 }} aria-label="Inventory summary">
        <div className="kpi-card">
          <div className="kpi-icon" style={{ background: "rgba(184,136,26,0.1)", color: "#B8881A" }} aria-hidden="true" />
          <div className="kpi-data">
            <span className="kpi-value">{totals.count}</span>
            <span className="kpi-title">Receipts</span>
            <span className="kpi-trend">Filtered entries</span>
          </div>
        </div>
        <div className="kpi-card">
          <div className="kpi-icon" style={{ background: "rgba(26,116,188,0.1)", color: "#1A74BC" }} aria-hidden="true" />
          <div className="kpi-data">
            <span className="kpi-value">{totals.categories}</span>
            <span className="kpi-title">Categories</span>
            <span className="kpi-trend">Material types</span>
          </div>
        </div>
        <div className="kpi-card">
          <div className="kpi-icon" style={{ background: "rgba(30,158,82,0.1)", color: "#1E9E52" }} aria-hidden="true" />
          <div className="kpi-data">
            <span className="kpi-value">{totals.totalQty.toLocaleString()}</span>
            <span className="kpi-title">Total Qty</span>
            <span className="kpi-trend">Units received</span>
          </div>
        </div>
        <div className="kpi-card">
          <div className="kpi-icon" style={{ background: "rgba(125,60,152,0.1)", color: "#7D3C98" }} aria-hidden="true" />
          <div className="kpi-data">
            <span className="kpi-value">{totals.suppliers}</span>
            <span className="kpi-title">Suppliers</span>
            <span className="kpi-trend">Unique suppliers</span>
          </div>
        </div>
      </section>

      {/* ── Main Panel ────────────────────────────── */}
      <section className="panel" aria-label="Inventory management">

        {/* Panel header */}
        <div className="panel-header">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <h3>Inventory</h3>
            <span className="panel-badge">
              {activeTab === "receipts" ? `${totals.count} receipts` : "Issuance records"}
            </span>
          </div>
          {canIssue && (
            <button
              className="issue-btn"
              onClick={() => setIssuanceTarget({})}
              aria-label="Record a new item issuance"
            >
              + Issue Item
            </button>
          )}
        </div>

        {/* Tab bar */}
        <div className="inv-tab-bar" role="tablist" aria-label="Inventory sections">
          <button
            role="tab"
            aria-selected={activeTab === "receipts"}
            className={`inv-tab-btn ${activeTab === "receipts" ? "inv-tab-btn--active" : ""}`}
            onClick={() => setActiveTab("receipts")}
          >
            Receipts
          </button>
          <button
            role="tab"
            aria-selected={activeTab === "issuances"}
            className={`inv-tab-btn ${activeTab === "issuances" ? "inv-tab-btn--active" : ""}`}
            onClick={() => setActiveTab("issuances")}
          >
            Issuances
          </button>
        </div>

        {/* ── Receipts Tab ──────────────────────── */}
        {activeTab === "receipts" && (
          <>
            {issuanceSuccess && (
              <div className="issuance-success-banner" role="status">
                {issuanceSuccess}
              </div>
            )}

            <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-color)" }}>
              <div className="table-toolbar">
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <input
                    className="table-search"
                    placeholder="Search material, received by…"
                    value={search}
                    onChange={(e) => handleSearch(e.target.value)}
                    aria-label="Search materials"
                  />
                  <div className="activity-filters" role="group" aria-label="Filter by category">
                    {categories.map((cat) => (
                      <button
                        key={cat}
                        className={`filter-btn ${filterCat === cat ? "filter-btn--active" : ""}`}
                        onClick={() => handleFilter(cat)}
                        aria-pressed={filterCat === cat}
                      >{cat}</button>
                    ))}
                  </div>
                </div>
                <button
                  className="export-btn"
                  onClick={() => exportToCsv("materials-receipts.csv", filtered, CSV_COLUMNS)}
                  disabled={!filtered.length}
                  aria-label="Export filtered records to CSV"
                >Export CSV</button>
              </div>
            </div>

            <div className="table-scroll table-mobile-cards" style={{ maxHeight: 520 }}>
              {filtered.length === 0 ? (
                <div className="empty-state">
                  <p>No records match your filters.</p>
                  <p className="empty-hint">Submit receipts via the Survey123 Materials Receipt form.</p>
                </div>
              ) : (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th scope="col">Date Received</th>
                      <th scope="col">Material</th>
                      <th scope="col">Category</th>
                      <th scope="col">Qty</th>
                      <th scope="col">Unit</th>
                      <th scope="col">Supplier</th>
                      <th scope="col">Received By</th>
                      <th scope="col">Remarks</th>
                      <th scope="col">Photos</th>
                      {canIssue && <th scope="col">Issue</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {pageItems.map((r) => (
                      <tr key={r.objectid}>
                        <td className="mono" data-label="Date">{fmt(r.date_time_received)}</td>
                        <td className="bold" data-label="Material">{r.material_name || "—"}</td>
                        <td data-label="Category">
                          {r.category
                            ? <span className="inv-category-badge">{r.category}</span>
                            : "—"}
                        </td>
                        <td className="mono" data-label="Qty">{r.quantity_received ?? "—"}</td>
                        <td data-label="Unit">{r.unit || "—"}</td>
                        <td data-label="Supplier">{r.supplier || "—"}</td>
                        <td data-label="Received By">{r.received_by || "—"}</td>
                        <td data-label="Notes" style={{ maxWidth: 200, whiteSpace: "normal", lineHeight: 1.4 }}>
                          {r.remarks || "—"}
                        </td>
                        <td data-label="">
                          <button className="photo-view-btn" onClick={() => setPhotoRecord(r)} aria-label={`View photos for ${r.material_name || "receipt"}`}>
                            View
                          </button>
                        </td>
                        {canIssue && (
                          <td data-label="">
                            <button
                              className="issue-row-btn"
                              onClick={() => setIssuanceTarget(r)}
                              aria-label={`Issue ${r.material_name || "item"}`}
                            >
                              Issue
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <Pagination page={safePage} totalPages={totalPages} onChange={setPage} />
          </>
        )}

        {/* ── Issuances Tab ─────────────────────── */}
        {activeTab === "issuances" && (
          <>
            {!canIssue && (
              <div className="permission-notice" role="note">
                You have read-only access to issuance records. Contact an admin or storekeeper to record new issuances.
              </div>
            )}
            <IssuancesPanel refresh={issuancesRefresh} />
          </>
        )}
      </section>

      {/* ── Modals ──────────────────────────────── */}
      {photoRecord && <PhotoModal record={photoRecord} onClose={closeModal} />}

      {issuanceTarget !== null && (
        <IssuanceModal
          prefill={issuanceTarget}
          allRecords={records}
          user={user}
          onClose={() => setIssuanceTarget(null)}
          onSuccess={handleIssuanceSuccess}
        />
      )}
    </div>
  );
}

export default Inventory;
