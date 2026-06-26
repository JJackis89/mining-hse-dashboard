import { useEffect, useState, useCallback } from "react";
import { useUser } from "../context/UserContext";
import { usePermissionMatrix } from "../context/PermissionMatrixContext";
import { canPerform } from "../utils/permissions";
import {
  getSuppliers, addSupplier, updateSupplier, deleteSupplier,
} from "../services/supplierService";

const EMPTY_FORM = {
  name: "", contactPerson: "", phone: "", email: "", address: "", notes: "",
};

function fmt(ts) {
  if (!ts) return "—";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function SupplierModal({ supplier, user, onClose, onSaved }) {
  const isEdit = !!supplier;
  const [form, setForm] = useState(isEdit ? {
    name:          supplier.name          || "",
    contactPerson: supplier.contactPerson || "",
    phone:         supplier.phone         || "",
    email:         supplier.email         || "",
    address:       supplier.address       || "",
    notes:         supplier.notes         || "",
  } : { ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState("");

  useEffect(() => {
    const h = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const set = (f) => (e) => setForm((p) => ({ ...p, [f]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) { setError("Supplier name is required."); return; }
    setSaving(true); setError("");
    try {
      if (isEdit) {
        await updateSupplier(supplier.id, form, user);
      } else {
        await addSupplier(form, user);
      }
      onSaved();
    } catch (err) {
      setError("Failed to save supplier: " + err.message);
      setSaving(false);
    }
  };

  return (
    <div className="photo-modal-overlay" onClick={onClose} role="dialog" aria-modal="true">
      <div className="photo-modal issuance-modal" onClick={(e) => e.stopPropagation()}>
        <div className="photo-modal-header">
          <div>
            <span className="photo-modal-title">{isEdit ? "Edit Supplier" : "Add Supplier"}</span>
            <span className="photo-modal-sub">Supplier directory entry</span>
          </div>
          <button className="photo-modal-close" onClick={onClose}>&#x2715;</button>
        </div>
        <div className="photo-modal-body">
          {error && <div className="issuance-error" role="alert">{error}</div>}
          <form onSubmit={handleSubmit} className="issuance-form" noValidate>
            <p className="issuance-section-title">Company Details</p>
            <div className="issuance-field" style={{ marginBottom: 14 }}>
              <label>Supplier Name <span className="issuance-required">*</span></label>
              <input type="text" value={form.name} onChange={set("name")}
                className="issuance-input" placeholder="Company or individual name" required />
            </div>
            <div className="issuance-form-grid">
              <div className="issuance-field">
                <label>Contact Person</label>
                <input type="text" value={form.contactPerson} onChange={set("contactPerson")}
                  className="issuance-input" placeholder="Primary contact name" />
              </div>
              <div className="issuance-field">
                <label>Phone</label>
                <input type="tel" value={form.phone} onChange={set("phone")}
                  className="issuance-input" placeholder="+233 XX XXX XXXX" />
              </div>
              <div className="issuance-field">
                <label>Email</label>
                <input type="email" value={form.email} onChange={set("email")}
                  className="issuance-input" placeholder="supplier@company.com" />
              </div>
            </div>
            <div className="issuance-field" style={{ marginTop: 10 }}>
              <label>Address</label>
              <input type="text" value={form.address} onChange={set("address")}
                className="issuance-input" placeholder="Street, city, region" />
            </div>
            <div className="issuance-field" style={{ marginTop: 10 }}>
              <label>Notes</label>
              <textarea value={form.notes} onChange={set("notes")} rows={2}
                className="issuance-textarea" placeholder="Payment terms, lead times, notes…" />
            </div>
            <div className="issuance-form-footer">
              <span className="issuance-by-label">{isEdit ? "Editing" : "Adding"} as: <strong>{user.email}</strong></span>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" className="issuance-cancel-btn" onClick={onClose} disabled={saving}>Cancel</button>
                <button type="submit" className="issuance-submit-btn" disabled={saving}>
                  {saving ? "Saving…" : isEdit ? "Save Changes" : "Add Supplier"}
                </button>
              </div>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

function Suppliers() {
  const user      = useUser();
  const matrix    = usePermissionMatrix();
  const canEdit   = canPerform(user, matrix, "suppliers", "edit");
  const canDelete = canPerform(user, matrix, "suppliers", "delete");
  const canCreate = canPerform(user, matrix, "suppliers", "create");

  const [suppliers, setSuppliers] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);
  const [search, setSearch]       = useState("");
  const [modal, setModal]         = useState(null); // null | "add" | supplier object
  const [deleting, setDeleting]   = useState(null);
  const [refresh, setRefresh]     = useState(0);

  useEffect(() => {
    setLoading(true);
    getSuppliers()
      .then(setSuppliers)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [refresh]);

  const handleSaved = useCallback(() => {
    setModal(null);
    setRefresh((n) => n + 1);
  }, []);

  const handleDelete = useCallback(async (supplier) => {
    if (!window.confirm(`Remove "${supplier.name}" from the supplier directory?`)) return;
    setDeleting(supplier.id);
    try {
      await deleteSupplier(supplier.id, supplier.name, user);
      setRefresh((n) => n + 1);
    } catch (err) {
      alert("Delete failed: " + err.message);
    } finally {
      setDeleting(null);
    }
  }, []);

  const filtered = suppliers.filter((s) => {
    const q = search.toLowerCase();
    return !q || s.name?.toLowerCase().includes(q)
      || s.contactPerson?.toLowerCase().includes(q)
      || s.email?.toLowerCase().includes(q);
  });

  return (
    <div className="page-suppliers">
      {/* KPI */}
      <section className="kpi-grid" style={{ marginBottom: 20 }}>
        <div className="kpi-card">
          <div className="kpi-icon" style={{ background: "rgba(26,116,188,0.1)", color: "#1A74BC" }} />
          <div className="kpi-data">
            <span className="kpi-value">{loading ? "—" : suppliers.length}</span>
            <span className="kpi-title">Total Suppliers</span>
            <span className="kpi-trend">In directory</span>
          </div>
        </div>
        <div className="kpi-card">
          <div className="kpi-icon" style={{ background: "rgba(30,158,82,0.1)", color: "#1E9E52" }} />
          <div className="kpi-data">
            <span className="kpi-value">{loading ? "—" : suppliers.filter((s) => s.email).length}</span>
            <span className="kpi-title">With Email</span>
            <span className="kpi-trend">Can receive orders</span>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h3>Supplier Directory</h3>
          {canCreate && (
            <button className="issue-btn" onClick={() => setModal("add")}>+ Add Supplier</button>
          )}
        </div>

        <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--border-color)" }}>
          <input className="table-search" placeholder="Search suppliers…"
            value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>

        {loading && (
          <div className="loading-state"><div className="spinner" /><p>Loading suppliers…</p></div>
        )}
        {!loading && error && (
          <div className="error-state"><span className="error-icon">!</span><p>{error}</p></div>
        )}
        {!loading && !error && filtered.length === 0 && (
          <div className="empty-state" style={{ padding: "48px 20px" }}>
            <p>{suppliers.length === 0 ? "No suppliers yet." : "No suppliers match your search."}</p>
            {suppliers.length === 0 && canCreate && (
              <p className="empty-hint">Click "+ Add Supplier" to build your supplier directory.</p>
            )}
          </div>
        )}
        {!loading && !error && filtered.length > 0 && (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Supplier Name</th>
                  <th>Contact Person</th>
                  <th>Phone</th>
                  <th>Email</th>
                  <th>Address</th>
                  <th>Notes</th>
                  <th>Added</th>
                  {(canEdit || canDelete) && <th>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {filtered.map((s) => (
                  <tr key={s.id}>
                    <td className="bold">{s.name}</td>
                    <td>{s.contactPerson || "—"}</td>
                    <td className="mono" style={{ fontSize: 12 }}>{s.phone || "—"}</td>
                    <td style={{ fontSize: 12 }}>
                      {s.email ? <a href={`mailto:${s.email}`} style={{ color: "var(--accent-orange)" }}>{s.email}</a> : "—"}
                    </td>
                    <td style={{ fontSize: 12, maxWidth: 180, whiteSpace: "normal" }}>{s.address || "—"}</td>
                    <td style={{ fontSize: 12, maxWidth: 200, whiteSpace: "normal", color: "var(--text-muted)" }}>{s.notes || "—"}</td>
                    <td className="mono" style={{ fontSize: 11, color: "var(--text-muted)" }}>{fmt(s.createdAt)}</td>
                    {(canEdit || canDelete) && (
                      <td>
                        <div style={{ display: "flex", gap: 4 }}>
                          {canEdit && (
                            <button className="photo-view-btn" onClick={() => setModal(s)}>Edit</button>
                          )}
                          {canDelete && (
                            <button className="photo-view-btn"
                              style={{ color: "#dc3545", borderColor: "rgba(220,53,69,0.3)" }}
                              onClick={() => handleDelete(s)}
                              disabled={deleting === s.id}>
                              {deleting === s.id ? "…" : "Delete"}
                            </button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="admin-panel-footer">
          {filtered.length} supplier{filtered.length !== 1 ? "s" : ""}
        </div>
      </section>

      {modal && (
        <SupplierModal
          supplier={modal === "add" ? null : modal}
          user={user}
          onClose={() => setModal(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}

export default Suppliers;
