import { useEffect, useState, useMemo, useCallback } from "react";
import {
  addIssuance, getIssuances,
  getIssuanceTotals, generateIssueRef, getOrCreateInventoryItem,
  getReceipts, addReceipt, updateReceipt, deleteReceipt,
  addAdjustment, getAdjustments,
} from "../services/issuanceService";
import { exportToCsv } from "../utils/exportCsv";
import { useUser } from "../context/UserContext";
import { usePermissionMatrix } from "../context/PermissionMatrixContext";
import { canPerform } from "../utils/permissions";
import PermissionNotice from "../components/PermissionNotice";

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

// ─── Issuance Modal ───────────────────────────────────────────
function IssuanceModal({ prefill, allRecords, allTotals, user, onClose, onSuccess }) {
  const isPrefilled = !!prefill?.material_name;

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
  const [itemMeta, setItemMeta]         = useState(null);
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
        <div className="photo-modal-header">
          <div>
            <span className="photo-modal-title">Issue Item</span>
            <span className="photo-modal-sub">Record an item issuance from inventory</span>
          </div>
          <button className="photo-modal-close" onClick={onClose} aria-label="Close">&#x2715;</button>
        </div>

        <div className="photo-modal-body">
          {error && <div className="issuance-error" role="alert">{error}</div>}

          <form onSubmit={handleSubmit} className="issuance-form" noValidate>
            <p className="issuance-section-title">Item Selection</p>
            <div className="issuance-field" style={{ marginBottom: 16 }}>
              <label>Material <span className="issuance-required">*</span></label>
              {isPrefilled ? (
                <input className="issuance-input issuance-input--readonly" value={selectedName} readOnly aria-label="Material name" />
              ) : (
                <select className="issuance-item-select" value={selectedName}
                  onChange={(e) => { setSelectedName(e.target.value); setError(""); }} required aria-label="Select material">
                  <option value="">— Select a material —</option>
                  {materialOptions.map((m) => (
                    <option key={m.material_name} value={m.material_name}>{m.material_name}</option>
                  ))}
                </select>
              )}
            </div>

            {selectedName && (
              <>
                <p className="issuance-section-title">Item Details</p>
                {metaLoading ? (
                  <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 14 }}>Loading item details…</div>
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

                <div className={`issuance-stock-card issuance-stock-card--${stockState}`}>
                  <div style={{ flex: 1 }}>
                    <span className="issuance-stock-label">Available Stock</span>
                    <div>
                      <span className={`issuance-stock-number issuance-stock-number--${stockState}`}>
                        {balance.toLocaleString()}
                      </span>
                      {selectedUnit && <span className="issuance-stock-unit">{selectedUnit}</span>}
                    </div>
                    <span className="issuance-stock-detail">
                      Received: {totalReceived.toLocaleString()} · Issued: {totalIssued.toLocaleString()}
                    </span>
                  </div>
                  {stockState === "zero" && <span className="issuance-stock-badge issuance-stock-badge--zero">No stock</span>}
                  {stockState === "low"  && <span className="issuance-stock-badge issuance-stock-badge--low">Low stock</span>}
                </div>

                <div className="issuance-section-divider" />
                <p className="issuance-section-title">Transaction Details</p>

                <div className="issuance-form-grid">
                  <div className="issuance-field">
                    <label>Qty to Issue <span className="issuance-required">*</span></label>
                    <input type="number" value={form.qtyIssued} onChange={set("qtyIssued")}
                      min="0.01" max={balance > 0 ? balance : undefined} step="any"
                      className="issuance-input" placeholder="0" required disabled={balance <= 0} aria-describedby="qty-hint" />
                    {balance > 0 && (
                      <span id="qty-hint" style={{ fontSize: 11, color: "var(--text-muted)" }}>
                        Max: {balance.toLocaleString()} {selectedUnit}
                      </span>
                    )}
                  </div>
                  <div className="issuance-field">
                    <label>Recipient <span className="issuance-required">*</span></label>
                    <input type="text" value={form.issuedTo} onChange={set("issuedTo")}
                      className="issuance-input" placeholder="Name or employee ID" required />
                  </div>
                  <div className="issuance-field">
                    <label>Department <span className="issuance-required">*</span></label>
                    <input type="text" value={form.department} onChange={set("department")}
                      className="issuance-input" placeholder="e.g. Operations" required />
                  </div>
                  <div className="issuance-field">
                    <label>Date of Issuance <span className="issuance-required">*</span></label>
                    <input type="date" value={form.date} onChange={set("date")} className="issuance-input" required />
                  </div>
                </div>

                <div className="issuance-field" style={{ marginTop: 12 }}>
                  <label>Purpose</label>
                  <textarea value={form.purpose} onChange={set("purpose")} rows={2}
                    className="issuance-textarea" placeholder="Reason for issuance (optional)" />
                </div>
                <div className="issuance-field" style={{ marginTop: 10 }}>
                  <label>Remarks</label>
                  <textarea value={form.remarks} onChange={set("remarks")} rows={2}
                    className="issuance-textarea" placeholder="Additional notes (optional)" />
                </div>
              </>
            )}

            <div className="issuance-form-footer">
              <div className="issuance-footer-meta">
                <span className="issuance-ref-preview">Ref: ISS-{todayPrefix}-auto</span>
                <span className="issuance-by-label">Issued by: <strong>{user.email}</strong></span>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" className="issuance-cancel-btn" onClick={onClose} disabled={submitting}>Cancel</button>
                <button type="submit" className="issuance-submit-btn" disabled={submitting || !selectedName || balance <= 0}>
                  {submitting ? "Saving…" : "Record Issuance"}
                </button>
              </div>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

// ─── Receipt Modal (add + edit) ───────────────────────────────
function ReceiptModal({ user, editRecord, onClose, onSuccess }) {
  const isEdit = !!editRecord;

  const [form, setForm] = useState({
    material_name:     editRecord?.material_name     || "",
    category:          editRecord?.category          || "",
    quantity_received: editRecord?.quantity_received || "",
    unit:              editRecord?.unit              || "",
    supplier:          editRecord?.supplier          || "",
    received_by:       editRecord?.received_by       || "",
    date: editRecord?.date_time_received
      ? new Date(editRecord.date_time_received).toISOString().split("T")[0]
      : todayISO(),
    remarks: editRecord?.remarks || "",
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError]           = useState("");

  useEffect(() => {
    const h = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const set = (f) => (e) => setForm((prev) => ({ ...prev, [f]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.material_name.trim()) { setError("Material name is required."); return; }
    const qty = Number(form.quantity_received);
    if (!qty || qty <= 0)           { setError("Quantity must be greater than 0."); return; }
    if (!form.date)                 { setError("Date received is required."); return; }

    setSubmitting(true);
    setError("");
    const payload = {
      material_name:      form.material_name.trim(),
      category:           form.category.trim(),
      quantity_received:  qty,
      unit:               form.unit.trim(),
      supplier:           form.supplier.trim(),
      received_by:        form.received_by.trim() || user.email,
      date_time_received: new Date(form.date).getTime(),
      remarks:            form.remarks.trim(),
    };
    try {
      if (isEdit) {
        await updateReceipt(editRecord.id, payload);
      } else {
        await addReceipt({ ...payload, addedByEmail: user.email });
      }
      onSuccess(payload.material_name);
    } catch {
      setError("Failed to save receipt. Please try again.");
      setSubmitting(false);
    }
  };

  return (
    <div className="photo-modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label={isEdit ? "Edit receipt" : "Add receipt"}>
      <div className="photo-modal issuance-modal" onClick={(e) => e.stopPropagation()}>
        <div className="photo-modal-header">
          <div>
            <span className="photo-modal-title">{isEdit ? "Edit Receipt" : "Add Receipt"}</span>
            <span className="photo-modal-sub">{isEdit ? "Update receipt details" : "Record goods received into inventory"}</span>
          </div>
          <button className="photo-modal-close" onClick={onClose} aria-label="Close">&#x2715;</button>
        </div>

        <div className="photo-modal-body">
          {error && <div className="issuance-error" role="alert">{error}</div>}

          <form onSubmit={handleSubmit} className="issuance-form" noValidate>
            <p className="issuance-section-title">Item Details</p>

            <div className="issuance-field" style={{ marginBottom: 14 }}>
              <label>Material Name <span className="issuance-required">*</span></label>
              <input type="text" value={form.material_name} onChange={set("material_name")}
                className="issuance-input" placeholder="e.g. Cement Bags" required />
            </div>

            <div className="issuance-form-grid">
              <div className="issuance-field">
                <label>Category</label>
                <input type="text" value={form.category} onChange={set("category")}
                  className="issuance-input" placeholder="e.g. Building Materials" />
              </div>
              <div className="issuance-field">
                <label>Unit</label>
                <input type="text" value={form.unit} onChange={set("unit")}
                  className="issuance-input" placeholder="e.g. bags, kg, pcs" />
              </div>
            </div>

            <div className="issuance-section-divider" />
            <p className="issuance-section-title">Receipt Details</p>

            <div className="issuance-form-grid">
              <div className="issuance-field">
                <label>Quantity Received <span className="issuance-required">*</span></label>
                <input type="number" value={form.quantity_received} onChange={set("quantity_received")}
                  min="0.01" step="any" className="issuance-input" placeholder="0" required />
              </div>
              <div className="issuance-field">
                <label>Date Received <span className="issuance-required">*</span></label>
                <input type="date" value={form.date} onChange={set("date")} className="issuance-input" required />
              </div>
              <div className="issuance-field">
                <label>Supplier</label>
                <input type="text" value={form.supplier} onChange={set("supplier")}
                  className="issuance-input" placeholder="Supplier name" />
              </div>
              <div className="issuance-field">
                <label>Received By</label>
                <input type="text" value={form.received_by} onChange={set("received_by")}
                  className="issuance-input" placeholder={user.email} />
              </div>
            </div>

            <div className="issuance-field" style={{ marginTop: 12 }}>
              <label>Remarks</label>
              <textarea value={form.remarks} onChange={set("remarks")}
                rows={2} className="issuance-textarea" placeholder="Additional notes (optional)" />
            </div>

            <div className="issuance-form-footer">
              <span className="issuance-by-label">
                {isEdit ? "Edited" : "Added"} by: <strong>{user.email}</strong>
              </span>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" className="issuance-cancel-btn" onClick={onClose} disabled={submitting}>Cancel</button>
                <button type="submit" className="issuance-submit-btn" disabled={submitting}>
                  {submitting ? "Saving…" : isEdit ? "Save Changes" : "Add Receipt"}
                </button>
              </div>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

// ─── Delete Confirm Modal ─────────────────────────────────────
function DeleteConfirmModal({ record, onConfirm, onCancel, deleting }) {
  useEffect(() => {
    const h = (e) => { if (e.key === "Escape") onCancel(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onCancel]);

  return (
    <div className="photo-modal-overlay" onClick={onCancel} role="dialog" aria-modal="true" aria-label="Confirm delete">
      <div className="photo-modal" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
        <div className="photo-modal-header">
          <span className="photo-modal-title">Delete Receipt</span>
          <button className="photo-modal-close" onClick={onCancel} aria-label="Close">&#x2715;</button>
        </div>
        <div className="photo-modal-body" style={{ padding: "20px 24px" }}>
          <p style={{ marginBottom: 16 }}>
            Remove <strong>{record.material_name}</strong> ({record.quantity_received} {record.unit}) from inventory?
            This action cannot be undone.
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button className="issuance-cancel-btn" onClick={onCancel} disabled={deleting}>Cancel</button>
            <button
              className="issuance-submit-btn"
              style={{ background: "#dc3545", borderColor: "#dc3545" }}
              onClick={onConfirm}
              disabled={deleting}
            >
              {deleting ? "Deleting…" : "Delete"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Adjustment Modal ─────────────────────────────────────────
const ADJUSTMENT_TYPES = ["Correction (Add)", "Transfer In", "Write-off", "Transfer Out"];
const ADJ_ADDS = new Set(["Correction (Add)", "Transfer In"]);

function AddAdjustmentModal({ allRecords, user, onClose, onSuccess }) {
  const materialOptions = useMemo(() => {
    const seen = new Set();
    return allRecords
      .filter((r) => r.material_name && !seen.has(r.material_name) && seen.add(r.material_name))
      .map((r) => ({ material_name: r.material_name, category: r.category || "", unit: r.unit || "" }))
      .sort((a, b) => a.material_name.localeCompare(b.material_name));
  }, [allRecords]);

  const [form, setForm] = useState({
    materialName:   "",
    adjustmentType: ADJUSTMENT_TYPES[0],
    quantity:       "",
    reason:         "",
    date:           todayISO(),
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError]           = useState("");

  useEffect(() => {
    const h = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const set = (f) => (e) => setForm((prev) => ({ ...prev, [f]: e.target.value }));
  const selected = materialOptions.find((m) => m.material_name === form.materialName);
  const isAdd    = ADJ_ADDS.has(form.adjustmentType);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.materialName) { setError("Select a material."); return; }
    const qty = Number(form.quantity);
    if (!qty || qty <= 0)   { setError("Quantity must be greater than 0."); return; }

    setSubmitting(true);
    setError("");
    try {
      await addAdjustment({
        materialName:    form.materialName,
        category:        selected?.category || "",
        unit:            selected?.unit     || "",
        adjustmentType:  form.adjustmentType,
        quantity:        qty,
        reason:          form.reason.trim(),
        date:            form.date,
        adjustedByEmail: user.email,
      });
      onSuccess(form.materialName);
    } catch {
      setError("Failed to save adjustment. Please try again.");
      setSubmitting(false);
    }
  };

  return (
    <div className="photo-modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="Stock adjustment">
      <div className="photo-modal issuance-modal" onClick={(e) => e.stopPropagation()}>
        <div className="photo-modal-header">
          <div>
            <span className="photo-modal-title">Stock Adjustment</span>
            <span className="photo-modal-sub">Corrections, write-offs, and transfers</span>
          </div>
          <button className="photo-modal-close" onClick={onClose} aria-label="Close">&#x2715;</button>
        </div>
        <div className="photo-modal-body">
          {error && <div className="issuance-error" role="alert">{error}</div>}
          <form onSubmit={handleSubmit} className="issuance-form" noValidate>
            <p className="issuance-section-title">Adjustment Details</p>
            <div className="issuance-field" style={{ marginBottom: 14 }}>
              <label>Material <span className="issuance-required">*</span></label>
              <select className="issuance-item-select" value={form.materialName} onChange={set("materialName")} required>
                <option value="">— Select a material —</option>
                {materialOptions.map((m) => (
                  <option key={m.material_name} value={m.material_name}>{m.material_name}</option>
                ))}
              </select>
            </div>
            <div className="issuance-form-grid">
              <div className="issuance-field">
                <label>Type <span className="issuance-required">*</span></label>
                <select className="issuance-item-select" value={form.adjustmentType} onChange={set("adjustmentType")}>
                  {ADJUSTMENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div className="issuance-field">
                <label>Quantity <span className="issuance-required">*</span></label>
                <input type="number" value={form.quantity} onChange={set("quantity")}
                  min="0.01" step="any" className="issuance-input" placeholder="0" required />
              </div>
              <div className="issuance-field">
                <label>Date <span className="issuance-required">*</span></label>
                <input type="date" value={form.date} onChange={set("date")} className="issuance-input" required />
              </div>
            </div>
            {selected && (
              <div style={{ fontSize: 12, color: isAdd ? "#1E9E52" : "#dc3545", marginTop: 4, marginBottom: 12, fontWeight: 600 }}>
                Effect: {isAdd ? "+" : "−"}{form.quantity || 0} {selected.unit} to stock
              </div>
            )}
            <div className="issuance-field">
              <label>Reason / Notes</label>
              <textarea value={form.reason} onChange={set("reason")} rows={2}
                className="issuance-textarea" placeholder="Reason for adjustment (optional)" />
            </div>
            <div className="issuance-form-footer">
              <span className="issuance-by-label">Adjusted by: <strong>{user.email}</strong></span>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" className="issuance-cancel-btn" onClick={onClose} disabled={submitting}>Cancel</button>
                <button type="submit" className="issuance-submit-btn" disabled={submitting}>
                  {submitting ? "Saving…" : "Save Adjustment"}
                </button>
              </div>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

// ─── Stock Balance Tab ────────────────────────────────────────
function StockTab({ records, allTotals, adjustments }) {
  const [search, setSearch] = useState("");

  const stockData = useMemo(() => {
    const map = {};
    records.forEach((r) => {
      const name = r.material_name;
      if (!name) return;
      if (!map[name]) map[name] = { material_name: name, category: r.category || "", unit: r.unit || "", totalReceived: 0, totalIssued: 0, netAdjusted: 0 };
      map[name].totalReceived += Number(r.quantity_received) || 0;
      if (!map[name].category && r.category) map[name].category = r.category;
      if (!map[name].unit     && r.unit)     map[name].unit     = r.unit;
    });
    Object.entries(allTotals).forEach(([name, qty]) => {
      if (map[name]) map[name].totalIssued = qty;
    });
    adjustments.forEach((adj) => {
      const name = adj.materialName;
      if (!name) return;
      if (!map[name]) map[name] = { material_name: name, category: adj.category || "", unit: adj.unit || "", totalReceived: 0, totalIssued: 0, netAdjusted: 0 };
      map[name].netAdjusted += (ADJ_ADDS.has(adj.adjustmentType) ? 1 : -1) * (Number(adj.quantity) || 0);
    });
    return Object.values(map)
      .map((m) => ({ ...m, balance: m.totalReceived + m.netAdjusted - m.totalIssued }))
      .sort((a, b) => a.material_name.localeCompare(b.material_name));
  }, [records, allTotals, adjustments]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return q ? stockData.filter((m) => m.material_name.toLowerCase().includes(q) || (m.category || "").toLowerCase().includes(q)) : stockData;
  }, [stockData, search]);

  return (
    <>
      <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-color)" }}>
        <input className="table-search" placeholder="Search material or category…"
          value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search stock" />
      </div>
      {filtered.length === 0 ? (
        <div className="empty-state"><p>No stock data available.</p></div>
      ) : (
        <div className="table-scroll" style={{ maxHeight: 520 }}>
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Material</th>
                <th scope="col">Category</th>
                <th scope="col">Unit</th>
                <th scope="col">Received</th>
                <th scope="col">Issued</th>
                <th scope="col">Adjusted</th>
                <th scope="col">Balance</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((m) => (
                <tr key={m.material_name}>
                  <td className="bold" data-label="Material">{m.material_name}</td>
                  <td data-label="Category">
                    {m.category ? <span className="inv-category-badge">{m.category}</span> : "—"}
                  </td>
                  <td data-label="Unit">{m.unit || "—"}</td>
                  <td className="mono" data-label="Received">{m.totalReceived.toLocaleString()}</td>
                  <td className="mono" data-label="Issued">{m.totalIssued.toLocaleString()}</td>
                  <td className="mono" data-label="Adjusted"
                    style={{ color: m.netAdjusted > 0 ? "#1E9E52" : m.netAdjusted < 0 ? "#dc3545" : undefined }}>
                    {m.netAdjusted > 0 ? `+${m.netAdjusted.toLocaleString()}` : m.netAdjusted.toLocaleString()}
                  </td>
                  <td data-label="Balance">
                    <span className={`issuance-balance-chip ${m.balance <= 0 ? "issuance-balance-chip--zero" : m.balance <= 10 ? "issuance-balance-chip--low" : ""}`}>
                      {m.balance.toLocaleString()}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// ─── Adjustments Panel ────────────────────────────────────────
function AdjustmentsPanel({ adjustments }) {
  if (adjustments.length === 0) {
    return (
      <div className="empty-state" style={{ padding: "48px 20px" }}>
        <p>No adjustments recorded.</p>
        <p className="empty-hint">Use Adjust Stock to record corrections, write-offs, or transfers.</p>
      </div>
    );
  }
  return (
    <div className="table-scroll table-mobile-cards" style={{ maxHeight: 520 }}>
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Material</th>
            <th scope="col">Type</th>
            <th scope="col">Qty</th>
            <th scope="col">Unit</th>
            <th scope="col">Reason</th>
            <th scope="col">By</th>
          </tr>
        </thead>
        <tbody>
          {adjustments.map((adj) => {
            const isAdd = ADJ_ADDS.has(adj.adjustmentType);
            return (
              <tr key={adj.id}>
                <td className="mono" data-label="Date">{adj.date || "—"}</td>
                <td className="bold" data-label="Material">{adj.materialName || "—"}</td>
                <td data-label="Type">
                  <span style={{ fontSize: 11, fontWeight: 600, padding: "2px 7px", borderRadius: 10,
                    background: isAdd ? "rgba(30,158,82,0.12)" : "rgba(220,53,69,0.12)",
                    color: isAdd ? "#1E9E52" : "#dc3545" }}>
                    {adj.adjustmentType || "—"}
                  </span>
                </td>
                <td className="mono" data-label="Qty"
                  style={{ color: isAdd ? "#1E9E52" : "#dc3545", fontWeight: 600 }}>
                  {isAdd ? "+" : "−"}{(Number(adj.quantity) || 0).toLocaleString()}
                </td>
                <td data-label="Unit">{adj.unit || "—"}</td>
                <td data-label="Reason" style={{ maxWidth: 200, whiteSpace: "normal", lineHeight: 1.4 }}>
                  {adj.reason || "—"}
                </td>
                <td data-label="By" style={{ fontSize: 12, color: "var(--text-muted)" }}>
                  {adj.adjustedByEmail || "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Issuances Panel ─────────────────────────────────────────
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

  if (loading) return <div className="loading-state" style={{ minHeight: 200 }}><div className="spinner" /><p>Loading issuance records…</p></div>;
  if (error)   return <div className="error-state" style={{ minHeight: 200 }}><span className="error-icon">!</span><p>Failed to load issuance records</p><p className="error-detail">{error}</p></div>;
  if (issuances.length === 0) return <div className="empty-state" style={{ padding: "48px 20px" }}><p>No issuances recorded yet.</p><p className="empty-hint">Use the Issue Item button to record items issued from inventory.</p></div>;

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
                <td className="mono" data-label="Code" style={{ fontSize: 11, color: "var(--text-muted)" }}>{r.itemCode || "—"}</td>
                <td data-label="Category">
                  {r.category ? <span className="inv-category-badge">{r.category}</span> : "—"}
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
                <td data-label="Issued By" style={{ fontSize: 12, color: "var(--text-muted)" }}>{r.issuedByEmail || "—"}</td>
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
  const user      = useUser();
  const matrix    = usePermissionMatrix();
  const canIssue  = canPerform(user, matrix, "inventory", "create");
  const canEdit   = canPerform(user, matrix, "inventory", "edit");
  const canDelete = canPerform(user, matrix, "inventory", "delete");

  const [records, setRecords]               = useState([]);
  const [receiptsRefresh, setReceiptsRefresh] = useState(0);
  const [allTotals, setAllTotals]           = useState({});
  const [recordsLoading, setRecordsLoading] = useState(true);
  const [totalsLoading, setTotalsLoading]   = useState(true);
  const [error, setError]                   = useState(null);
  const [search, setSearch]                 = useState("");
  const [filterCat, setFilterCat]           = useState("All");
  const [page, setPage]                     = useState(1);

  const [activeTab, setActiveTab]               = useState("receipts");
  const [issuanceTarget, setIssuanceTarget]     = useState(null);
  const [issuanceSuccess, setIssuanceSuccess]   = useState("");
  const [issuancesRefresh, setIssuancesRefresh] = useState(0);
  const [showAddReceipt, setShowAddReceipt]     = useState(false);
  const [receiptSuccess, setReceiptSuccess]     = useState("");
  const [editTarget, setEditTarget]             = useState(null);
  const [editSuccess, setEditSuccess]           = useState("");
  const [deleteTarget, setDeleteTarget]         = useState(null);
  const [deleting, setDeleting]                 = useState(false);
  const [adjustments, setAdjustments]           = useState([]);
  const [adjustmentsRefresh, setAdjustmentsRefresh] = useState(0);
  const [showAddAdjustment, setShowAddAdjustment]   = useState(false);
  const [adjustmentSuccess, setAdjustmentSuccess]   = useState("");

  useEffect(() => { if (!issuanceSuccess)   return; const t = setTimeout(() => setIssuanceSuccess(""),   5000); return () => clearTimeout(t); }, [issuanceSuccess]);
  useEffect(() => { if (!receiptSuccess)    return; const t = setTimeout(() => setReceiptSuccess(""),    5000); return () => clearTimeout(t); }, [receiptSuccess]);
  useEffect(() => { if (!editSuccess)       return; const t = setTimeout(() => setEditSuccess(""),       5000); return () => clearTimeout(t); }, [editSuccess]);
  useEffect(() => { if (!adjustmentSuccess) return; const t = setTimeout(() => setAdjustmentSuccess(""), 5000); return () => clearTimeout(t); }, [adjustmentSuccess]);

  useEffect(() => {
    let cancelled = false;
    setRecordsLoading(true);
    getReceipts()
      .then((rows) => { if (!cancelled) { setRecords(rows); setRecordsLoading(false); } })
      .catch((err) => { if (!cancelled) { setError(err.message); setRecordsLoading(false); } });
    return () => { cancelled = true; };
  }, [receiptsRefresh]);

  useEffect(() => {
    let cancelled = false;
    getIssuanceTotals()
      .then((totals) => { if (!cancelled) { setAllTotals(totals); setTotalsLoading(false); } })
      .catch(() => { if (!cancelled) setTotalsLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    getAdjustments().then(setAdjustments).catch(() => {});
  }, [adjustmentsRefresh]);

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

  const handleReceiptSuccess = useCallback((materialName) => {
    setShowAddReceipt(false);
    setReceiptSuccess(`"${materialName}" receipt recorded successfully.`);
    setReceiptsRefresh((n) => n + 1);
    getIssuanceTotals().then(setAllTotals).catch(() => {});
  }, []);

  const handleEditSuccess = useCallback((materialName) => {
    setEditTarget(null);
    setEditSuccess(`"${materialName}" receipt updated.`);
    setReceiptsRefresh((n) => n + 1);
  }, []);

  const handleDeleteReceipt = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    await deleteReceipt(deleteTarget.id);
    setDeleting(false);
    setDeleteTarget(null);
    setReceiptsRefresh((n) => n + 1);
  }, [deleteTarget]);

  const handleAdjustmentSuccess = useCallback((materialName) => {
    setShowAddAdjustment(false);
    setAdjustmentSuccess(`Adjustment for "${materialName}" recorded.`);
    setAdjustmentsRefresh((n) => n + 1);
  }, []);

  const handleIssuanceSuccess = useCallback((materialName, refNumber) => {
    setIssuanceTarget(null);
    setIssuanceSuccess(`${refNumber} — "${materialName}" issued successfully.`);
    setIssuancesRefresh((n) => n + 1);
    getIssuanceTotals().then(setAllTotals).catch(() => {});
  }, []);

  return (
    <div className="page-inventory">
      {/* ── KPI Summary ───────────────────────────── */}
      <section className="kpi-grid" style={{ marginBottom: 20 }} aria-label="Inventory summary">
        <div className="kpi-card">
          <div className="kpi-icon" style={{ background: "rgba(184,136,26,0.1)", color: "#B8881A" }} aria-hidden="true" />
          <div className="kpi-data">
            <span className="kpi-value">{recordsLoading ? "—" : totals.count}</span>
            <span className="kpi-title">Receipts</span>
            <span className="kpi-trend">Filtered entries</span>
          </div>
        </div>
        <div className="kpi-card">
          <div className="kpi-icon" style={{ background: "rgba(26,116,188,0.1)", color: "#1A74BC" }} aria-hidden="true" />
          <div className="kpi-data">
            <span className="kpi-value">{recordsLoading ? "—" : totals.categories}</span>
            <span className="kpi-title">Categories</span>
            <span className="kpi-trend">Material types</span>
          </div>
        </div>
        <div className="kpi-card">
          <div className="kpi-icon" style={{ background: "rgba(30,158,82,0.1)", color: "#1E9E52" }} aria-hidden="true" />
          <div className="kpi-data">
            <span className="kpi-value">{recordsLoading ? "—" : totals.totalQty.toLocaleString()}</span>
            <span className="kpi-title">Total Qty</span>
            <span className="kpi-trend">Units received</span>
          </div>
        </div>
        <div className="kpi-card">
          <div className="kpi-icon" style={{ background: "rgba(125,60,152,0.1)", color: "#7D3C98" }} aria-hidden="true" />
          <div className="kpi-data">
            <span className="kpi-value">{recordsLoading ? "—" : totals.suppliers}</span>
            <span className="kpi-title">Suppliers</span>
            <span className="kpi-trend">Unique suppliers</span>
          </div>
        </div>
      </section>

      {/* ── Main Panel ────────────────────────────── */}
      <section className="panel" aria-label="Inventory management">

        <div className="panel-header">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <h3>Inventory</h3>
            <span className="panel-badge">
              {{ receipts: `${totals.count} receipts`, stock: "Stock levels", issuances: "Issuance records", adjustments: "Adjustments" }[activeTab]}
            </span>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {canIssue && (
              <button className="issue-btn" onClick={() => setShowAddReceipt(true)} aria-label="Add receipt">
                + Add Receipt
              </button>
            )}
            {canEdit && (
              <button className="issue-btn" onClick={() => setShowAddAdjustment(true)} aria-label="Adjust stock">
                + Adjust Stock
              </button>
            )}
            {canIssue && (
              <button
                className={`issue-btn${totalsLoading ? " issue-btn--loading" : ""}`}
                onClick={() => setIssuanceTarget({})}
                aria-label="Issue item"
              >
                {totalsLoading ? "Loading…" : "+ Issue Item"}
              </button>
            )}
          </div>
        </div>

        <div className="inv-tab-bar" role="tablist" aria-label="Inventory sections">
          {[
            { id: "receipts",    label: "Receipts"    },
            { id: "stock",       label: "Stock"       },
            { id: "issuances",   label: "Issuances"   },
            { id: "adjustments", label: "Adjustments" },
          ].map((t) => (
            <button key={t.id} role="tab" aria-selected={activeTab === t.id}
              className={`inv-tab-btn ${activeTab === t.id ? "inv-tab-btn--active" : ""}`}
              onClick={() => setActiveTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>

        {/* ── Receipts Tab ──────────────────────── */}
        {activeTab === "receipts" && (
          <>
            {receiptSuccess    && <div className="issuance-success-banner" role="status">{receiptSuccess}</div>}
            {editSuccess       && <div className="issuance-success-banner" role="status">{editSuccess}</div>}
            {adjustmentSuccess && <div className="issuance-success-banner" role="status">{adjustmentSuccess}</div>}
            {issuanceSuccess   && <div className="issuance-success-banner" role="status">{issuanceSuccess}</div>}

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
                      <button key={cat}
                        className={`filter-btn ${filterCat === cat ? "filter-btn--active" : ""}`}
                        onClick={() => handleFilter(cat)} aria-pressed={filterCat === cat}>
                        {cat}
                      </button>
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
              {recordsLoading ? (
                <table className="data-table" aria-busy="true" aria-label="Loading inventory data">
                  <thead>
                    <tr>
                      <th>Date Received</th><th>Material</th><th>Category</th>
                      <th>Qty</th><th>Unit</th><th>Supplier</th><th>Received By</th><th>Remarks</th>
                      {canIssue && <th>Issue</th>}
                      {(canEdit || canDelete) && <th>Actions</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {Array.from({ length: 8 }).map((_, i) => (
                      <tr key={i} className="inv-skeleton-row">
                        <td><span className="inv-skeleton-cell inv-skeleton-cell--sm" /></td>
                        <td><span className="inv-skeleton-cell inv-skeleton-cell--lg" /></td>
                        <td><span className="inv-skeleton-cell inv-skeleton-cell--md" /></td>
                        <td><span className="inv-skeleton-cell inv-skeleton-cell--xs" /></td>
                        <td><span className="inv-skeleton-cell inv-skeleton-cell--xs" /></td>
                        <td><span className="inv-skeleton-cell inv-skeleton-cell--md" /></td>
                        <td><span className="inv-skeleton-cell inv-skeleton-cell--md" /></td>
                        <td><span className="inv-skeleton-cell inv-skeleton-cell--lg" /></td>
                        {canIssue && <td><span className="inv-skeleton-cell inv-skeleton-cell--sm" /></td>}
                        {(canEdit || canDelete) && <td><span className="inv-skeleton-cell inv-skeleton-cell--sm" /></td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : error ? (
                <div className="error-state" style={{ padding: "32px 20px" }}>
                  <span className="error-icon">!</span>
                  <p>Failed to load inventory data</p>
                  <p className="error-detail">{error}</p>
                </div>
              ) : filtered.length === 0 ? (
                <div className="empty-state">
                  <p>No records match your filters.</p>
                  <p className="empty-hint">Use Add Receipt to record new goods received.</p>
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
                      {canIssue && <th scope="col">Issue</th>}
                      {(canEdit || canDelete) && <th scope="col">Actions</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {pageItems.map((r) => (
                      <tr key={r.id}>
                        <td className="mono" data-label="Date">{fmt(r.date_time_received)}</td>
                        <td className="bold" data-label="Material">{r.material_name || "—"}</td>
                        <td data-label="Category">
                          {r.category ? <span className="inv-category-badge">{r.category}</span> : "—"}
                        </td>
                        <td className="mono" data-label="Qty">{r.quantity_received ?? "—"}</td>
                        <td data-label="Unit">{r.unit || "—"}</td>
                        <td data-label="Supplier">{r.supplier || "—"}</td>
                        <td data-label="Received By">{r.received_by || "—"}</td>
                        <td data-label="Notes" style={{ maxWidth: 200, whiteSpace: "normal", lineHeight: 1.4 }}>
                          {r.remarks || "—"}
                        </td>
                        {canIssue && (
                          <td data-label="">
                            <button className="issue-row-btn" onClick={() => setIssuanceTarget(r)}
                              aria-label={`Issue ${r.material_name || "item"}`}>
                              Issue
                            </button>
                          </td>
                        )}
                        {(canEdit || canDelete) && (
                          <td data-label="">
                            <div style={{ display: "flex", gap: 4 }}>
                              {canEdit && (
                                <button className="photo-view-btn" onClick={() => setEditTarget(r)}
                                  aria-label={`Edit ${r.material_name || "receipt"}`}>
                                  Edit
                                </button>
                              )}
                              {canDelete && (
                                <button className="photo-view-btn"
                                  style={{ color: "#dc3545", borderColor: "rgba(220,53,69,0.3)" }}
                                  onClick={() => setDeleteTarget(r)}
                                  aria-label={`Delete ${r.material_name || "receipt"}`}>
                                  Delete
                                </button>
                              )}
                            </div>
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

        {activeTab === "stock" && (
          <StockTab records={records} allTotals={allTotals} adjustments={adjustments} />
        )}

        {activeTab === "issuances" && (
          <>
            {!canIssue && <PermissionNotice department={user?.department} action="record new issuances" />}
            <IssuancesPanel refresh={issuancesRefresh} />
          </>
        )}

        {activeTab === "adjustments" && (
          <>
            {!canEdit && <PermissionNotice department={user?.department} action="record stock adjustments" />}
            <AdjustmentsPanel adjustments={adjustments} />
          </>
        )}
      </section>

      {/* ── Modals ──────────────────────────────── */}
      {showAddReceipt && (
        <ReceiptModal user={user} onClose={() => setShowAddReceipt(false)} onSuccess={handleReceiptSuccess} />
      )}

      {editTarget && (
        <ReceiptModal user={user} editRecord={editTarget}
          onClose={() => setEditTarget(null)} onSuccess={handleEditSuccess} />
      )}

      {deleteTarget && (
        <DeleteConfirmModal record={deleteTarget} deleting={deleting}
          onConfirm={handleDeleteReceipt} onCancel={() => setDeleteTarget(null)} />
      )}

      {showAddAdjustment && (
        <AddAdjustmentModal allRecords={records} user={user}
          onClose={() => setShowAddAdjustment(false)} onSuccess={handleAdjustmentSuccess} />
      )}

      {issuanceTarget !== null && (
        <IssuanceModal
          prefill={issuanceTarget}
          allRecords={records}
          allTotals={allTotals}
          user={user}
          onClose={() => setIssuanceTarget(null)}
          onSuccess={handleIssuanceSuccess}
        />
      )}
    </div>
  );
}

export default Inventory;
