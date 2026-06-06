import { useEffect, useState, useMemo, useCallback } from "react";
import { getDroneSurveySubmissions } from "../services/arcgisService";
import {
  getActivities, getActivityLogs, createActivity,
  updateActivity, softDeleteActivity, restoreActivity,
} from "../services/droneActivityService";
import { useUser } from "../context/UserContext";
import { usePermissionMatrix } from "../context/PermissionMatrixContext";
import { canPerform } from "../utils/permissions";
import PermissionNotice from "../components/PermissionNotice";

// ─── Fleet data (update as fleet grows) ──────────────────────────
const DRONE_FLEET = [
  {
    id:      "UAV-001",
    name:    "DJI Mavic 3E",
    payload: "Hasselblad L2D-20c (20 MP, 4/3 CMOS)",
    status:  "Active",
  },
];

// ─── Activity metadata ────────────────────────────────────────────
const ACTIVITY_TYPES = [
  "Drone Survey",
  "Topographic Survey",
  "Boundary Survey",
  "Stockpile Survey",
  "Construction Monitoring",
  "Mapping",
  "Inspection",
  "Aerial Photography",
  "3D Modelling",
  "Other",
];

const STATUS_OPTIONS   = ["Planned", "Ongoing", "Completed", "Delayed", "Cancelled"];
const PRIORITY_OPTIONS = ["Low", "Medium", "High", "Critical"];

const FIELD_LABELS = {
  activityName:    "Activity Name",
  activityType:    "Activity Type",
  project:         "Project / Site",
  site:            "Specific Site",
  assignedTeam:    "Assigned Team",
  officerInCharge: "Officer in Charge",
  plannedDate:     "Planned Date",
  completionDate:  "Completion Date",
  status:          "Status",
  priority:        "Priority",
  description:     "Description",
  gpsLat:          "GPS Latitude",
  gpsLng:          "GPS Longitude",
  attachments:     "Attachments",
};

const PAGE_SIZE = 15;

// ─── Helpers ──────────────────────────────────────────────────────
function fmt(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function fmtTs(ts) {
  if (!ts) return "—";
  const d = ts?.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleString("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function fmtDateTime(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("en-GB", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function todayISO() {
  return new Date().toISOString().split("T")[0];
}

function fmtVal(val) {
  if (val === null || val === undefined || val === "") return "—";
  if (Array.isArray(val)) return `${val.length} attachment(s)`;
  return String(val);
}

// ─── StatusBadge ─────────────────────────────────────────────────
function StatusBadge({ status }) {
  const key = (status || "").toLowerCase().replace(/\s+/g, "-");
  return <span className={`status-pill status-pill--${key}`}>{status || "—"}</span>;
}

// ─── PriorityBadge ───────────────────────────────────────────────
function PriorityBadge({ priority }) {
  const key = (priority || "medium").toLowerCase();
  return (
    <span className={`dso-priority-badge dso-priority-badge--${key}`}>
      {priority || "—"}
    </span>
  );
}

// ─── Pagination ───────────────────────────────────────────────────
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
            <button key={p} className={`pagination-btn${p === page ? " pagination-btn--active" : ""}`}
              onClick={() => onChange(p)} aria-label={`Page ${p}`} aria-current={p === page ? "page" : undefined}>{p}</button>
          );
          return acc;
        }, [])}
        <button className="pagination-btn" onClick={() => onChange(page + 1)} disabled={page === totalPages} aria-label="Next page">&#8250;</button>
      </div>
    </div>
  );
}

// ─── ActivityFormModal ────────────────────────────────────────────
// activity = null → create mode; activity = {...} → edit mode
function ActivityFormModal({ activity, user, onClose, onSaved }) {
  const isEdit = !!activity;

  const [form, setForm] = useState({
    activityName:    activity?.activityName    ?? "",
    activityType:    activity?.activityType    ?? "",
    project:         activity?.project         ?? "",
    site:            activity?.site            ?? "",
    assignedTeam:    activity?.assignedTeam    ?? "",
    officerInCharge: activity?.officerInCharge ?? user.email,
    plannedDate:     activity?.plannedDate     ?? todayISO(),
    completionDate:  activity?.completionDate  ?? "",
    status:          activity?.status          ?? "Planned",
    priority:        activity?.priority        ?? "Medium",
    description:     activity?.description     ?? "",
    gpsLat:          activity?.gpsLat != null  ? String(activity.gpsLat) : "",
    gpsLng:          activity?.gpsLng != null  ? String(activity.gpsLng) : "",
    attachments:     activity?.attachments     ?? [],
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError]           = useState("");

  useEffect(() => {
    const h = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  const set = (f) => (e) => setForm((p) => ({ ...p, [f]: e.target.value }));

  const setAttachment = (i, field, val) =>
    setForm((p) => ({
      ...p,
      attachments: p.attachments.map((a, idx) => idx === i ? { ...a, [field]: val } : a),
    }));
  const addAttachment    = () => setForm((p) => ({ ...p, attachments: [...p.attachments, { name: "", url: "" }] }));
  const removeAttachment = (i) => setForm((p) => ({ ...p, attachments: p.attachments.filter((_, idx) => idx !== i) }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.activityName.trim()) { setError("Activity Name is required."); return; }
    if (!form.activityType)        { setError("Activity Type is required."); return; }
    if (!form.project.trim())      { setError("Project / Site is required."); return; }
    if (!form.plannedDate)         { setError("Planned Date is required."); return; }

    const data = {
      activityName:    form.activityName.trim(),
      activityType:    form.activityType,
      project:         form.project.trim(),
      site:            form.site.trim(),
      assignedTeam:    form.assignedTeam.trim(),
      officerInCharge: form.officerInCharge.trim(),
      plannedDate:     form.plannedDate,
      completionDate:  form.completionDate || null,
      status:          form.status,
      priority:        form.priority,
      description:     form.description.trim(),
      gpsLat:          form.gpsLat.trim() !== "" ? Number(form.gpsLat) : null,
      gpsLng:          form.gpsLng.trim() !== "" ? Number(form.gpsLng) : null,
      attachments:     form.attachments.filter((a) => a.name.trim() || a.url.trim()),
    };

    setSubmitting(true);
    setError("");
    try {
      if (isEdit) {
        await updateActivity(activity.id, activity, data, user);
      } else {
        await createActivity(data, user);
      }
      onSaved();
    } catch {
      setError("Failed to save. Please try again.");
      setSubmitting(false);
    }
  };

  return (
    <div className="photo-modal-overlay" onClick={onClose} role="dialog" aria-modal="true"
      aria-label={isEdit ? "Edit activity" : "New activity"}>
      <div className="photo-modal dso-activity-modal" onClick={(e) => e.stopPropagation()}>

        <div className="photo-modal-header">
          <div>
            <span className="photo-modal-title">{isEdit ? "Edit Activity" : "New Activity"}</span>
            <span className="photo-modal-sub">
              {isEdit ? `Editing ${activity.activityId}` : "Create a new drone or survey activity"}
            </span>
          </div>
          <button className="photo-modal-close" onClick={onClose} aria-label="Close">&#x2715;</button>
        </div>

        <div className="photo-modal-body">
          {error && <div className="issuance-error" role="alert">{error}</div>}

          <form onSubmit={handleSubmit} className="issuance-form" noValidate>

            {/* ── Activity Details ──────────────────────── */}
            <p className="issuance-section-title">Activity Details</p>
            <div className="issuance-form-grid">
              <div className="issuance-field" style={{ gridColumn: "1 / -1" }}>
                <label>Activity Name <span className="issuance-required">*</span></label>
                <input className="issuance-input" value={form.activityName} onChange={set("activityName")}
                  placeholder="e.g. Quarterly Boundary Survey — Pit 4" required />
              </div>
              <div className="issuance-field">
                <label>Activity Type <span className="issuance-required">*</span></label>
                <select className="issuance-item-select" value={form.activityType} onChange={set("activityType")} required>
                  <option value="">— Select type —</option>
                  {ACTIVITY_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div className="issuance-field">
                <label>Project / Site <span className="issuance-required">*</span></label>
                <input className="issuance-input" value={form.project} onChange={set("project")}
                  placeholder="e.g. Phase 2 Concession" required />
              </div>
              <div className="issuance-field">
                <label>Specific Site / Location</label>
                <input className="issuance-input" value={form.site} onChange={set("site")}
                  placeholder="e.g. Pit 4 Floor" />
              </div>
              <div className="issuance-field">
                <label>Assigned Team</label>
                <input className="issuance-input" value={form.assignedTeam} onChange={set("assignedTeam")}
                  placeholder="e.g. Survey Crew A" />
              </div>
            </div>

            {/* ── Assignment ─────────────────────────── */}
            <div className="issuance-section-divider" />
            <p className="issuance-section-title">Assignment</p>
            <div className="issuance-field">
              <label>Officer in Charge</label>
              <input className="issuance-input" value={form.officerInCharge} onChange={set("officerInCharge")}
                placeholder="Name or email of officer in charge" />
            </div>

            {/* ── Schedule & Status ──────────────────── */}
            <div className="issuance-section-divider" />
            <p className="issuance-section-title">Schedule &amp; Status</p>
            <div className="issuance-form-grid">
              <div className="issuance-field">
                <label>Planned Date <span className="issuance-required">*</span></label>
                <input type="date" className="issuance-input" value={form.plannedDate}
                  onChange={set("plannedDate")} required />
              </div>
              <div className="issuance-field">
                <label>Completion Date</label>
                <input type="date" className="issuance-input" value={form.completionDate}
                  onChange={set("completionDate")} />
              </div>
              <div className="issuance-field">
                <label>Status</label>
                <select className="issuance-item-select" value={form.status} onChange={set("status")}>
                  {STATUS_OPTIONS.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div className="issuance-field">
                <label>Priority</label>
                <select className="issuance-item-select" value={form.priority} onChange={set("priority")}>
                  {PRIORITY_OPTIONS.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
            </div>

            {/* ── Description ────────────────────────── */}
            <div className="issuance-section-divider" />
            <p className="issuance-section-title">Description</p>
            <div className="issuance-field">
              <label>Description / Notes</label>
              <textarea className="issuance-textarea" rows={3} value={form.description}
                onChange={set("description")} placeholder="Scope of work, objectives, field conditions, etc." />
            </div>

            {/* ── GPS Location ───────────────────────── */}
            <div className="issuance-section-divider" />
            <p className="issuance-section-title">GPS Location <span style={{ fontWeight: 400, color: "var(--text-muted)", fontSize: 11 }}>(optional)</span></p>
            <div className="issuance-form-grid">
              <div className="issuance-field">
                <label>Latitude</label>
                <input type="number" step="any" className="issuance-input" value={form.gpsLat}
                  onChange={set("gpsLat")} placeholder="e.g. 10.6549" />
              </div>
              <div className="issuance-field">
                <label>Longitude</label>
                <input type="number" step="any" className="issuance-input" value={form.gpsLng}
                  onChange={set("gpsLng")} placeholder="e.g. -1.5632" />
              </div>
            </div>

            {/* ── Attachments ────────────────────────── */}
            <div className="issuance-section-divider" />
            <p className="issuance-section-title">Attachments <span style={{ fontWeight: 400, color: "var(--text-muted)", fontSize: 11 }}>(links to reports, orthomosaics, PDFs, etc.)</span></p>
            {form.attachments.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                {form.attachments.map((att, i) => (
                  <div key={i} className="dso-attachment-row">
                    <input className="issuance-input dso-attachment-name" value={att.name}
                      onChange={(e) => setAttachment(i, "name", e.target.value)}
                      placeholder="Label (e.g. Orthomosaic Report)" />
                    <input className="issuance-input dso-attachment-url" value={att.url}
                      onChange={(e) => setAttachment(i, "url", e.target.value)}
                      placeholder="URL (Google Drive, SharePoint, etc.)" />
                    <button type="button" className="dso-remove-attach-btn"
                      onClick={() => removeAttachment(i)} aria-label="Remove attachment">Remove</button>
                  </div>
                ))}
              </div>
            )}
            <button type="button" className="dso-add-attach-btn" onClick={addAttachment}>
              + Add Attachment
            </button>

            {/* ── Footer ────────────────────────────── */}
            <div className="issuance-form-footer" style={{ marginTop: 20 }}>
              <span className="issuance-by-label">
                {isEdit ? "Modifying as:" : "Creating as:"} <strong>{user.email}</strong>
              </span>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" className="issuance-cancel-btn" onClick={onClose} disabled={submitting}>Cancel</button>
                <button type="submit" className="issuance-submit-btn" disabled={submitting}>
                  {submitting ? "Saving…" : isEdit ? "Save Changes" : "Create Activity"}
                </button>
              </div>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

// ─── ActivityDetailModal ──────────────────────────────────────────
function ActivityDetailModal({ activity, canEdit, canDelete, canRestore, onClose, onEdit, onDelete, onRestore }) {
  const [logs, setLogs]           = useState([]);
  const [logsLoading, setLogsLoading] = useState(true);
  const [activeSection, setActiveSection] = useState("details");

  useEffect(() => {
    const h = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  useEffect(() => {
    getActivityLogs(activity.id)
      .then(setLogs)
      .catch(() => setLogs([]))
      .finally(() => setLogsLoading(false));
  }, [activity.id]);

  return (
    <div className="photo-modal-overlay" onClick={onClose} role="dialog" aria-modal="true" aria-label="Activity details">
      <div className="photo-modal dso-detail-modal" onClick={(e) => e.stopPropagation()}>

        {/* Header */}
        <div className="photo-modal-header" style={{ flexWrap: "wrap", gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span className="photo-modal-title" style={{ wordBreak: "break-word" }}>
                {activity.activityName}
              </span>
              <span className="dso-id-chip">{activity.activityId}</span>
              {activity.isDeleted && <span className="dso-archived-badge">Archived</span>}
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
              <StatusBadge status={activity.status} />
              <PriorityBadge priority={activity.priority} />
            </div>
          </div>
          <div style={{ display: "flex", gap: 6, alignItems: "flex-start", flexShrink: 0 }}>
            {!activity.isDeleted && (canEdit || canDelete) && (
              <>
                {canEdit && (
                  <button className="dso-action-btn dso-action-btn--edit" onClick={onEdit} aria-label="Edit">Edit</button>
                )}
                {canDelete && (
                  <button className="dso-action-btn dso-action-btn--delete" onClick={onDelete} aria-label="Delete">Delete</button>
                )}
              </>
            )}
            {activity.isDeleted && canRestore && (
              <button className="dso-action-btn dso-action-btn--restore" onClick={onRestore} aria-label="Restore">Restore</button>
            )}
            <button className="photo-modal-close" onClick={onClose} aria-label="Close">&#x2715;</button>
          </div>
        </div>

        {/* Section tabs */}
        <div className="dso-detail-tabs" role="tablist">
          <button role="tab" aria-selected={activeSection === "details"}
            className={`dso-detail-tab${activeSection === "details" ? " dso-detail-tab--active" : ""}`}
            onClick={() => setActiveSection("details")}>Details</button>
          <button role="tab" aria-selected={activeSection === "history"}
            className={`dso-detail-tab${activeSection === "history" ? " dso-detail-tab--active" : ""}`}
            onClick={() => setActiveSection("history")}>
            History {logs.length > 0 && <span className="dso-log-count">{logs.length}</span>}
          </button>
        </div>

        <div className="photo-modal-body">

          {/* ── Details ─────────────────────────────── */}
          {activeSection === "details" && (
            <>
              <div className="dso-detail-grid">
                {[
                  ["Activity Type",    activity.activityType],
                  ["Project / Site",   activity.project],
                  ["Specific Site",    activity.site],
                  ["Assigned Team",    activity.assignedTeam],
                  ["Officer in Charge",activity.officerInCharge],
                  ["Planned Date",     activity.plannedDate],
                  ["Completion Date",  activity.completionDate],
                  ["GPS Location",     activity.gpsLat != null && activity.gpsLng != null
                    ? `${activity.gpsLat}, ${activity.gpsLng}` : null],
                ].map(([label, value]) => (
                  <div key={label} className="dso-detail-item">
                    <div className="dso-detail-label">{label}</div>
                    <div className={`dso-detail-value${!value ? " dso-detail-value--muted" : ""}`}>
                      {value || "—"}
                    </div>
                  </div>
                ))}
              </div>

              {activity.description && (
                <div style={{ marginBottom: 16 }}>
                  <div className="dso-detail-label">Description</div>
                  <div className="dso-detail-value" style={{ lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
                    {activity.description}
                  </div>
                </div>
              )}

              {/* Attachments */}
              {activity.attachments?.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <div className="dso-detail-label" style={{ marginBottom: 6 }}>Attachments</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {activity.attachments.map((att, i) => (
                      att.url
                        ? <a key={i} href={att.url} target="_blank" rel="noopener noreferrer" className="dso-attachment-link">
                            {att.name || att.url}
                          </a>
                        : <span key={i} className="dso-attachment-name-text">{att.name}</span>
                    ))}
                  </div>
                </div>
              )}

              {/* Audit row */}
              <div className="dso-audit-row">
                <span>Created by <strong>{activity.createdBy || "—"}</strong> &middot; {fmtTs(activity.createdAt)}</span>
                {activity.updatedBy && activity.updatedBy !== activity.createdBy && (
                  <span> &middot; Last updated by <strong>{activity.updatedBy}</strong> &middot; {fmtTs(activity.updatedAt)}</span>
                )}
              </div>
            </>
          )}

          {/* ── History ─────────────────────────────── */}
          {activeSection === "history" && (
            logsLoading ? (
              <div className="loading-state" style={{ minHeight: 200 }}>
                <div className="spinner" aria-label="Loading" /><p>Loading history…</p>
              </div>
            ) : logs.length === 0 ? (
              <div className="empty-state" style={{ padding: "40px 20px" }}>
                <p>No history entries yet.</p>
              </div>
            ) : (
              <div className="dso-timeline" aria-label="Activity history">
                {logs.map((log) => (
                  <div key={log.id} className="dso-tl-item">
                    <div className={`dso-tl-dot dso-tl-dot--${log.action}`} aria-hidden="true">
                      {log.action === "created"  && "C"}
                      {log.action === "updated"  && "U"}
                      {log.action === "deleted"  && "D"}
                      {log.action === "restored" && "R"}
                    </div>
                    <div className="dso-tl-content">
                      <div className="dso-tl-header">
                        <span className="dso-tl-action">{log.action}</span>
                        <span className="dso-tl-by">by {log.performedBy}</span>
                        <span className="dso-tl-when">{fmtTs(log.performedAt)}</span>
                      </div>
                      {log.changes && Object.keys(log.changes).length > 0 && (
                        <div className="dso-tl-changes">
                          {Object.entries(log.changes).map(([field, { from, to }]) => (
                            <div key={field} className="dso-tl-change-row">
                              <span className="dso-tl-field">{FIELD_LABELS[field] || field}</span>
                              <span className="dso-tl-from">{fmtVal(from)}</span>
                              <span className="dso-tl-arrow">→</span>
                              <span className="dso-tl-to">{fmtVal(to)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
}

// ─── DeleteConfirmModal ───────────────────────────────────────────
function DeleteConfirmModal({ activity, deleting, onClose, onConfirm }) {
  useEffect(() => {
    const h = (e) => { if (e.key === "Escape" && !deleting) onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose, deleting]);

  return (
    <div className="photo-modal-overlay" onClick={!deleting ? onClose : undefined}
      role="dialog" aria-modal="true" aria-label="Confirm delete">
      <div className="photo-modal dso-delete-modal" onClick={(e) => e.stopPropagation()}>
        <div className="dso-delete-body">
          <h3 className="dso-delete-title">Delete Activity?</h3>
          <p className="dso-delete-msg">
            <strong>{activity.activityName}</strong> ({activity.activityId}) will be archived
            and hidden from the main view. Administrators can restore it from the Archived filter.
          </p>
          <div className="dso-delete-actions">
            <button className="issuance-cancel-btn" onClick={onClose} disabled={deleting}>Cancel</button>
            <button className="dso-delete-confirm-btn" onClick={onConfirm} disabled={deleting}>
              {deleting ? "Deleting…" : "Delete Activity"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── ActivitiesTab ────────────────────────────────────────────────
function ActivitiesTab({ user }) {
  const matrix    = usePermissionMatrix();
  const canCreate = canPerform(user, matrix, "droneSurveyOps", "create");
  const canEdit   = canPerform(user, matrix, "droneSurveyOps", "edit");
  const canDelete = canPerform(user, matrix, "droneSurveyOps", "delete");
  // Showing/restoring archived records is the page's most sensitive
  // capability — reserved for whoever holds Full Access (the owning
  // department, Survey & GIS, or a platform administrator override).
  const canManageArchive = canPerform(user, matrix, "droneSurveyOps", "manage");

  const [activities, setActivities]   = useState([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState(null);
  const [revision, setRevision]       = useState(0);

  const [search, setSearch]           = useState("");
  const [statusFilter, setStatusFilter] = useState("All");
  const [showArchived, setShowArchived] = useState(false);
  const [page, setPage]               = useState(1);

  const [createOpen, setCreateOpen]         = useState(false);
  const [editActivity, setEditActivity]     = useState(null);
  const [detailActivity, setDetailActivity] = useState(null);
  const [deleteTarget, setDeleteTarget]     = useState(null);
  const [deleting, setDeleting]             = useState(false);
  const [successMsg, setSuccessMsg]         = useState("");

  // Load activities
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getActivities()
      .then((rows) => { if (!cancelled) { setActivities(rows); setLoading(false); } })
      .catch((err) => { if (!cancelled) { setError(err.message); setLoading(false); } });
    return () => { cancelled = true; };
  }, [revision]);

  // Keep detail modal in sync after refresh
  useEffect(() => {
    if (detailActivity) {
      const fresh = activities.find((a) => a.id === detailActivity.id);
      if (fresh) setDetailActivity(fresh);
    }
  }, [activities]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-clear success banner
  useEffect(() => {
    if (!successMsg) return;
    const t = setTimeout(() => setSuccessMsg(""), 5000);
    return () => clearTimeout(t);
  }, [successMsg]);

  const refresh = useCallback(() => setRevision((n) => n + 1), []);

  // Derived stats (active only)
  const stats = useMemo(() => {
    const active = activities.filter((a) => !a.isDeleted);
    return {
      total:     active.length,
      planned:   active.filter((a) => a.status === "Planned").length,
      ongoing:   active.filter((a) => a.status === "Ongoing").length,
      completed: active.filter((a) => a.status === "Completed").length,
      delayed:   active.filter((a) => a.status === "Delayed").length,
    };
  }, [activities]);

  // Filtered list
  const visible = useMemo(() => {
    let list = activities.filter((a) => (showArchived ? a.isDeleted : !a.isDeleted));
    if (statusFilter !== "All") list = list.filter((a) => a.status === statusFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((a) =>
        (a.activityName    || "").toLowerCase().includes(q) ||
        (a.project         || "").toLowerCase().includes(q) ||
        (a.officerInCharge || "").toLowerCase().includes(q) ||
        (a.activityId      || "").toLowerCase().includes(q) ||
        (a.activityType    || "").toLowerCase().includes(q)
      );
    }
    return list;
  }, [activities, search, statusFilter, showArchived]);

  const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const safePage   = Math.min(page, totalPages);
  const pageItems  = visible.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const handleSearchChange  = useCallback((v) => { setSearch(v); setPage(1); }, []);
  const handleStatusFilter  = useCallback((s) => { setStatusFilter(s); setPage(1); }, []);

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await softDeleteActivity(deleteTarget.id, deleteTarget, user);
      setDeleteTarget(null);
      setSuccessMsg(`"${deleteTarget.activityName}" archived successfully.`);
      refresh();
    } catch {
      // keep modal open
    } finally {
      setDeleting(false);
    }
  };

  const handleRestore = async (activity) => {
    try {
      await restoreActivity(activity.id, activity, user);
      setDetailActivity(null);
      setSuccessMsg(`"${activity.activityName}" restored successfully.`);
      refresh();
    } catch { /* silent */ }
  };

  const statChips = [
    { label: "Total",     value: stats.total,     filter: "All"      },
    { label: "Planned",   value: stats.planned,   filter: "Planned"  },
    { label: "Ongoing",   value: stats.ongoing,   filter: "Ongoing"  },
    { label: "Completed", value: stats.completed, filter: "Completed"},
    { label: "Delayed",   value: stats.delayed,   filter: "Delayed"  },
  ];

  return (
    <div role="tabpanel" aria-label="Activities">

      {/* ── Stat chips ──────────────────────────── */}
      <div className="dso-stats-strip">
        {statChips.map((chip) => (
          <button
            key={chip.label}
            className={`dso-stat-chip${statusFilter === chip.filter && !showArchived ? " dso-stat-chip--active" : ""}`}
            onClick={() => { setShowArchived(false); handleStatusFilter(chip.filter); }}
            aria-pressed={statusFilter === chip.filter && !showArchived}
          >
            <div>
              <div className="dso-stat-value">{loading ? "—" : chip.value}</div>
              <div className="dso-stat-label">{chip.label}</div>
            </div>
          </button>
        ))}
      </div>

      {/* ── Panel ───────────────────────────────── */}
      <section className="panel" aria-label="Activity management">
        <div className="panel-header">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <h3>{showArchived ? "Archived Activities" : "Activities"}</h3>
            <span className="panel-badge">{visible.length} {visible.length === 1 ? "record" : "records"}</span>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            {canManageArchive && (
              <button
                className={`dso-archive-toggle${showArchived ? " dso-archive-toggle--active" : ""}`}
                onClick={() => { setShowArchived((v) => !v); setStatusFilter("All"); setPage(1); }}
                aria-pressed={showArchived}
              >
                {showArchived ? "Hide Archived" : "Show Archived"}
              </button>
            )}
            {canCreate && !showArchived && (
              <button className="issue-btn" onClick={() => setCreateOpen(true)} aria-label="Create new activity">
                + New Activity
              </button>
            )}
          </div>
        </div>

        {successMsg && (
          <div className="issuance-success-banner" role="status">{successMsg}</div>
        )}

        {!canCreate && !showArchived && (
          <PermissionNotice department={user?.department} action="log or manage activities" />
        )}

        {/* Filter toolbar */}
        <div style={{ padding: "10px 16px", borderBottom: "1px solid var(--border-color)" }}>
          <div className="table-toolbar">
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input
                className="table-search"
                placeholder="Search name, project, officer, type…"
                value={search}
                onChange={(e) => handleSearchChange(e.target.value)}
                aria-label="Search activities"
              />
              {!showArchived && (
                <div className="activity-filters" role="group" aria-label="Filter by status">
                  {["All", ...STATUS_OPTIONS].map((s) => (
                    <button key={s}
                      className={`filter-btn${statusFilter === s ? " filter-btn--active" : ""}`}
                      onClick={() => handleStatusFilter(s)}
                      aria-pressed={statusFilter === s}>{s}</button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Table */}
        <div className="table-scroll table-mobile-cards" style={{ maxHeight: 520 }}>
          {loading ? (
            <table className="data-table" aria-busy="true">
              <thead>
                <tr>
                  <th>ID</th><th>Activity</th><th>Type</th><th>Project</th>
                  <th>Status</th><th>Priority</th><th>Planned Date</th><th>Officer</th><th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i} className="inv-skeleton-row">
                    {Array.from({ length: 9 }).map((_, j) => (
                      <td key={j}><span className={`inv-skeleton-cell inv-skeleton-cell--${["sm","lg","md","md","sm","xs","sm","md","sm"][j]}`} /></td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : error ? (
            <div className="error-state" style={{ padding: "32px 20px" }}>
              <span className="error-icon" role="img" aria-label="Error">!</span>
              <p>Failed to load activities</p>
              <p className="error-detail">{error}</p>
            </div>
          ) : visible.length === 0 ? (
            <div className="empty-state" style={{ padding: "60px 20px" }}>
              <p>{showArchived ? "No archived activities." : "No activities yet."}</p>
              {!showArchived && canCreate && (
                <p className="empty-hint">Click "+ New Activity" to log your first drone or survey activity.</p>
              )}
            </div>
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">ID</th>
                  <th scope="col">Activity Name</th>
                  <th scope="col" className="dso-col-hide-sm">Type</th>
                  <th scope="col" className="dso-col-hide-sm">Project</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="dso-col-hide-md">Priority</th>
                  <th scope="col" className="dso-col-hide-md">Planned Date</th>
                  <th scope="col" className="dso-col-hide-md">Officer</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {pageItems.map((act) => (
                  <tr key={act.id} style={{ opacity: act.isDeleted ? 0.55 : 1 }}>
                    <td data-label="ID">
                      <span className="dso-id-chip">{act.activityId}</span>
                    </td>
                    <td data-label="Activity" className="bold">
                      {act.activityName}
                      {act.isDeleted && <span className="dso-archived-badge">Archived</span>}
                    </td>
                    <td data-label="Type" className="dso-col-hide-sm">
                      {act.activityType || "—"}
                    </td>
                    <td data-label="Project" className="dso-col-hide-sm">
                      {act.project || "—"}
                    </td>
                    <td data-label="Status"><StatusBadge status={act.status} /></td>
                    <td data-label="Priority" className="dso-col-hide-md">
                      <PriorityBadge priority={act.priority} />
                    </td>
                    <td data-label="Planned" className="mono dso-col-hide-md">
                      {act.plannedDate || "—"}
                    </td>
                    <td data-label="Officer" className="dso-col-hide-md">
                      {act.officerInCharge || "—"}
                    </td>
                    <td data-label="Actions">
                      <div className="dso-row-actions">
                        <button className="dso-row-btn" onClick={() => setDetailActivity(act)}
                          aria-label={`View ${act.activityName}`}>View</button>
                        {!act.isDeleted && (canEdit || canDelete) && (
                          <>
                            {canEdit && (
                              <button className="dso-row-btn dso-row-btn--edit"
                                onClick={() => setEditActivity(act)}
                                aria-label={`Edit ${act.activityName}`}>Edit</button>
                            )}
                            {canDelete && (
                              <button className="dso-row-btn dso-row-btn--delete"
                                onClick={() => setDeleteTarget(act)}
                                aria-label={`Delete ${act.activityName}`}>Delete</button>
                            )}
                          </>
                        )}
                        {act.isDeleted && canManageArchive && (
                          <button className="dso-row-btn dso-row-btn--restore"
                            onClick={() => handleRestore(act)}
                            aria-label={`Restore ${act.activityName}`}>Restore</button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <Pagination page={safePage} totalPages={totalPages} onChange={setPage} />
      </section>

      {/* ── Modals ──────────────────────────────── */}
      {createOpen && (
        <ActivityFormModal
          activity={null}
          user={user}
          onClose={() => setCreateOpen(false)}
          onSaved={() => { setCreateOpen(false); setSuccessMsg("Activity created successfully."); refresh(); }}
        />
      )}

      {editActivity && (
        <ActivityFormModal
          activity={editActivity}
          user={user}
          onClose={() => setEditActivity(null)}
          onSaved={() => { setEditActivity(null); setSuccessMsg("Activity updated successfully."); refresh(); }}
        />
      )}

      {detailActivity && (
        <ActivityDetailModal
          activity={detailActivity}
          canEdit={canEdit}
          canDelete={canDelete}
          canRestore={canManageArchive}
          onClose={() => setDetailActivity(null)}
          onEdit={() => { setDetailActivity(null); setEditActivity(detailActivity); }}
          onDelete={() => { setDetailActivity(null); setDeleteTarget(detailActivity); }}
          onRestore={() => handleRestore(detailActivity)}
        />
      )}

      {deleteTarget && (
        <DeleteConfirmModal
          activity={deleteTarget}
          deleting={deleting}
          onClose={() => { if (!deleting) setDeleteTarget(null); }}
          onConfirm={handleDelete}
        />
      )}
    </div>
  );
}

// ─── Survey123 Feed ───────────────────────────────────────────────
function Survey123Feed({ submissions, loading }) {
  if (loading) {
    return (
      <div className="loading-state" style={{ minHeight: 200 }}>
        <div className="spinner" aria-label="Loading" />
        <p>Checking for Survey123 submissions…</p>
      </div>
    );
  }

  if (submissions === null) {
    return (
      <div className="s123-connect-panel">
        <h3 className="s123-connect-title">Survey123 Form Not Yet Connected</h3>
        <p className="s123-connect-body">
          Once you have published your Drone &amp; Survey Operations form in ArcGIS Online,
          paste the Feature Service URL into <code>arcgisService.js</code> to start
          receiving submissions here automatically.
        </p>
        <div className="s123-steps">
          {[
            ["Create your Survey123 form", "Build the Drone & Survey Operations form in Survey123 Connect or the web designer."],
            ["Publish and copy the Feature Service URL", "In ArcGIS Online open the form's Feature Layer → Overview → copy the REST endpoint (ends in /FeatureServer/0)."],
            ["Set DRONE_SURVEY_URL in arcgisService.js", "Replace null with your copied URL. The feed and notification bell activate on the next page load."],
          ].map(([title, body], i) => (
            <div key={i} className="s123-step">
              <span className="s123-step-num">{i + 1}</span>
              <div className="s123-step-body"><strong>{title}</strong><span>{body}</span></div>
            </div>
          ))}
        </div>
        <div className="s123-fields-guide">
          <h4 className="s123-fields-title">Recommended form fields</h4>
          <div className="table-scroll">
            <table className="data-table">
              <thead><tr><th scope="col">Field name</th><th scope="col">Type</th><th scope="col">Description</th></tr></thead>
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

  if (submissions.length === 0) {
    return (
      <div className="empty-state" style={{ padding: "60px 20px" }}>
        <p>No submissions in the last 30 days.</p>
        <p className="empty-hint">Submit an entry via the Survey123 Drone &amp; Survey Operations form.</p>
      </div>
    );
  }

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

// ─── Tabs config ──────────────────────────────────────────────────
const TABS = [
  { key: "activities", label: "Activities"      },
  { key: "survey123",  label: "Survey123 Feed"  },
  { key: "fleet",      label: "Drone Fleet"     },
];

// ─── Main Page ────────────────────────────────────────────────────
function DroneSurveyOps() {
  const user = useUser();
  const [activeTab,   setActiveTab]   = useState("activities");
  const [submissions, setSubmissions] = useState(null);
  const [loadingFeed, setLoadingFeed] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getDroneSurveySubmissions()
      .then((rows) => { if (!cancelled) setSubmissions(rows); })
      .catch(() =>    { if (!cancelled) setSubmissions([]);  })
      .finally(() =>  { if (!cancelled) setLoadingFeed(false); });
    return () => { cancelled = true; };
  }, []);

  const activeCount   = DRONE_FLEET.filter((d) => d.status === "Active").length;
  const s123Status    = loadingFeed ? "Checking…" : submissions !== null ? "Connected" : "Awaiting Setup";
  const s123Color     = loadingFeed ? "#8B96A6" : submissions !== null ? "#1E9E52" : "#D4820A";
  const subCount      = submissions !== null ? submissions.length : null;

  const nonActivityKpis = [
    { title: "Fleet Size",     value: DRONE_FLEET.length, sub: "Registered aircraft",    color: "#B8881A" },
    { title: "Active Aircraft",value: activeCount,         sub: "Currently operational",  color: "#1E9E52" },
    { title: "Survey123 Form", value: s123Status,          sub: "Drone & survey feed",    color: s123Color },
    { title: "Submissions",    value: loadingFeed ? "—" : subCount ?? "—", sub: "Past 30 days", color: "#1A74BC" },
  ];

  return (
    <div className="page-drone-survey">

      {/* KPIs only on non-activities tabs */}
      {activeTab !== "activities" && (
        <section className="kpi-grid" aria-label="Operations summary">
          {nonActivityKpis.map((kpi) => (
            <div className="kpi-card" key={kpi.title}>
              <div className="kpi-icon" style={{ background: kpi.color + "18", color: kpi.color }} aria-hidden="true" />
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
      )}

      {/* Tab bar */}
      <div className="tab-bar" role="tablist" aria-label="Drone and survey tabs">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            role="tab"
            aria-selected={activeTab === tab.key}
            className={`tab-btn${activeTab === tab.key ? " tab-btn--active" : ""}${tab.key === "survey123" ? " tab-btn--highlight" : ""}`}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.key === "survey123" && <span className="tab-s123-dot" aria-hidden="true" />}
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab panels */}
      {activeTab === "activities" && <ActivitiesTab user={user} />}

      {activeTab === "survey123" && (
        <div role="tabpanel" aria-label="Survey123 live feed">
          <Survey123Feed submissions={submissions} loading={loadingFeed} />
        </div>
      )}

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
    </div>
  );
}

export default DroneSurveyOps;
