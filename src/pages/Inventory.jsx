import { useEffect, useState, useMemo, useCallback, useRef } from "react";
import QRCode from "react-qr-code";
import { Html5QrcodeScanner } from "html5-qrcode";
import {
  addIssuance, getIssuances, getIssuanceTotals, generateIssueRef,
  getOrCreateInventoryItem, updateInventoryItem, getAllInventoryItems,
  getReceipts, addReceipt, updateReceipt, deleteReceipt,
  addAdjustment, getAdjustments,
  getPendingIssuances, approveIssuance, rejectIssuance,
  getInventorySettings,
} from "../services/issuanceService";
import { getSuppliers } from "../services/supplierService";
import { uploadReceiptDocument } from "../services/storageService";
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
  { key: "po_reference",       label: "PO Ref" },
  { key: "remarks",            label: "Remarks" },
];

const CSV_IMPORT_TEMPLATE = [
  "material_name,category,quantity_received,unit,supplier,received_by,date_received,remarks,expiry_date,po_reference",
  "Cement Bags,Building Materials,50,bags,ABC Supplies,John Doe,2025-01-15,,",
  "Steel Rods,Metals,100,pcs,XYZ Corp,Jane Smith,2025-01-16,Grade A,,PO-2025-001",
].join("\n");

const ADJ_ADDS  = new Set(["Correction (Add)", "Transfer In"]);
const PAGE_SIZE = 20;

function fmt(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}
function todayISO() { return new Date().toISOString().split("T")[0]; }

// ─── Pagination ───────────────────────────────────────────────
function Pagination({ page, totalPages, onChange }) {
  if (totalPages <= 1) return null;
  const pages   = Array.from({ length: totalPages }, (_, i) => i + 1);
  const visible = pages.filter((p) => p === 1 || p === totalPages || Math.abs(p - page) <= 1);
  return (
    <div className="pagination" role="navigation">
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

// ─── QR Modal ─────────────────────────────────────────────────
function QrModal({ item, onClose }) {
  const qrValue = `ARIMA:${item.materialName}:${item.itemCode || ""}`;
  useEffect(() => {
    const h = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  return (
    <div className="photo-modal-overlay" onClick={onClose} role="dialog" aria-modal="true">
      <div className="photo-modal feat-qr-modal" onClick={(e) => e.stopPropagation()}>
        <div className="photo-modal-header">
          <div>
            <span className="photo-modal-title">{item.materialName}</span>
            <span className="photo-modal-sub">{item.itemCode || "No item code"}</span>
          </div>
          <button className="photo-modal-close" onClick={onClose}>&#x2715;</button>
        </div>
        <div className="photo-modal-body" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 16, padding: "24px" }}>
          <div style={{ background: "#fff", padding: 16, borderRadius: 8, border: "1px solid var(--border-color)" }}>
            <QRCode value={qrValue} size={200} />
          </div>
          <div style={{ textAlign: "center" }}>
            <p className="bold" style={{ fontSize: 15 }}>{item.materialName}</p>
            <p style={{ fontSize: 12, color: "var(--text-muted)", fontFamily: "monospace" }}>{item.itemCode}</p>
          </div>
          <p style={{ fontSize: 11, color: "var(--text-muted)", textAlign: "center", maxWidth: 280 }}>
            Scan this code to pre-fill issue or receipt forms. Print and attach to storage location.
          </p>
          <button className="issue-btn" onClick={() => window.print()}>Print Label</button>
        </div>
      </div>
    </div>
  );
}

// ─── Scanner Modal ────────────────────────────────────────────
function ScannerModal({ onScan, onClose }) {
  const scannerRef  = useRef(null);
  const containerId = "arima-qr-reader";

  useEffect(() => {
    scannerRef.current = new Html5QrcodeScanner(
      containerId,
      { fps: 10, qrbox: { width: 240, height: 240 }, rememberLastUsedCamera: true },
      false
    );
    scannerRef.current.render(
      (text) => {
        if (scannerRef.current) {
          scannerRef.current.clear().catch(() => {}).finally(() => { onScan(text); onClose(); });
        }
      },
      () => {}
    );
    return () => {
      if (scannerRef.current) {
        scannerRef.current.clear().catch(() => {});
        scannerRef.current = null;
      }
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="photo-modal-overlay" onClick={onClose} role="dialog" aria-modal="true">
      <div className="photo-modal" style={{ maxWidth: 460 }} onClick={(e) => e.stopPropagation()}>
        <div className="photo-modal-header">
          <span className="photo-modal-title">Scan Item QR / Barcode</span>
          <button className="photo-modal-close" onClick={onClose}>&#x2715;</button>
        </div>
        <div className="photo-modal-body" style={{ padding: "16px" }}>
          <div id={containerId} />
          <p style={{ fontSize: 11, color: "var(--text-muted)", textAlign: "center", marginTop: 8 }}>
            Point at a QR code or barcode. The issue form opens automatically.
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── CSV Import Modal ─────────────────────────────────────────
function CsvImportModal({ suppliers, user, onClose, onSuccess }) {
  const [rows, setRows]         = useState([]);
  const [errors, setErrors]     = useState([]);
  const [importing, setImporting] = useState(false);
  const [result, setResult]     = useState(null);
  const [dragOver, setDragOver] = useState(false);

  const downloadTemplate = () => {
    const blob = new Blob([CSV_IMPORT_TEMPLATE], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "receipt-import-template.csv";
    a.click();
  };

  const parseFile = (file) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const text  = e.target.result;
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      if (lines.length < 2) { setErrors(["File appears empty or has no data rows."]); return; }

      const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
      const parsed  = [];
      const errs    = [];

      lines.slice(1).forEach((line, idx) => {
        const vals = line.split(",").map((v) => v.trim());
        const row  = Object.fromEntries(headers.map((h, i) => [h, vals[i] || ""]));

        if (!row.material_name) { errs.push(`Row ${idx + 2}: material_name is required`); return; }
        const qty = Number(row.quantity_received);
        if (!qty || qty <= 0)   { errs.push(`Row ${idx + 2}: quantity_received must be > 0`); return; }

        const dateMs = row.date_received
          ? new Date(row.date_received).getTime()
          : Date.now();
        const expiryMs = row.expiry_date ? new Date(row.expiry_date).getTime() : null;

        const supplierObj = suppliers.find((s) => s.name.toLowerCase() === (row.supplier || "").toLowerCase());

        parsed.push({
          material_name:      row.material_name,
          category:           row.category || "",
          quantity_received:  qty,
          unit:               row.unit || "",
          supplier:           row.supplier || "",
          supplierId:         supplierObj?.id || null,
          received_by:        row.received_by || user.email,
          date_time_received: dateMs,
          remarks:            row.remarks || "",
          po_reference:       row.po_reference || "",
          ...(expiryMs && { expiryDate: expiryMs }),
          addedByEmail:       user.email,
        });
      });

      setErrors(errs);
      setRows(parsed);
    };
    reader.readAsText(file);
  };

  const handleFileDrop = (e) => {
    e.preventDefault(); setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) parseFile(file);
  };

  const handleFileSelect = (e) => {
    const file = e.target.files[0];
    if (file) parseFile(file);
  };

  const handleImport = async () => {
    if (!rows.length) return;
    setImporting(true);
    let imported = 0;
    try {
      for (const row of rows) {
        await addReceipt(row);
        imported++;
      }
      setResult({ imported });
      onSuccess(imported);
    } catch (err) {
      setErrors([`Import failed at row ${imported + 1}: ${err.message}`]);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="photo-modal-overlay" onClick={onClose} role="dialog" aria-modal="true">
      <div className="photo-modal issuance-modal feat-csv-modal" onClick={(e) => e.stopPropagation()}>
        <div className="photo-modal-header">
          <div>
            <span className="photo-modal-title">Import Receipts from CSV</span>
            <span className="photo-modal-sub">Bulk-add goods received records</span>
          </div>
          <button className="photo-modal-close" onClick={onClose}>&#x2715;</button>
        </div>
        <div className="photo-modal-body">
          {result ? (
            <div style={{ textAlign: "center", padding: "32px 20px" }}>
              <p style={{ fontSize: 32, marginBottom: 8 }}>✓</p>
              <p className="bold" style={{ fontSize: 16 }}>Import Complete</p>
              <p style={{ color: "var(--text-muted)", marginTop: 4 }}>{result.imported} receipt{result.imported !== 1 ? "s" : ""} added successfully.</p>
              <button className="issuance-submit-btn" style={{ marginTop: 20 }} onClick={onClose}>Done</button>
            </div>
          ) : (
            <>
              {/* Drop zone */}
              <div
                className={`feat-csv-dropzone ${dragOver ? "feat-csv-dropzone--over" : ""}`}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={handleFileDrop}
              >
                <p>Drag &amp; drop a CSV file here, or</p>
                <label className="issuance-submit-btn" style={{ cursor: "pointer", marginTop: 8 }}>
                  Browse File
                  <input type="file" accept=".csv" style={{ display: "none" }} onChange={handleFileSelect} />
                </label>
                <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 8 }}>
                  <button className="photo-view-btn" onClick={downloadTemplate} type="button">
                    Download template
                  </button>
                </p>
              </div>

              {errors.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  {errors.map((e, i) => <p key={i} style={{ fontSize: 12, color: "#dc3545", marginBottom: 2 }}>⚠ {e}</p>)}
                </div>
              )}

              {rows.length > 0 && (
                <>
                  <p className="issuance-section-title" style={{ marginTop: 16 }}>
                    Preview — {rows.length} row{rows.length !== 1 ? "s" : ""} ready to import
                  </p>
                  <div className="table-scroll" style={{ maxHeight: 240, marginBottom: 12 }}>
                    <table className="data-table" style={{ fontSize: 12 }}>
                      <thead>
                        <tr><th>Material</th><th>Category</th><th>Qty</th><th>Unit</th><th>Supplier</th><th>Date</th></tr>
                      </thead>
                      <tbody>
                        {rows.map((r, i) => (
                          <tr key={i}>
                            <td className="bold">{r.material_name}</td>
                            <td>{r.category || "—"}</td>
                            <td className="mono">{r.quantity_received}</td>
                            <td>{r.unit || "—"}</td>
                            <td>{r.supplier || "—"}</td>
                            <td className="mono">{fmt(r.date_time_received)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                    <button className="issuance-cancel-btn" onClick={onClose} disabled={importing}>Cancel</button>
                    <button className="issuance-submit-btn" onClick={handleImport} disabled={importing}>
                      {importing ? "Importing…" : `Import ${rows.length} Record${rows.length !== 1 ? "s" : ""}`}
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Issuance Modal ───────────────────────────────────────────
function IssuanceModal({ prefill, allRecords, allTotals, user, approvalThreshold, onClose, onSuccess }) {
  const isPrefilled = !!prefill?.material_name;
  const materialOptions = useMemo(() => {
    const seen = new Map();
    allRecords.forEach((r) => {
      if (r.material_name && !seen.has(r.material_name))
        seen.set(r.material_name, { material_name: r.material_name, category: r.category || "", unit: r.unit || "" });
    });
    return [...seen.values()].sort((a, b) => a.material_name.localeCompare(b.material_name));
  }, [allRecords]);

  const [selectedName, setSelectedName] = useState(prefill?.material_name || "");
  const [itemMeta, setItemMeta]         = useState(null);
  const [metaLoading, setMetaLoading]   = useState(false);
  const [form, setForm] = useState({
    qtyIssued: "", issuedTo: "", department: "", purpose: "",
    remarks: "", date: todayISO(), projectCode: "",
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
    const mat = materialOptions.find((m) => m.material_name === selectedName) || {};
    setMetaLoading(true);
    getOrCreateInventoryItem(selectedName, { category: mat.category, unit: mat.unit })
      .then(setItemMeta).catch(() => setItemMeta({ itemCode: "—", warehouseLocation: "Main Store" }))
      .finally(() => setMetaLoading(false));
  }, [selectedName]); // eslint-disable-line react-hooks/exhaustive-deps

  const totalReceived = useMemo(() =>
    allRecords.filter((r) => r.material_name === selectedName)
      .reduce((s, r) => s + (Number(r.quantity_received) || 0), 0),
    [allRecords, selectedName]);
  const totalIssued   = allTotals?.[selectedName] || 0;
  const balance       = totalReceived - totalIssued;
  const selectedUnit  = itemMeta?.unit || materialOptions.find((m) => m.material_name === selectedName)?.unit || prefill?.unit || "";
  const selectedCat   = materialOptions.find((m) => m.material_name === selectedName)?.category || prefill?.category || "";
  const set           = (f) => (e) => setForm((p) => ({ ...p, [f]: e.target.value }));
  const needsApproval = !!approvalThreshold && Number(form.qtyIssued) > approvalThreshold;

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!selectedName)         { setError("Please select a material."); return; }
    const qty = Number(form.qtyIssued);
    if (!qty || qty <= 0)      { setError("Quantity must be greater than 0."); return; }
    if (qty > balance)         { setError(`Cannot issue ${qty.toLocaleString()} — only ${balance.toLocaleString()} ${selectedUnit} available.`); return; }
    if (!form.issuedTo.trim()) { setError("Recipient is required."); return; }
    if (!form.department.trim()) { setError("Department is required."); return; }

    setSubmitting(true); setError("");
    try {
      const issueRefNumber  = await generateIssueRef();
      const approvalStatus  = needsApproval ? "pending" : "auto-approved";
      await addIssuance({
        issueRefNumber,
        materialName:      selectedName,
        itemCode:          itemMeta?.itemCode || "",
        category:          selectedCat,
        unit:              selectedUnit,
        warehouseLocation: itemMeta?.warehouseLocation || "Main Store",
        qtyIssued:         qty,
        stockBefore:       balance,
        stockAfter:        needsApproval ? balance : balance - qty,
        issuedTo:          form.issuedTo.trim(),
        department:        form.department.trim(),
        projectCode:       form.projectCode.trim(),
        purpose:           form.purpose.trim(),
        remarks:           form.remarks.trim(),
        issuedByEmail:     user.email,
        dateOfIssuance:    form.date,
        approvalStatus,
      });
      onSuccess(selectedName, issueRefNumber, needsApproval);
    } catch {
      setError("Failed to record issuance. Please try again.");
      setSubmitting(false);
    }
  };

  const stockState    = balance <= 0 ? "zero" : balance <= 10 ? "low" : "ok";
  const todayPrefix   = new Date().toISOString().slice(0, 10).replace(/-/g, "");

  return (
    <div className="photo-modal-overlay" onClick={onClose} role="dialog" aria-modal="true">
      <div className="photo-modal issuance-modal" onClick={(e) => e.stopPropagation()}>
        <div className="photo-modal-header">
          <div>
            <span className="photo-modal-title">Issue Item</span>
            <span className="photo-modal-sub">Record an item issuance from inventory</span>
          </div>
          <button className="photo-modal-close" onClick={onClose}>&#x2715;</button>
        </div>
        <div className="photo-modal-body">
          {error && <div className="issuance-error" role="alert">{error}</div>}
          <form onSubmit={handleSubmit} className="issuance-form" noValidate>
            <p className="issuance-section-title">Item Selection</p>
            <div className="issuance-field" style={{ marginBottom: 16 }}>
              <label>Material <span className="issuance-required">*</span></label>
              {isPrefilled
                ? <input className="issuance-input issuance-input--readonly" value={selectedName} readOnly />
                : (
                  <select className="issuance-item-select" value={selectedName}
                    onChange={(e) => { setSelectedName(e.target.value); setError(""); }} required>
                    <option value="">— Select a material —</option>
                    {materialOptions.map((m) => <option key={m.material_name} value={m.material_name}>{m.material_name}</option>)}
                  </select>
                )}
            </div>

            {selectedName && (
              <>
                <p className="issuance-section-title">Item Details</p>
                {metaLoading ? <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 14 }}>Loading…</div> : (
                  <div className="issuance-meta-grid">
                    <div className="issuance-meta-item"><span className="issuance-meta-label">Item Code</span><span className="issuance-meta-value mono">{itemMeta?.itemCode || "—"}</span></div>
                    <div className="issuance-meta-item"><span className="issuance-meta-label">Category</span><span className="issuance-meta-value">{selectedCat || "—"}</span></div>
                    <div className="issuance-meta-item"><span className="issuance-meta-label">Unit</span><span className="issuance-meta-value">{selectedUnit || "—"}</span></div>
                    <div className="issuance-meta-item"><span className="issuance-meta-label">Location</span><span className="issuance-meta-value">{itemMeta?.warehouseLocation || "Main Store"}</span></div>
                  </div>
                )}
                <div className={`issuance-stock-card issuance-stock-card--${stockState}`}>
                  <div style={{ flex: 1 }}>
                    <span className="issuance-stock-label">Available Stock</span>
                    <div>
                      <span className={`issuance-stock-number issuance-stock-number--${stockState}`}>{balance.toLocaleString()}</span>
                      {selectedUnit && <span className="issuance-stock-unit">{selectedUnit}</span>}
                    </div>
                    <span className="issuance-stock-detail">Received: {totalReceived.toLocaleString()} · Issued: {totalIssued.toLocaleString()}</span>
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
                      className="issuance-input" placeholder="0" required disabled={balance <= 0} />
                  </div>
                  <div className="issuance-field">
                    <label>Recipient <span className="issuance-required">*</span></label>
                    <input type="text" value={form.issuedTo} onChange={set("issuedTo")} className="issuance-input" placeholder="Name or ID" required />
                  </div>
                  <div className="issuance-field">
                    <label>Department <span className="issuance-required">*</span></label>
                    <input type="text" value={form.department} onChange={set("department")} className="issuance-input" placeholder="e.g. Operations" required />
                  </div>
                  <div className="issuance-field">
                    <label>Project / Cost Centre</label>
                    <input type="text" value={form.projectCode} onChange={set("projectCode")} className="issuance-input" placeholder="e.g. PROJ-001" />
                  </div>
                  <div className="issuance-field">
                    <label>Date of Issuance</label>
                    <input type="date" value={form.date} onChange={set("date")} className="issuance-input" required />
                  </div>
                </div>
                <div className="issuance-field" style={{ marginTop: 10 }}>
                  <label>Purpose</label>
                  <textarea value={form.purpose} onChange={set("purpose")} rows={2} className="issuance-textarea" placeholder="Reason for issuance (optional)" />
                </div>
                <div className="issuance-field" style={{ marginTop: 8 }}>
                  <label>Remarks</label>
                  <textarea value={form.remarks} onChange={set("remarks")} rows={2} className="issuance-textarea" placeholder="Additional notes (optional)" />
                </div>

                {needsApproval && (
                  <div className="feat-approval-notice">
                    ⚠ This quantity ({Number(form.qtyIssued).toLocaleString()} {selectedUnit}) exceeds the approval threshold ({approvalThreshold}).
                    It will be submitted as <strong>Pending Approval</strong> and stock will not be deducted until a supervisor approves.
                  </div>
                )}
              </>
            )}

            <div className="issuance-form-footer">
              <div className="issuance-footer-meta">
                <span className="issuance-ref-preview">Ref: ISS-{todayPrefix}-auto</span>
                <span className="issuance-by-label">By: <strong>{user.email}</strong></span>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" className="issuance-cancel-btn" onClick={onClose} disabled={submitting}>Cancel</button>
                <button type="submit" className="issuance-submit-btn" disabled={submitting || !selectedName || balance <= 0}
                  style={needsApproval ? { background: "#D4820A", borderColor: "#D4820A" } : {}}>
                  {submitting ? "Saving…" : needsApproval ? "Submit for Approval" : "Record Issuance"}
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
function ReceiptModal({ user, editRecord, suppliers, onClose, onSuccess }) {
  const isEdit = !!editRecord;
  const [form, setForm] = useState({
    material_name:     editRecord?.material_name     || "",
    category:          editRecord?.category          || "",
    quantity_received: editRecord?.quantity_received || "",
    unit:              editRecord?.unit              || "",
    supplierId:        editRecord?.supplierId        || "",
    supplier:          editRecord?.supplier          || "",
    received_by:       editRecord?.received_by       || "",
    po_reference:      editRecord?.po_reference      || "",
    remarks:           editRecord?.remarks           || "",
    date: editRecord?.date_time_received
      ? new Date(editRecord.date_time_received).toISOString().split("T")[0] : todayISO(),
    expiryDate: editRecord?.expiryDate
      ? new Date(editRecord.expiryDate).toISOString().split("T")[0] : "",
  });
  const [files, setFiles]         = useState([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError]           = useState("");

  useEffect(() => {
    const h = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const set = (f) => (e) => setForm((p) => ({ ...p, [f]: e.target.value }));

  const handleSupplierChange = (e) => {
    const id  = e.target.value;
    const sup = suppliers.find((s) => s.id === id);
    setForm((p) => ({ ...p, supplierId: id, supplier: sup?.name || "" }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.material_name.trim()) { setError("Material name is required."); return; }
    const qty = Number(form.quantity_received);
    if (!qty || qty <= 0)           { setError("Quantity must be greater than 0."); return; }
    if (!form.date)                 { setError("Date received is required."); return; }

    setSubmitting(true); setError("");

    // Upload documents if any
    let documents = editRecord?.documents || [];
    if (files.length > 0) {
      setUploading(true);
      const receiptId = isEdit ? editRecord.id : `tmp_${Date.now()}`;
      try {
        for (const file of files) {
          const doc = await uploadReceiptDocument(receiptId, file, (pct) => {
            setUploadProgress((p) => ({ ...p, [file.name]: pct }));
          });
          documents = [...documents, doc];
        }
      } catch (err) {
        setError("File upload failed: " + err.message);
        setSubmitting(false);
        setUploading(false);
        return;
      }
      setUploading(false);
    }

    const payload = {
      material_name:      form.material_name.trim(),
      category:           form.category.trim(),
      quantity_received:  qty,
      unit:               form.unit.trim(),
      supplierId:         form.supplierId || null,
      supplier:           form.supplier.trim(),
      received_by:        form.received_by.trim() || user.email,
      date_time_received: new Date(form.date).getTime(),
      po_reference:       form.po_reference.trim(),
      remarks:            form.remarks.trim(),
      ...(form.expiryDate && { expiryDate: new Date(form.expiryDate).getTime() }),
      ...(documents.length && { documents }),
    };

    try {
      if (isEdit) {
        await updateReceipt(editRecord.id, payload, user);
      } else {
        await addReceipt({ ...payload, addedByEmail: user.email });
      }
      onSuccess(payload.material_name);
    } catch {
      setError("Failed to save receipt. Please try again.");
      setSubmitting(false);
    }
  };

  const existingDocs = editRecord?.documents || [];

  return (
    <div className="photo-modal-overlay" onClick={onClose} role="dialog" aria-modal="true">
      <div className="photo-modal issuance-modal" onClick={(e) => e.stopPropagation()}>
        <div className="photo-modal-header">
          <div>
            <span className="photo-modal-title">{isEdit ? "Edit Receipt" : "Add Receipt"}</span>
            <span className="photo-modal-sub">{isEdit ? "Update receipt details" : "Record goods received into inventory"}</span>
          </div>
          <button className="photo-modal-close" onClick={onClose}>&#x2715;</button>
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
                <input type="text" value={form.category} onChange={set("category")} className="issuance-input" placeholder="e.g. Building Materials" />
              </div>
              <div className="issuance-field">
                <label>Unit</label>
                <input type="text" value={form.unit} onChange={set("unit")} className="issuance-input" placeholder="bags, kg, pcs…" />
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
                <span style={{ fontSize: 11, color: "#8B96A6", marginTop: 3, display: "block" }}>
                  Enter the date goods physically arrived — not today's date if received earlier.
                </span>
              </div>
              <div className="issuance-field">
                <label>Expiry Date</label>
                <input type="date" value={form.expiryDate} onChange={set("expiryDate")} className="issuance-input" />
              </div>
              <div className="issuance-field">
                <label>PO / GRN Reference</label>
                <input type="text" value={form.po_reference} onChange={set("po_reference")} className="issuance-input" placeholder="e.g. PO-2025-001" />
              </div>
            </div>
            <div className="issuance-form-grid">
              <div className="issuance-field">
                <label>Supplier</label>
                {suppliers.length > 0 ? (
                  <select className="issuance-item-select" value={form.supplierId} onChange={handleSupplierChange}>
                    <option value="">— Select or type —</option>
                    {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                ) : (
                  <input type="text" value={form.supplier} onChange={set("supplier")} className="issuance-input" placeholder="Supplier name" />
                )}
              </div>
              <div className="issuance-field">
                <label>Received By</label>
                <input type="text" value={form.received_by} onChange={set("received_by")} className="issuance-input" placeholder={user.email} />
              </div>
            </div>
            <div className="issuance-field" style={{ marginTop: 10 }}>
              <label>Remarks</label>
              <textarea value={form.remarks} onChange={set("remarks")} rows={2} className="issuance-textarea" placeholder="Notes (optional)" />
            </div>

            {/* Document upload */}
            <div className="issuance-section-divider" />
            <p className="issuance-section-title">Attachments</p>
            {existingDocs.length > 0 && (
              <div style={{ marginBottom: 10 }}>
                {existingDocs.map((d, i) => (
                  <a key={i} href={d.url} target="_blank" rel="noopener noreferrer"
                    className="feat-doc-link">{d.name}</a>
                ))}
              </div>
            )}
            <input type="file" multiple className="feat-file-input"
              accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
              onChange={(e) => setFiles(Array.from(e.target.files))} />
            {files.length > 0 && (
              <div style={{ marginTop: 6 }}>
                {files.map((f) => (
                  <div key={f.name} style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 2 }}>
                    {f.name} {uploadProgress[f.name] != null && `— ${uploadProgress[f.name]}%`}
                  </div>
                ))}
              </div>
            )}
            {uploading && <p style={{ fontSize: 12, color: "var(--accent-orange)", marginTop: 4 }}>Uploading files…</p>}

            <div className="issuance-form-footer">
              <span className="issuance-by-label">{isEdit ? "Edited" : "Added"} by: <strong>{user.email}</strong></span>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" className="issuance-cancel-btn" onClick={onClose} disabled={submitting}>Cancel</button>
                <button type="submit" className="issuance-submit-btn" disabled={submitting || uploading}>
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
    <div className="photo-modal-overlay" onClick={onCancel} role="dialog" aria-modal="true">
      <div className="photo-modal" style={{ maxWidth: 420 }} onClick={(e) => e.stopPropagation()}>
        <div className="photo-modal-header">
          <span className="photo-modal-title">Delete Receipt</span>
          <button className="photo-modal-close" onClick={onCancel}>&#x2715;</button>
        </div>
        <div className="photo-modal-body" style={{ padding: "20px 24px" }}>
          <p style={{ marginBottom: 16 }}>
            Remove <strong>{record.material_name}</strong> ({record.quantity_received} {record.unit}) from inventory? This cannot be undone.
          </p>
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button className="issuance-cancel-btn" onClick={onCancel} disabled={deleting}>Cancel</button>
            <button className="issuance-submit-btn" style={{ background: "#dc3545", borderColor: "#dc3545" }}
              onClick={onConfirm} disabled={deleting}>
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

function AddAdjustmentModal({ allRecords, user, onClose, onSuccess }) {
  const materialOptions = useMemo(() => {
    const seen = new Set();
    return allRecords
      .filter((r) => r.material_name && !seen.has(r.material_name) && seen.add(r.material_name))
      .map((r) => ({ material_name: r.material_name, category: r.category || "", unit: r.unit || "" }))
      .sort((a, b) => a.material_name.localeCompare(b.material_name));
  }, [allRecords]);

  const [form, setForm] = useState({ materialName: "", adjustmentType: ADJUSTMENT_TYPES[0], quantity: "", reason: "", date: todayISO() });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError]           = useState("");
  useEffect(() => { const h = (e) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h); }, [onClose]);
  const set      = (f) => (e) => setForm((p) => ({ ...p, [f]: e.target.value }));
  const selected = materialOptions.find((m) => m.material_name === form.materialName);
  const isAdd    = ADJ_ADDS.has(form.adjustmentType);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.materialName) { setError("Select a material."); return; }
    const qty = Number(form.quantity);
    if (!qty || qty <= 0)   { setError("Quantity must be > 0."); return; }
    setSubmitting(true); setError("");
    try {
      await addAdjustment({ materialName: form.materialName, category: selected?.category || "", unit: selected?.unit || "", adjustmentType: form.adjustmentType, quantity: qty, reason: form.reason.trim(), date: form.date, adjustedByEmail: user.email });
      onSuccess(form.materialName);
    } catch { setError("Failed to save adjustment."); setSubmitting(false); }
  };

  return (
    <div className="photo-modal-overlay" onClick={onClose} role="dialog" aria-modal="true">
      <div className="photo-modal issuance-modal" onClick={(e) => e.stopPropagation()}>
        <div className="photo-modal-header"><div><span className="photo-modal-title">Stock Adjustment</span><span className="photo-modal-sub">Corrections, write-offs, and transfers</span></div><button className="photo-modal-close" onClick={onClose}>&#x2715;</button></div>
        <div className="photo-modal-body">
          {error && <div className="issuance-error">{error}</div>}
          <form onSubmit={handleSubmit} className="issuance-form" noValidate>
            <p className="issuance-section-title">Adjustment Details</p>
            <div className="issuance-field" style={{ marginBottom: 14 }}>
              <label>Material <span className="issuance-required">*</span></label>
              <select className="issuance-item-select" value={form.materialName} onChange={set("materialName")} required>
                <option value="">— Select —</option>
                {materialOptions.map((m) => <option key={m.material_name} value={m.material_name}>{m.material_name}</option>)}
              </select>
            </div>
            <div className="issuance-form-grid">
              <div className="issuance-field"><label>Type</label><select className="issuance-item-select" value={form.adjustmentType} onChange={set("adjustmentType")}>{ADJUSTMENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</select></div>
              <div className="issuance-field"><label>Quantity</label><input type="number" value={form.quantity} onChange={set("quantity")} min="0.01" step="any" className="issuance-input" placeholder="0" required /></div>
              <div className="issuance-field"><label>Date</label><input type="date" value={form.date} onChange={set("date")} className="issuance-input" required /></div>
            </div>
            {selected && <div style={{ fontSize: 12, color: isAdd ? "#1E9E52" : "#dc3545", fontWeight: 600, marginBottom: 12 }}>Effect: {isAdd ? "+" : "−"}{form.quantity || 0} {selected.unit}</div>}
            <div className="issuance-field"><label>Reason</label><textarea value={form.reason} onChange={set("reason")} rows={2} className="issuance-textarea" placeholder="Reason (optional)" /></div>
            <div className="issuance-form-footer">
              <span className="issuance-by-label">By: <strong>{user.email}</strong></span>
              <div style={{ display: "flex", gap: 8 }}><button type="button" className="issuance-cancel-btn" onClick={onClose} disabled={submitting}>Cancel</button><button type="submit" className="issuance-submit-btn" disabled={submitting}>{submitting ? "Saving…" : "Save Adjustment"}</button></div>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

// ─── Stock Tab ────────────────────────────────────────────────
function StockTab({ records, allTotals, adjustments, inventoryItems, onQrClick, onReorderSave }) {
  const [search, setSearch] = useState("");
  const [editingReorder, setEditingReorder] = useState({}); // { key: value }

  const itemMap = useMemo(() => Object.fromEntries(inventoryItems.map((i) => [i.materialName, i])), [inventoryItems]);

  const stockData = useMemo(() => {
    const map = {};
    records.forEach((r) => {
      const name = r.material_name; if (!name) return;
      if (!map[name]) map[name] = { material_name: name, category: r.category || "", unit: r.unit || "", totalReceived: 0, totalIssued: 0, netAdjusted: 0 };
      map[name].totalReceived += Number(r.quantity_received) || 0;
      if (!map[name].unit && r.unit) map[name].unit = r.unit;
    });
    Object.entries(allTotals).forEach(([name, qty]) => { if (map[name]) map[name].totalIssued = qty; });
    adjustments.forEach((adj) => {
      const name = adj.materialName; if (!name) return;
      if (!map[name]) map[name] = { material_name: name, category: adj.category || "", unit: adj.unit || "", totalReceived: 0, totalIssued: 0, netAdjusted: 0 };
      map[name].netAdjusted += (ADJ_ADDS.has(adj.adjustmentType) ? 1 : -1) * (Number(adj.quantity) || 0);
    });
    return Object.values(map).map((m) => {
      const item        = itemMap[m.material_name];
      const balance     = m.totalReceived + m.netAdjusted - m.totalIssued;
      const reorderPoint = Number(item?.reorderPoint) ?? 10;
      return { ...m, balance, reorderPoint, itemCode: item?.itemCode, itemId: item?.id };
    }).sort((a, b) => a.material_name.localeCompare(b.material_name));
  }, [records, allTotals, adjustments, itemMap]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return q ? stockData.filter((m) => m.material_name.toLowerCase().includes(q) || (m.category || "").toLowerCase().includes(q)) : stockData;
  }, [stockData, search]);

  const handleReorderChange = (key, val) => setEditingReorder((p) => ({ ...p, [key]: val }));
  const handleReorderSave   = async (item) => {
    const val = Number(editingReorder[item.material_name]);
    if (isNaN(val) || val < 0) return;
    await onReorderSave(item, val);
    setEditingReorder((p) => { const n = { ...p }; delete n[item.material_name]; return n; });
  };

  return (
    <>
      <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-color)" }}>
        <input className="table-search" placeholder="Search material or category…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      {filtered.length === 0 ? <div className="empty-state"><p>No stock data.</p></div> : (
        <div className="table-scroll" style={{ maxHeight: 520 }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Material</th><th>Category</th><th>Unit</th>
                <th>Received</th><th>Issued</th><th>Adjusted</th><th>Balance</th>
                <th>Reorder Point</th><th>QR</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((m) => {
                const isLow    = m.balance <= m.reorderPoint;
                const isOut    = m.balance <= 0;
                const editing  = m.material_name in editingReorder;
                return (
                  <tr key={m.material_name} className={isOut ? "feat-row--out" : isLow ? "feat-row--low" : ""}>
                    <td className="bold" data-label="Material">
                      {m.material_name}
                      {isOut && <span className="feat-stock-badge feat-stock-badge--out">Out</span>}
                      {!isOut && isLow && <span className="feat-stock-badge feat-stock-badge--low">Low</span>}
                    </td>
                    <td data-label="Category">{m.category ? <span className="inv-category-badge">{m.category}</span> : "—"}</td>
                    <td data-label="Unit">{m.unit || "—"}</td>
                    <td className="mono">{m.totalReceived.toLocaleString()}</td>
                    <td className="mono">{m.totalIssued.toLocaleString()}</td>
                    <td className="mono" style={{ color: m.netAdjusted > 0 ? "#1E9E52" : m.netAdjusted < 0 ? "#dc3545" : undefined }}>
                      {m.netAdjusted > 0 ? `+${m.netAdjusted.toLocaleString()}` : m.netAdjusted.toLocaleString()}
                    </td>
                    <td data-label="Balance">
                      <span className={`issuance-balance-chip ${isOut ? "issuance-balance-chip--zero" : isLow ? "issuance-balance-chip--low" : ""}`}>
                        {m.balance.toLocaleString()}
                      </span>
                    </td>
                    <td data-label="Reorder" style={{ whiteSpace: "nowrap" }}>
                      {editing ? (
                        <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                          <input type="number" value={editingReorder[m.material_name]} min="0"
                            onChange={(e) => handleReorderChange(m.material_name, e.target.value)}
                            className="issuance-input" style={{ width: 70, padding: "3px 6px" }}
                            onKeyDown={(e) => { if (e.key === "Enter") handleReorderSave(m); if (e.key === "Escape") setEditingReorder((p) => { const n = { ...p }; delete n[m.material_name]; return n; }); }}
                            autoFocus
                          />
                          <button className="photo-view-btn" style={{ padding: "3px 8px", fontSize: 11 }} onClick={() => handleReorderSave(m)}>✓</button>
                        </div>
                      ) : (
                        <button className="feat-reorder-btn" onClick={() => handleReorderChange(m.material_name, String(m.reorderPoint))}>
                          {m.reorderPoint} <span style={{ opacity: 0.5, fontSize: 10 }}>✏</span>
                        </button>
                      )}
                    </td>
                    <td>
                      {m.itemCode && (
                        <button className="photo-view-btn" style={{ padding: "3px 8px", fontSize: 11 }}
                          onClick={() => onQrClick({ materialName: m.material_name, itemCode: m.itemCode })}>
                          QR
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
    </>
  );
}

// ─── Adjustments Panel ────────────────────────────────────────
function AdjustmentsPanel({ adjustments }) {
  if (!adjustments.length) return <div className="empty-state" style={{ padding: "48px 20px" }}><p>No adjustments recorded.</p><p className="empty-hint">Use Adjust Stock to record corrections, write-offs, or transfers.</p></div>;
  return (
    <div className="table-scroll table-mobile-cards" style={{ maxHeight: 520 }}>
      <table className="data-table">
        <thead><tr><th>Date</th><th>Material</th><th>Type</th><th>Qty</th><th>Unit</th><th>Reason</th><th>By</th></tr></thead>
        <tbody>
          {adjustments.map((adj) => {
            const isAdd = ADJ_ADDS.has(adj.adjustmentType);
            return (
              <tr key={adj.id}>
                <td className="mono">{adj.date || "—"}</td>
                <td className="bold">{adj.materialName || "—"}</td>
                <td><span style={{ fontSize: 11, fontWeight: 600, padding: "2px 7px", borderRadius: 10, background: isAdd ? "rgba(30,158,82,0.12)" : "rgba(220,53,69,0.12)", color: isAdd ? "#1E9E52" : "#dc3545" }}>{adj.adjustmentType || "—"}</span></td>
                <td className="mono" style={{ color: isAdd ? "#1E9E52" : "#dc3545", fontWeight: 600 }}>{isAdd ? "+" : "−"}{(Number(adj.quantity) || 0).toLocaleString()}</td>
                <td>{adj.unit || "—"}</td>
                <td style={{ maxWidth: 200, whiteSpace: "normal" }}>{adj.reason || "—"}</td>
                <td style={{ fontSize: 12, color: "var(--text-muted)" }}>{adj.adjustedByEmail || "—"}</td>
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
    setLoading(true); setError(null);
    getIssuances().then(setIssuances).catch((err) => setError(err.message)).finally(() => setLoading(false));
  }, [refresh]);

  if (loading) return <div className="loading-state" style={{ minHeight: 200 }}><div className="spinner" /><p>Loading…</p></div>;
  if (error)   return <div className="error-state"><span className="error-icon">!</span><p>{error}</p></div>;
  if (!issuances.length) return <div className="empty-state" style={{ padding: "48px 20px" }}><p>No issuances yet.</p></div>;

  return (
    <>
      <div className="table-scroll table-mobile-cards" style={{ maxHeight: 520 }}>
        <table className="data-table">
          <thead>
            <tr><th>Ref</th><th>Date</th><th>Material</th><th>Qty</th><th>Unit</th><th>Project</th><th>Issued To</th><th>Department</th><th>Stock After</th><th>Status</th><th>By</th></tr>
          </thead>
          <tbody>
            {issuances.map((r) => {
              const status = r.approvalStatus || "auto-approved";
              return (
                <tr key={r.id}>
                  <td>{r.issueRefNumber ? <span className="issuance-ref-chip">{r.issueRefNumber}</span> : "—"}</td>
                  <td className="mono">{r.dateOfIssuance || "—"}</td>
                  <td className="bold">{r.materialName || "—"}</td>
                  <td className="mono">{r.qtyIssued ?? "—"}</td>
                  <td>{r.unit || "—"}</td>
                  <td style={{ fontSize: 12 }}>{r.projectCode || "—"}</td>
                  <td>{r.issuedTo || "—"}</td>
                  <td>{r.department || "—"}</td>
                  <td>{r.stockAfter != null ? <span className={`issuance-balance-chip ${r.stockAfter <= 0 ? "issuance-balance-chip--zero" : r.stockAfter <= 10 ? "issuance-balance-chip--low" : ""}`}>{r.stockAfter.toLocaleString()}</span> : "—"}</td>
                  <td>
                    <span className={`feat-approval-chip feat-approval-chip--${status === "pending" ? "pending" : status === "rejected" ? "rejected" : "approved"}`}>
                      {status === "auto-approved" ? "Approved" : status.charAt(0).toUpperCase() + status.slice(1)}
                    </span>
                  </td>
                  <td style={{ fontSize: 12, color: "var(--text-muted)" }}>{r.issuedByEmail || "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="issuance-panel-footer">{issuances.length} records</div>
    </>
  );
}

// ─── Pending Approvals Panel ──────────────────────────────────
function PendingApprovalsPanel({ refresh, user, onApproved }) {
  const [pending, setPending] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy]       = useState({});

  useEffect(() => {
    setLoading(true);
    getPendingIssuances().then(setPending).catch(console.error).finally(() => setLoading(false));
  }, [refresh]);

  const handle = async (id, action) => {
    setBusy((p) => ({ ...p, [id]: action }));
    try {
      if (action === "approve") await approveIssuance(id, user);
      else                      await rejectIssuance(id, user);
      setPending((p) => p.filter((r) => r.id !== id));
      onApproved();
    } catch (err) { alert("Failed: " + err.message); }
    finally { setBusy((p) => { const n = { ...p }; delete n[id]; return n; }); }
  };

  if (loading) return <div className="loading-state" style={{ minHeight: 120 }}><div className="spinner" /><p>Loading…</p></div>;
  if (!pending.length) return <div className="empty-state" style={{ padding: "48px 20px" }}><p>No pending approvals.</p><p className="empty-hint">Large issuances that exceed the approval threshold will appear here.</p></div>;

  return (
    <div className="table-scroll" style={{ maxHeight: 520 }}>
      <table className="data-table">
        <thead>
          <tr><th>Ref</th><th>Date</th><th>Material</th><th>Qty</th><th>Unit</th><th>Project</th><th>Requested By</th><th>Department</th><th>Purpose</th><th>Actions</th></tr>
        </thead>
        <tbody>
          {pending.map((r) => (
            <tr key={r.id}>
              <td>{r.issueRefNumber ? <span className="issuance-ref-chip">{r.issueRefNumber}</span> : "—"}</td>
              <td className="mono">{r.dateOfIssuance || "—"}</td>
              <td className="bold">{r.materialName || "—"}</td>
              <td className="mono" style={{ fontWeight: 700 }}>{r.qtyIssued ?? "—"}</td>
              <td>{r.unit || "—"}</td>
              <td style={{ fontSize: 12 }}>{r.projectCode || "—"}</td>
              <td style={{ fontSize: 12 }}>{r.issuedByEmail || "—"}</td>
              <td>{r.department || "—"}</td>
              <td style={{ maxWidth: 160, whiteSpace: "normal", fontSize: 12 }}>{r.purpose || "—"}</td>
              <td>
                <div style={{ display: "flex", gap: 4 }}>
                  <button className="admin-approve-btn" disabled={!!busy[r.id]}
                    onClick={() => handle(r.id, "approve")}>
                    {busy[r.id] === "approve" ? "…" : "Approve"}
                  </button>
                  <button className="admin-revoke-btn" disabled={!!busy[r.id]}
                    onClick={() => handle(r.id, "reject")}>
                    {busy[r.id] === "reject" ? "…" : "Reject"}
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────
function Inventory() {
  const user        = useUser();
  const matrix      = usePermissionMatrix();
  const canIssue    = canPerform(user, matrix, "inventory", "create");
  const canEdit     = canPerform(user, matrix, "inventory", "edit");
  const canDelete   = canPerform(user, matrix, "inventory", "delete");
  const canApprove  = canPerform(user, matrix, "inventory", "approve");

  const [records, setRecords]               = useState([]);
  const [receiptsRefresh, setReceiptsRefresh] = useState(0);
  const [allTotals, setAllTotals]           = useState({});
  const [recordsLoading, setRecordsLoading] = useState(true);
  const [totalsLoading, setTotalsLoading]   = useState(true);
  const [error, setError]                   = useState(null);
  const [search, setSearch]                 = useState("");
  const [filterCat, setFilterCat]           = useState("All");
  const [page, setPage]                     = useState(1);

  const [suppliers, setSuppliers]           = useState([]);
  const [inventoryItems, setInventoryItems] = useState([]);
  const [inventorySettings, setInventorySettings] = useState({ issuanceApprovalThreshold: 0 });
  const [pendingCount, setPendingCount]     = useState(0);
  const [pendingRefresh, setPendingRefresh] = useState(0);

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

  const [qrTarget, setQrTarget]             = useState(null);
  const [showScanModal, setShowScanModal]   = useState(false);
  const [showCsvImport, setShowCsvImport]   = useState(false);

  // Auto-clear banners
  useEffect(() => { if (!issuanceSuccess)   return; const t = setTimeout(() => setIssuanceSuccess(""),   5000); return () => clearTimeout(t); }, [issuanceSuccess]);
  useEffect(() => { if (!receiptSuccess)    return; const t = setTimeout(() => setReceiptSuccess(""),    5000); return () => clearTimeout(t); }, [receiptSuccess]);
  useEffect(() => { if (!editSuccess)       return; const t = setTimeout(() => setEditSuccess(""),       5000); return () => clearTimeout(t); }, [editSuccess]);
  useEffect(() => { if (!adjustmentSuccess) return; const t = setTimeout(() => setAdjustmentSuccess(""), 5000); return () => clearTimeout(t); }, [adjustmentSuccess]);

  // Initial data load
  useEffect(() => {
    let cancelled = false;
    setRecordsLoading(true);
    Promise.all([getReceipts(), getAllInventoryItems(), getSuppliers(), getInventorySettings()])
      .then(([r, items, sups, settings]) => {
        if (cancelled) return;
        setRecords(r); setInventoryItems(items); setSuppliers(sups); setInventorySettings(settings);
        setRecordsLoading(false);
      })
      .catch((err) => { if (!cancelled) { setError(err.message); setRecordsLoading(false); } });
    return () => { cancelled = true; };
  }, [receiptsRefresh]);

  useEffect(() => {
    let cancelled = false;
    getIssuanceTotals().then((t) => { if (!cancelled) { setAllTotals(t); setTotalsLoading(false); } }).catch(() => { if (!cancelled) setTotalsLoading(false); });
    return () => { cancelled = true; };
  }, [receiptsRefresh, pendingRefresh]);

  useEffect(() => { getAdjustments().then(setAdjustments).catch(() => {}); }, [adjustmentsRefresh]);

  // Pending count for badge
  useEffect(() => {
    if (!canApprove) return;
    getPendingIssuances().then((p) => setPendingCount(p.length)).catch(() => {});
  }, [canApprove, pendingRefresh]);

  const categories = useMemo(() => {
    const cats = [...new Set(records.map((r) => r.category).filter(Boolean))].sort();
    return ["All", ...cats];
  }, [records]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return records.filter((r) => {
      const matchCat    = filterCat === "All" || r.category === filterCat;
      const matchSearch = !q || (r.material_name || "").toLowerCase().includes(q)
        || (r.received_by || "").toLowerCase().includes(q) || (r.remarks || "").toLowerCase().includes(q)
        || (r.supplier || "").toLowerCase().includes(q) || (r.po_reference || "").toLowerCase().includes(q);
      return matchCat && matchSearch;
    });
  }, [records, search, filterCat]);

  const handleSearch = useCallback((val) => { setSearch(val); setPage(1); }, []);
  const handleFilter = useCallback((cat) => { setFilterCat(cat); setPage(1); }, []);

  const totals = useMemo(() => ({
    count:     filtered.length,
    categories: new Set(filtered.map((r) => r.category).filter(Boolean)).size,
    totalQty:  filtered.reduce((s, r) => s + (r.quantity_received || 0), 0),
    suppliers: new Set(filtered.map((r) => r.supplier).filter(Boolean)).size,
  }), [filtered]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage   = Math.min(page, totalPages);
  const pageItems  = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  // Expiry check (stable — computed once at mount)
  const [now] = useState(() => Date.now());
  const EXPIRY_SOON = 30 * 24 * 60 * 60 * 1000;

  const handleReceiptSuccess = useCallback((materialName) => {
    setShowAddReceipt(false); setReceiptSuccess(`"${materialName}" receipt recorded.`);
    setReceiptsRefresh((n) => n + 1); getIssuanceTotals().then(setAllTotals).catch(() => {});
  }, []);

  const handleEditSuccess = useCallback((materialName) => {
    setEditTarget(null); setEditSuccess(`"${materialName}" updated.`);
    setReceiptsRefresh((n) => n + 1);
  }, []);

  const handleDeleteReceipt = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    await deleteReceipt(deleteTarget.id, deleteTarget.material_name, user);
    setDeleting(false); setDeleteTarget(null);
    setReceiptsRefresh((n) => n + 1);
  }, [deleteTarget]);

  const handleAdjustmentSuccess = useCallback((materialName) => {
    setShowAddAdjustment(false); setAdjustmentSuccess(`Adjustment for "${materialName}" recorded.`);
    setAdjustmentsRefresh((n) => n + 1);
  }, []);

  const handleIssuanceSuccess = useCallback((materialName, refNumber, needsApproval) => {
    setIssuanceTarget(null);
    setIssuanceSuccess(needsApproval
      ? `${refNumber} submitted for approval — stock held pending supervisor review.`
      : `${refNumber} — "${materialName}" issued.`);
    setIssuancesRefresh((n) => n + 1); setPendingRefresh((n) => n + 1);
    getIssuanceTotals().then(setAllTotals).catch(() => {});
  }, []);

  const handleScan = useCallback((text) => {
    if (text.startsWith("ARIMA:")) {
      const [, materialName] = text.split(":");
      if (materialName) setIssuanceTarget({ material_name: materialName });
    }
  }, []);

  const handleReorderSave = useCallback(async (item, newPoint) => {
    try {
      await updateInventoryItem(item.itemId || item.material_name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_"), { reorderPoint: newPoint }, user);
      setInventoryItems((prev) => prev.map((i) => i.materialName === item.material_name ? { ...i, reorderPoint: newPoint } : i));
    } catch (err) { alert("Failed to update reorder point: " + err.message); }
  }, []);

  const handleCsvSuccess = useCallback((count) => {
    setShowCsvImport(false); setReceiptSuccess(`${count} receipt${count !== 1 ? "s" : ""} imported.`);
    setReceiptsRefresh((n) => n + 1);
  }, []);

  const threshold = inventorySettings.issuanceApprovalThreshold || 0;

  return (
    <div className="page-inventory">
      {/* KPI */}
      <section className="kpi-grid" style={{ marginBottom: 20 }}>
        {[
          { title: "Receipts",   value: recordsLoading ? "—" : totals.count,                      sub: "Filtered entries",   color: "#B8881A" },
          { title: "Categories", value: recordsLoading ? "—" : totals.categories,                 sub: "Material types",     color: "#1A74BC" },
          { title: "Total Qty",  value: recordsLoading ? "—" : totals.totalQty.toLocaleString(),  sub: "Units received",     color: "#1E9E52" },
          { title: "Suppliers",  value: recordsLoading ? "—" : totals.suppliers,                  sub: "Unique suppliers",   color: "#7D3C98" },
        ].map((kpi, i) => (
          <div className="kpi-card" key={i}>
            <div className="kpi-icon" style={{ background: kpi.color + "18", color: kpi.color }} />
            <div className="kpi-data"><span className="kpi-value">{kpi.value}</span><span className="kpi-title">{kpi.title}</span><span className="kpi-trend">{kpi.sub}</span></div>
          </div>
        ))}
      </section>

      <section className="panel">
        {/* Header */}
        <div className="panel-header">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <h3>Inventory</h3>
            <span className="panel-badge">{{ receipts: `${totals.count} receipts`, stock: "Stock levels", issuances: "Issuance records", adjustments: "Adjustments", pending: "Pending approvals" }[activeTab]}</span>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {canIssue  && <button className="issue-btn" onClick={() => setShowAddReceipt(true)}>+ Add Receipt</button>}
            {canIssue  && <button className="issue-btn" onClick={() => setShowCsvImport(true)}>Import CSV</button>}
            {canEdit   && <button className="issue-btn" onClick={() => setShowAddAdjustment(true)}>+ Adjust Stock</button>}
            <button className="issue-btn" style={{ background: "var(--bg-input)", color: "var(--text-muted)", border: "1px solid var(--border-color)" }}
              onClick={() => setShowScanModal(true)}>
              ▦ Scan
            </button>
            {canIssue && (
              <button className={`issue-btn${totalsLoading ? " issue-btn--loading" : ""}`} onClick={() => setIssuanceTarget({})}>
                {totalsLoading ? "Loading…" : "+ Issue Item"}
              </button>
            )}
          </div>
        </div>

        {/* Tabs */}
        <div className="inv-tab-bar" role="tablist">
          {[
            { id: "receipts",    label: "Receipts" },
            { id: "stock",       label: "Stock" },
            { id: "issuances",   label: "Issuances" },
            { id: "adjustments", label: "Adjustments" },
            ...(canApprove || pendingCount > 0 ? [{ id: "pending", label: "Pending Approvals", badge: pendingCount }] : []),
          ].map((t) => (
            <button key={t.id} role="tab" aria-selected={activeTab === t.id}
              className={`inv-tab-btn ${activeTab === t.id ? "inv-tab-btn--active" : ""}`}
              onClick={() => setActiveTab(t.id)}>
              {t.label}
              {t.badge > 0 && <span className="admin-tab-badge">{t.badge}</span>}
            </button>
          ))}
        </div>

        {/* ── Receipts Tab ──────────────────── */}
        {activeTab === "receipts" && (
          <>
            {receiptSuccess    && <div className="issuance-success-banner" role="status">{receiptSuccess}</div>}
            {editSuccess       && <div className="issuance-success-banner" role="status">{editSuccess}</div>}
            {adjustmentSuccess && <div className="issuance-success-banner" role="status">{adjustmentSuccess}</div>}
            {issuanceSuccess   && <div className="issuance-success-banner" role="status">{issuanceSuccess}</div>}

            <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-color)" }}>
              <div className="table-toolbar">
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <input className="table-search" placeholder="Search material, supplier, PO ref…" value={search} onChange={(e) => handleSearch(e.target.value)} />
                  <div className="activity-filters" role="group">
                    {categories.map((cat) => (
                      <button key={cat} className={`filter-btn ${filterCat === cat ? "filter-btn--active" : ""}`}
                        onClick={() => handleFilter(cat)} aria-pressed={filterCat === cat}>{cat}</button>
                    ))}
                  </div>
                </div>
                <button className="export-btn"
                  onClick={() => exportToCsv("materials-receipts.csv", filtered, CSV_COLUMNS)}
                  disabled={!filtered.length}>Export CSV</button>
              </div>
            </div>

            <div className="table-scroll table-mobile-cards" style={{ maxHeight: 520 }}>
              {recordsLoading ? (
                <table className="data-table" aria-busy="true">
                  <thead><tr><th>Date</th><th>Material</th><th>Category</th><th>Qty</th><th>Unit</th><th>Supplier</th><th>PO Ref</th><th>Expiry</th><th>By</th><th>Remarks</th>{canIssue && <th>Issue</th>}{(canEdit || canDelete) && <th>Actions</th>}</tr></thead>
                  <tbody>{Array.from({ length: 6 }).map((_, i) => <tr key={i} className="inv-skeleton-row"><td colSpan={12}><span className="inv-skeleton-cell inv-skeleton-cell--lg" /></td></tr>)}</tbody>
                </table>
              ) : error ? (
                <div className="error-state"><span className="error-icon">!</span><p>{error}</p></div>
              ) : filtered.length === 0 ? (
                <div className="empty-state"><p>No records match your filters.</p><p className="empty-hint">Use Add Receipt to record goods received.</p></div>
              ) : (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Date Received</th><th>Material</th><th>Category</th><th>Qty</th>
                      <th>Unit</th><th>Supplier</th><th>PO Ref</th><th>Expiry</th>
                      <th>Received By</th><th>Remarks</th>
                      {canIssue && <th>Issue</th>}
                      {(canEdit || canDelete) && <th>Actions</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {pageItems.map((r) => {
                      const isExpired  = r.expiryDate && r.expiryDate <= now;
                      const isExpiring = r.expiryDate && !isExpired && r.expiryDate <= now + EXPIRY_SOON;
                      return (
                        <tr key={r.id}>
                          <td className="mono">{fmt(r.date_time_received)}</td>
                          <td className="bold">{r.material_name || "—"}</td>
                          <td>{r.category ? <span className="inv-category-badge">{r.category}</span> : "—"}</td>
                          <td className="mono">{r.quantity_received ?? "—"}</td>
                          <td>{r.unit || "—"}</td>
                          <td>{r.supplier || "—"}</td>
                          <td className="mono" style={{ fontSize: 11 }}>{r.po_reference || "—"}</td>
                          <td style={{ whiteSpace: "nowrap" }}>
                            {r.expiryDate ? (
                              <span className={`feat-expiry-badge feat-expiry-badge--${isExpired ? "expired" : isExpiring ? "warning" : "ok"}`}>
                                {fmt(r.expiryDate)}
                              </span>
                            ) : "—"}
                          </td>
                          <td>{r.received_by || "—"}</td>
                          <td style={{ maxWidth: 160, whiteSpace: "normal", fontSize: 12 }}>{r.remarks || "—"}</td>
                          {canIssue && (
                            <td><button className="issue-row-btn" onClick={() => setIssuanceTarget(r)}>Issue</button></td>
                          )}
                          {(canEdit || canDelete) && (
                            <td>
                              <div style={{ display: "flex", gap: 4 }}>
                                {canEdit  && <button className="photo-view-btn" onClick={() => setEditTarget(r)}>Edit</button>}
                                {canDelete && <button className="photo-view-btn" style={{ color: "#dc3545", borderColor: "rgba(220,53,69,0.3)" }} onClick={() => setDeleteTarget(r)}>Delete</button>}
                              </div>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
            <Pagination page={safePage} totalPages={totalPages} onChange={setPage} />
          </>
        )}

        {activeTab === "stock" && (
          <StockTab records={records} allTotals={allTotals} adjustments={adjustments}
            inventoryItems={inventoryItems} onQrClick={setQrTarget} onReorderSave={handleReorderSave} />
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

        {activeTab === "pending" && (
          <>
            {!canApprove && <PermissionNotice department={user?.department} action="approve issuances" />}
            <PendingApprovalsPanel refresh={pendingRefresh} user={user} onApproved={() => { setPendingRefresh((n) => n + 1); getIssuanceTotals().then(setAllTotals).catch(() => {}); }} />
          </>
        )}
      </section>

      {/* ── Modals ─────────────────────────────── */}
      {qrTarget && <QrModal item={qrTarget} onClose={() => setQrTarget(null)} />}
      {showScanModal && <ScannerModal onScan={handleScan} onClose={() => setShowScanModal(false)} />}
      {showCsvImport && <CsvImportModal suppliers={suppliers} user={user} onClose={() => setShowCsvImport(false)} onSuccess={handleCsvSuccess} />}

      {showAddReceipt && (
        <ReceiptModal user={user} suppliers={suppliers} onClose={() => setShowAddReceipt(false)} onSuccess={handleReceiptSuccess} />
      )}
      {editTarget && (
        <ReceiptModal user={user} editRecord={editTarget} suppliers={suppliers} onClose={() => setEditTarget(null)} onSuccess={handleEditSuccess} />
      )}
      {deleteTarget && (
        <DeleteConfirmModal record={deleteTarget} deleting={deleting} onConfirm={handleDeleteReceipt} onCancel={() => setDeleteTarget(null)} />
      )}
      {showAddAdjustment && (
        <AddAdjustmentModal allRecords={records} user={user} onClose={() => setShowAddAdjustment(false)} onSuccess={handleAdjustmentSuccess} />
      )}
      {issuanceTarget !== null && (
        <IssuanceModal prefill={issuanceTarget} allRecords={records} allTotals={allTotals}
          user={user} approvalThreshold={threshold}
          onClose={() => setIssuanceTarget(null)} onSuccess={handleIssuanceSuccess} />
      )}
    </div>
  );
}

export default Inventory;
