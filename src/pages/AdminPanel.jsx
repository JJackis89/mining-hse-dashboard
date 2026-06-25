import { useEffect, useState, useCallback, useMemo } from "react";
import { useUser } from "../context/UserContext";
import { migrateManualReceipts } from "../services/issuanceService";
import {
  subscribeToUsers,
  updateUserRole,
  updateUserProfile,
  getPendingInvites,
  createPendingInvite,
  revokePendingInvite,
  syncLegacyUsers,
  testFirestoreWrite,
  subscribeToFailedRegistrations,
  approveFailedRegistration,
  approveUser,
  suspendUser,
  deactivateUser,
  reactivateUser,
  deleteUserProfile,
} from "../services/adminService";
import { ROLES, ROLE_LABELS, DEPARTMENTS, PERMISSION_LEVELS } from "../utils/permissions";
import {
  subscribeToPermissionRows,
  ensureMatrixSeeded,
  savePagePermissions,
  subscribeToAuditLog,
} from "../services/departmentPermissionsService";

const PAGE_SIZE      = 20;
const STATUS_OPTIONS = ["Active", "Pending Approval", "Suspended", "Deactivated"];

// Maps accountStatus to a short CSS key used in className
const STATUS_KEY = {
  "Active":           "active",
  "Pending Approval": "pending",
  "Suspended":        "suspended",
  "Deactivated":      "deactivated",
};

function tsMs(val) {
  if (!val) return 0;
  if (typeof val.toMillis === "function") return val.toMillis();
  if (typeof val === "number") return val;
  return 0;
}

function fmt(ts) {
  if (!ts) return "—";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function fmtDateTime(ts) {
  if (!ts) return "—";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleString("en-GB");
}

function initials(name, email) {
  if (name?.trim()) {
    return name.trim().split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  }
  return ((email || "?")[0]).toUpperCase();
}

function SkeletonRow() {
  const widths = [65, 35, 35, 35, 35, 30, 30, 35];
  return (
    <tr aria-hidden="true">
      {widths.map((w, i) => (
        <td key={i}><div className="skeleton" style={{ width: `${w}%` }} /></td>
      ))}
    </tr>
  );
}

// ─── Sortable column header ───────────────────────────────────
function SortTh({ label, field, sortField, sortDir, onSort, ...rest }) {
  const active = sortField === field;
  return (
    <th scope="col" className="admin-sort-th" onClick={() => onSort(field)} {...rest}>
      {label}
      <span className="admin-sort-icon" aria-hidden="true">
        {active ? (sortDir === "asc" ? " ↑" : " ↓") : " ↕"}
      </span>
    </th>
  );
}

// ─── Main Admin Panel ─────────────────────────────────────────
function AdminPanel() {
  const user      = useUser();
  const [activeTab, setActiveTab] = useState("users");

  // ── Users ───────────────────────────────────────────────────
  const [users, setUsers]                   = useState([]);
  const [usersLoading, setUsersLoading]     = useState(true);
  const [usersError, setUsersError]         = useState(null);
  const [pendingChanges, setPendingChanges] = useState({});
  const [saving, setSaving]                 = useState({});
  const [saveMsg, setSaveMsg]               = useState({});
  const [lifecycleBusy, setLifecycleBusy]   = useState({});
  const [lifecycleMsg, setLifecycleMsg]     = useState({});

  // ── Search, Filter & Sort ───────────────────────────────────
  const [search, setSearch]             = useState("");
  const [filterRole, setFilterRole]     = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [filterDept, setFilterDept]     = useState("");
  const [sortField, setSortField]       = useState("createdAt");
  const [sortDir, setSortDir]           = useState("desc");
  const [page, setPage]                 = useState(1);

  // ── Migration ───────────────────────────────────────────────
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");

  // ── Diagnostics ─────────────────────────────────────────────
  const [lastUpdated, setLastUpdated]       = useState(null);
  const [writeTest,   setWriteTest]         = useState(null);
  const [writeTesting, setWriteTesting]     = useState(false);
  const [failedRegs,  setFailedRegs]        = useState([]);
  const [approving,   setApproving]         = useState({});

  // ── Invites ─────────────────────────────────────────────────
  const [invites, setInvites]               = useState([]);
  const [invitesLoading, setInvitesLoading] = useState(true);
  const [invitesError, setInvitesError]     = useState(null);
  const [inviteEmail, setInviteEmail]       = useState("");
  const [inviteRole, setInviteRole]         = useState("viewer");
  const [inviting, setInviting]             = useState(false);
  const [inviteMsg, setInviteMsg]           = useState("");
  const [revoking, setRevoking]             = useState({});


  // ── Data Migration ──────────────────────────────────────────
  const [migrating, setMigrating]   = useState(false);
  const [migrateMsg, setMigrateMsg] = useState("");

  // ── Department Permissions ──────────────────────────────────
  const [permRows, setPermRows]             = useState([]);
  const [permLoading, setPermLoading]       = useState(true);
  const [permError, setPermError]           = useState(null);
  const [permEdits, setPermEdits]           = useState({});   // { [pageKey]: { [dept]: level } }
  const [permSaving, setPermSaving]         = useState({});   // { [pageKey]: bool }
  const [permMsg, setPermMsg]               = useState({});   // { [pageKey]: string }
  const [seeding, setSeeding]               = useState(false);
  const [seedMsg, setSeedMsg]               = useState("");
  const [auditLog, setAuditLog]             = useState([]);
  const [auditLoading, setAuditLoading]     = useState(true);

  // Real-time subscription — track last snapshot time for diagnostics
  useEffect(() => {
    const unsub = subscribeToUsers(
      (data) => {
        setUsers(data);
        setUsersLoading(false);
        setUsersError(null);
        setLastUpdated(new Date());
      },
      (err) => { setUsersError(err.message); setUsersLoading(false); }
    );
    return unsub;
  }, []);

  // Subscribe to failed registrations (accounts that couldn't write to userRoles)
  useEffect(() => {
    const unsub = subscribeToFailedRegistrations(
      (data) => setFailedRegs(data),
      (err)  => console.warn("[ARIMA] failedRegistrations read error:", err.message)
    );
    return unsub;
  }, []);

  const loadInvites = useCallback(async () => {
    setInvitesLoading(true);
    setInvitesError(null);
    try { setInvites(await getPendingInvites()); }
    catch (err) { setInvitesError(err.message); }
    finally { setInvitesLoading(false); }
  }, []);

  useEffect(() => {
    if (activeTab === "invites") loadInvites();
  }, [activeTab, loadInvites]);


  // Department Permissions — subscribe only while the tab is open
  useEffect(() => {
    if (activeTab !== "permissions") return;
    setPermLoading(true);
    setAuditLoading(true);
    const unsubRows = subscribeToPermissionRows(
      (rows) => { setPermRows(rows); setPermLoading(false); setPermError(null); },
      (err)  => { setPermError(err.message); setPermLoading(false); }
    );
    const unsubAudit = subscribeToAuditLog(
      (rows) => { setAuditLog(rows); setAuditLoading(false); },
      (err)  => { console.warn("[ARIMA] Audit log read error:", err.message); setAuditLoading(false); }
    );
    return () => { unsubRows(); unsubAudit(); };
  }, [activeTab]);

  const handlePermLevelChange = (pageKey, dept, level) => {
    setPermEdits((prev) => ({
      ...prev,
      [pageKey]: { ...(prev[pageKey] ?? {}), [dept]: level },
    }));
    setPermMsg((prev) => ({ ...prev, [pageKey]: "" }));
  };

  const handleSavePagePermissions = async (row) => {
    const edits = permEdits[row.key];
    if (!edits || Object.keys(edits).length === 0) return;
    setPermSaving((prev) => ({ ...prev, [row.key]: true }));
    setPermMsg((prev) => ({ ...prev, [row.key]: "" }));
    try {
      const next = { ...row.permissions, ...edits };
      await savePagePermissions(row.key, next, user);
      setPermEdits((prev) => {
        const { [row.key]: _drop, ...rest } = prev;
        return rest;
      });
      setPermMsg((prev) => ({ ...prev, [row.key]: "Saved." }));
    } catch (err) {
      setPermMsg((prev) => ({ ...prev, [row.key]: `Save failed: ${err.message}` }));
    } finally {
      setPermSaving((prev) => ({ ...prev, [row.key]: false }));
    }
  };

  const handleSeedMatrix = async () => {
    setSeeding(true);
    setSeedMsg("");
    try {
      const count = await ensureMatrixSeeded(user);
      setSeedMsg(count > 0 ? `Seeded ${count} page${count === 1 ? "" : "s"} with default permissions.` : "Already up to date — nothing to seed.");
    } catch (err) {
      setSeedMsg(`Seeding failed: ${err.message}`);
    } finally {
      setSeeding(false);
    }
  };

  // ── Derived filter options ───────────────────────────────────
  const departments = useMemo(
    () => [...new Set(users.map((u) => u.department).filter(Boolean))].sort(),
    [users]
  );

  // ── Client-side filter ───────────────────────────────────────
  const filtered = useMemo(() => {
    let list = users;
    if (search.trim()) {
      const s = search.trim().toLowerCase();
      list = list.filter(
        (u) =>
          (u.fullName || "").toLowerCase().includes(s) ||
          (u.email    || "").toLowerCase().includes(s) ||
          (u.department || "").toLowerCase().includes(s)
      );
    }
    if (filterRole)   list = list.filter((u) => u.role === filterRole);
    if (filterStatus) list = list.filter((u) => (u.accountStatus || "Active") === filterStatus);
    if (filterDept)   list = list.filter((u) => u.department === filterDept);
    return list;
  }, [users, search, filterRole, filterStatus, filterDept]);

  // ── Client-side sort ─────────────────────────────────────────
  const sorted = useMemo(() => {
    const list = [...filtered];
    list.sort((a, b) => {
      let va, vb;
      switch (sortField) {
        case "name":
          va = (a.fullName || a.email || "").toLowerCase();
          vb = (b.fullName || b.email || "").toLowerCase();
          break;
        case "role":
          va = ROLES.indexOf(a.role ?? "viewer");
          vb = ROLES.indexOf(b.role ?? "viewer");
          break;
        case "status":
          va = a.accountStatus || "Active";
          vb = b.accountStatus || "Active";
          break;
        case "lastLogin":
          va = tsMs(a.lastLogin);
          vb = tsMs(b.lastLogin);
          break;
        case "createdAt":
        default:
          va = tsMs(a.createdAt);
          vb = tsMs(b.createdAt);
          break;
      }
      if (va < vb) return sortDir === "asc" ? -1 : 1;
      if (va > vb) return sortDir === "asc" ? 1  : -1;
      return 0;
    });
    return list;
  }, [filtered, sortField, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const paged      = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // Reset to page 1 when filters or sort change
  useEffect(() => setPage(1), [search, filterRole, filterStatus, filterDept, sortField, sortDir]);

  // ── Sort handler ─────────────────────────────────────────────
  const handleSort = useCallback((field) => {
    setSortField((prev) => {
      if (prev === field) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
        return prev;
      }
      setSortDir("asc");
      return field;
    });
  }, []);

  // ── KPI counts ───────────────────────────────────────────────
  const activeCount  = useMemo(() => users.filter((u) => (u.accountStatus || "Active") === "Active").length, [users]);
  const pendingCount = useMemo(() => users.filter((u) => u.accountStatus === "Pending Approval").length, [users]);

  // ── Field editing ────────────────────────────────────────────
  const handleFieldChange = (uid, field, value) => {
    setPendingChanges((p) => ({
      ...p,
      [uid]: { ...(p[uid] || {}), [field]: value },
    }));
  };

  const handleSave = async (uid) => {
    const changes = pendingChanges[uid];
    if (!changes || Object.keys(changes).length === 0) return;
    setSaving((s) => ({ ...s, [uid]: true }));
    try {
      const { role, ...profileChanges } = changes;
      if (role) await updateUserRole(uid, role);
      if (Object.keys(profileChanges).length > 0) await updateUserProfile(uid, profileChanges);
      setPendingChanges((p) => { const n = { ...p }; delete n[uid]; return n; });
      setSaveMsg((m) => ({ ...m, [uid]: "ok" }));
      setTimeout(() => setSaveMsg((m) => { const n = { ...m }; delete n[uid]; return n; }), 2500);
    } catch {
      setSaveMsg((m) => ({ ...m, [uid]: "err" }));
    } finally {
      setSaving((s) => { const n = { ...s }; delete n[uid]; return n; });
    }
  };

  // ── User lifecycle (approve / suspend / deactivate / reactivate / delete) ──
  const LIFECYCLE_CONFIRM = {
    suspend:    (u) => `Suspend ${u.fullName || u.email}? They will be signed out of the platform immediately and cannot sign back in until reactivated.`,
    deactivate: (u) => `Deactivate ${u.fullName || u.email}? This is a longer-term block — they will be signed out immediately and cannot sign back in until reactivated.`,
    reactivate: (u) => `Restore ${u.fullName || u.email} to Active? They will regain access immediately.`,
    delete:     (u) => `Permanently remove ${u.fullName || u.email} from the platform user list?\n\nThis deletes their platform profile only — Firebase Authentication records can only be removed from the Firebase Console (Authentication → Users), which a browser app cannot do. If this person can still sign in, they will reappear as a new "Pending Approval" account on next login and require re-approval.`,
  };

  const runLifecycleAction = async (u, action, fn, successText) => {
    const confirmMsg = LIFECYCLE_CONFIRM[action]?.(u);
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setLifecycleBusy((b) => ({ ...b, [u.id]: action }));
    setLifecycleMsg((m) => { const n = { ...m }; delete n[u.id]; return n; });
    try {
      await fn();
      setLifecycleMsg((m) => ({ ...m, [u.id]: { ok: true, text: successText } }));
      setTimeout(() => setLifecycleMsg((m) => { const n = { ...m }; delete n[u.id]; return n; }), 3000);
    } catch (err) {
      setLifecycleMsg((m) => ({ ...m, [u.id]: { ok: false, text: err.message || "Action failed" } }));
    } finally {
      setLifecycleBusy((b) => { const n = { ...b }; delete n[u.id]; return n; });
    }
  };

  const handleApprove    = (u) => runLifecycleAction(u, "approve",    () => approveUser(u.id, u.role || "viewer"), "Approved — account is now Active");
  const handleSuspend    = (u) => runLifecycleAction(u, "suspend",    () => suspendUser(u.id),                     "Suspended");
  const handleDeactivate = (u) => runLifecycleAction(u, "deactivate", () => deactivateUser(u.id),                  "Deactivated");
  const handleReactivate = (u) => runLifecycleAction(u, "reactivate", () => reactivateUser(u.id),                  "Restored to Active");
  const handleDelete     = (u) => runLifecycleAction(u, "delete",     () => deleteUserProfile(u.id),               "Removed from platform");

  // ── Invites ──────────────────────────────────────────────────
  const handleInvite = async (e) => {
    e.preventDefault();
    const trimmed = inviteEmail.trim().toLowerCase();
    if (!trimmed) return;
    setInviting(true);
    setInviteMsg("");
    try {
      await createPendingInvite(trimmed, inviteRole);
      setInviteMsg(`Invite set for ${trimmed}. They will receive "${ROLE_LABELS[inviteRole]}" when they sign up.`);
      setInviteEmail("");
      setInviteRole("viewer");
      await loadInvites();
    } catch (err) {
      setInviteMsg(`Error: ${err.message}`);
    } finally {
      setInviting(false);
    }
  };

  const handleRevoke = async (email) => {
    setRevoking((r) => ({ ...r, [email]: true }));
    try {
      await revokePendingInvite(email);
      setInvites((i) => i.filter((inv) => inv.email !== email));
    } catch { /* ignore */ }
    finally {
      setRevoking((r) => { const n = { ...r }; delete n[email]; return n; });
    }
  };

  // ── Sync ─────────────────────────────────────────────────────
  const handleSync = async () => {
    setSyncing(true);
    setSyncMsg("");
    try {
      const count = await syncLegacyUsers();
      setSyncMsg(
        count > 0
          ? `Backfilled ${count} user profile${count !== 1 ? "s" : ""} with missing fields.`
          : "All user profiles are up to date."
      );
    } catch (err) {
      setSyncMsg(`Sync failed: ${err.message}`);
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncMsg(""), 6000);
    }
  };

  const clearFilters = () => {
    setSearch("");
    setFilterRole("");
    setFilterStatus("");
    setFilterDept("");
  };
  const hasFilters = search || filterRole || filterStatus || filterDept;

  return (
    <div className="page-admin">

      {/* ── KPI row ───────────────────────────────── */}
      <section className="kpi-grid" style={{ marginBottom: 20 }} aria-label="Admin summary">
        <div className="kpi-card">
          <div className="kpi-icon" style={{ background: "rgba(125,60,152,0.1)", color: "var(--purple)" }} aria-hidden="true" />
          <div className="kpi-data">
            <span className="kpi-value">{usersLoading ? "—" : users.length}</span>
            <span className="kpi-title">Total Users</span>
            <span className="kpi-trend">
              {filtered.length !== users.length
                ? `${filtered.length} matching filter`
                : "All registered"}
            </span>
          </div>
        </div>
        <div className="kpi-card">
          <div className="kpi-icon" style={{ background: "rgba(30,158,82,0.1)", color: "#1E9E52" }} aria-hidden="true" />
          <div className="kpi-data">
            <span className="kpi-value">{usersLoading ? "—" : activeCount}</span>
            <span className="kpi-title">Active</span>
            <span className="kpi-trend">Cleared users</span>
          </div>
        </div>
        <div className="kpi-card">
          <div className="kpi-icon" style={{ background: "rgba(212,130,10,0.1)", color: "var(--warning)" }} aria-hidden="true" />
          <div className="kpi-data">
            <span className="kpi-value">{usersLoading ? "—" : pendingCount}</span>
            <span className="kpi-title">Pending Approval</span>
            <span className="kpi-trend">Awaiting review</span>
          </div>
        </div>
        <div className="kpi-card">
          <div className="kpi-icon" style={{ background: "rgba(26,116,188,0.1)", color: "#1A74BC" }} aria-hidden="true" />
          <div className="kpi-data">
            <span className="kpi-value">{invites.length || "—"}</span>
            <span className="kpi-title">Pending Invites</span>
            <span className="kpi-trend">Awaiting sign-up</span>
          </div>
        </div>
      </section>

      {/* ── Main Panel ────────────────────────────── */}
      <section className="panel" aria-label="Admin panel">
        <div className="panel-header">
          <h3>System Administration</h3>
          <span className="panel-badge">Signed in as {user?.email}</span>
        </div>

        {/* Tab bar */}
        <div className="inv-tab-bar" role="tablist" aria-label="Admin sections">
          {[
            { id: "users",       label: "Users" },
            { id: "invites",     label: "Invite Users" },
            { id: "permissions", label: "Department Permissions" },
            { id: "diagnostics", label: "Diagnostics" },
          ].map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={activeTab === t.id}
              className={`inv-tab-btn ${activeTab === t.id ? "inv-tab-btn--active" : ""}`}
              onClick={() => setActiveTab(t.id)}
            >
              {t.label}
              {t.id === "users" && pendingCount > 0 && (
                <span className="admin-tab-badge">{pendingCount}</span>
              )}
            </button>
          ))}
        </div>

        {/* ── Users tab ─────────────────────────── */}
        {activeTab === "users" && (
          <div>
            {/* Search & Filter bar */}
            {!usersLoading && !usersError && (
              <div className="admin-filter-bar">
                <input
                  type="search"
                  className="admin-search-input"
                  placeholder="Search by name, email or department…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  aria-label="Search users"
                />
                <select
                  className="admin-filter-select"
                  value={filterRole}
                  onChange={(e) => setFilterRole(e.target.value)}
                  aria-label="Filter by role"
                >
                  <option value="">All Roles</option>
                  {ROLES.map((r) => (
                    <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                  ))}
                </select>
                <select
                  className="admin-filter-select"
                  value={filterStatus}
                  onChange={(e) => setFilterStatus(e.target.value)}
                  aria-label="Filter by status"
                >
                  <option value="">All Status</option>
                  {STATUS_OPTIONS.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
                {departments.length > 0 && (
                  <select
                    className="admin-filter-select"
                    value={filterDept}
                    onChange={(e) => setFilterDept(e.target.value)}
                    aria-label="Filter by department"
                  >
                    <option value="">All Depts</option>
                    {departments.map((d) => (
                      <option key={d} value={d}>{d}</option>
                    ))}
                  </select>
                )}
                {hasFilters && (
                  <button className="admin-refresh-btn" onClick={clearFilters}>
                    Clear
                  </button>
                )}
              </div>
            )}

            {/* Skeleton while loading */}
            {usersLoading && (
              <div className="table-scroll">
                <table className="data-table" aria-busy="true" aria-label="Loading users">
                  <thead>
                    <tr>
                      <th>User</th><th>Role</th><th>Status</th>
                      <th>Department</th><th>Rank</th>
                      <th>Member Since</th><th>Last Login</th><th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Array.from({ length: 5 }, (_, i) => <SkeletonRow key={i} />)}
                  </tbody>
                </table>
              </div>
            )}

            {!usersLoading && usersError && (
              <div className="error-state" style={{ minHeight: 120 }}>
                <span className="error-icon">!</span>
                <p>Failed to load users</p>
                <p className="error-detail">{usersError}</p>
              </div>
            )}

            {!usersLoading && !usersError && sorted.length === 0 && (
              <div className="empty-state" style={{ padding: "40px 20px" }}>
                <p>
                  {users.length === 0
                    ? "No registered users yet."
                    : "No users match the current filters."}
                </p>
              </div>
            )}

            {!usersLoading && !usersError && sorted.length > 0 && (
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <SortTh label="User"         field="name"      sortField={sortField} sortDir={sortDir} onSort={handleSort} />
                      <SortTh label="Role"         field="role"      sortField={sortField} sortDir={sortDir} onSort={handleSort} />
                      <SortTh label="Status"       field="status"    sortField={sortField} sortDir={sortDir} onSort={handleSort} />
                      <th scope="col">Department</th>
                      <th scope="col">Rank</th>
                      <SortTh label="Member Since" field="createdAt" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
                      <SortTh label="Last Login"   field="lastLogin" sortField={sortField} sortDir={sortDir} onSort={handleSort} />
                      <th scope="col">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paged.map((u) => {
                      const isMe    = u.id === user?.uid;
                      const changes = pendingChanges[u.id] || {};
                      const isDirty = Object.keys(changes).length > 0;
                      const msg     = saveMsg[u.id];

                      const displayRole   = changes.role          ?? u.role          ?? "viewer";
                      const displayStatus = changes.accountStatus ?? u.accountStatus ?? "Active";
                      const displayDept   = changes.department    ?? u.department    ?? "";
                      const displayRank   = changes.rank          ?? u.rank          ?? "";
                      const statusKey     = STATUS_KEY[displayStatus] ?? "active";

                      return (
                        <tr key={u.id} className={isMe ? "row--selected" : ""}>
                          {/* User cell */}
                          <td>
                            <div className="admin-user-cell">
                              <div className="admin-user-avatar">{initials(u.fullName, u.email)}</div>
                              <div>
                                <div className="admin-user-name">
                                  {u.fullName || u.email || "—"}
                                  {isMe && <span className="admin-you-badge">You</span>}
                                </div>
                                {u.fullName && (
                                  <div className="admin-user-email">{u.email}</div>
                                )}
                              </div>
                            </div>
                          </td>

                          {/* Role */}
                          <td>
                            <select
                              className="admin-role-select"
                              value={displayRole}
                              onChange={(e) => handleFieldChange(u.id, "role", e.target.value)}
                              disabled={isMe || saving[u.id]}
                              aria-label={`Role for ${u.email}`}
                            >
                              {ROLES.map((r) => (
                                <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                              ))}
                            </select>
                          </td>

                          {/* Status — dot badge + select */}
                          <td>
                            <div className="admin-status-cell">
                              <span
                                className={`admin-status-dot admin-status-dot--${statusKey}`}
                                aria-label={displayStatus}
                              />
                              <select
                                className="admin-role-select"
                                value={displayStatus}
                                onChange={(e) => handleFieldChange(u.id, "accountStatus", e.target.value)}
                                disabled={isMe || saving[u.id]}
                                aria-label={`Status for ${u.email}`}
                              >
                                {STATUS_OPTIONS.map((s) => (
                                  <option key={s} value={s}>{s}</option>
                                ))}
                              </select>
                            </div>
                          </td>

                          {/* Department */}
                          <td>
                            <select
                              className="admin-field-input"
                              value={DEPARTMENTS.includes(displayDept) ? displayDept : ""}
                              onChange={(e) => handleFieldChange(u.id, "department", e.target.value)}
                              disabled={isMe || saving[u.id]}
                              aria-label={`Department for ${u.email}`}
                            >
                              <option value="">— Select —</option>
                              {!DEPARTMENTS.includes(displayDept) && displayDept && (
                                <option value={displayDept}>{displayDept} (legacy)</option>
                              )}
                              {DEPARTMENTS.map((d) => (
                                <option key={d} value={d}>{d}</option>
                              ))}
                            </select>
                          </td>

                          {/* Rank */}
                          <td>
                            <input
                              className="admin-field-input"
                              type="text"
                              value={displayRank}
                              onChange={(e) => handleFieldChange(u.id, "rank", e.target.value)}
                              placeholder="—"
                              disabled={saving[u.id]}
                              aria-label={`Rank for ${u.email}`}
                            />
                          </td>

                          {/* Member Since */}
                          <td className="mono" style={{ fontSize: 12, whiteSpace: "nowrap" }}>
                            {fmt(u.createdAt)}
                          </td>

                          {/* Last Login */}
                          <td className="mono" style={{ fontSize: 12, whiteSpace: "nowrap", color: "var(--text-muted)" }}>
                            {fmt(u.lastLogin)}
                          </td>

                          {/* Actions */}
                          <td>
                            {isMe ? (
                              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                                Cannot edit own account
                              </span>
                            ) : (
                              <div className="admin-actions-cell">
                                <div className="admin-actions-row">
                                  <button
                                    className="admin-save-btn"
                                    onClick={() => handleSave(u.id)}
                                    disabled={!isDirty || saving[u.id]}
                                  >
                                    {saving[u.id] ? "Saving…" : "Save"}
                                  </button>
                                  {msg && (
                                    <span className={`admin-save-msg ${msg === "ok" ? "admin-save-msg--ok" : "admin-save-msg--err"}`}>
                                      {msg === "ok" ? "Saved" : "Error"}
                                    </span>
                                  )}
                                </div>

                                <div className="admin-actions-row">
                                  {displayStatus === "Pending Approval" && (
                                    <button
                                      className="admin-approve-btn"
                                      onClick={() => handleApprove(u)}
                                      disabled={!!lifecycleBusy[u.id]}
                                      title={`Approve and activate as ${ROLE_LABELS[u.role || "viewer"]}`}
                                    >
                                      {lifecycleBusy[u.id] === "approve" ? "Approving…" : "Approve"}
                                    </button>
                                  )}
                                  {displayStatus === "Active" && (
                                    <>
                                      <button
                                        className="admin-revoke-btn"
                                        onClick={() => handleSuspend(u)}
                                        disabled={!!lifecycleBusy[u.id]}
                                        title="Temporarily block sign-in"
                                      >
                                        {lifecycleBusy[u.id] === "suspend" ? "Suspending…" : "Suspend"}
                                      </button>
                                      <button
                                        className="admin-revoke-btn"
                                        onClick={() => handleDeactivate(u)}
                                        disabled={!!lifecycleBusy[u.id]}
                                        title="Longer-term block on sign-in"
                                      >
                                        {lifecycleBusy[u.id] === "deactivate" ? "Deactivating…" : "Deactivate"}
                                      </button>
                                    </>
                                  )}
                                  {(displayStatus === "Suspended" || displayStatus === "Deactivated") && (
                                    <button
                                      className="admin-approve-btn"
                                      onClick={() => handleReactivate(u)}
                                      disabled={!!lifecycleBusy[u.id]}
                                      title="Restore access immediately"
                                    >
                                      {lifecycleBusy[u.id] === "reactivate" ? "Restoring…" : "Reactivate"}
                                    </button>
                                  )}
                                  <button
                                    className="admin-revoke-btn"
                                    onClick={() => handleDelete(u)}
                                    disabled={!!lifecycleBusy[u.id]}
                                    title="Remove their platform profile"
                                  >
                                    {lifecycleBusy[u.id] === "delete" ? "Removing…" : "Delete"}
                                  </button>
                                </div>

                                {lifecycleMsg[u.id] && (
                                  <span className={`admin-save-msg ${lifecycleMsg[u.id].ok ? "admin-save-msg--ok" : "admin-save-msg--err"}`}>
                                    {lifecycleMsg[u.id].text}
                                  </span>
                                )}
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* Pagination */}
            {!usersLoading && !usersError && totalPages > 1 && (
              <div className="admin-pagination" aria-label="Pagination">
                <button
                  className="admin-pagination-btn"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1}
                  aria-label="Previous page"
                >‹</button>
                {Array.from({ length: totalPages }, (_, i) => i + 1)
                  .filter((p) => p === 1 || p === totalPages || Math.abs(p - page) <= 1)
                  .reduce((acc, p, idx, arr) => {
                    if (idx > 0 && p - arr[idx - 1] > 1) acc.push("…");
                    acc.push(p);
                    return acc;
                  }, [])
                  .map((item, idx) =>
                    item === "…" ? (
                      <span key={`ell-${idx}`} style={{ padding: "0 4px", color: "var(--text-muted)" }}>…</span>
                    ) : (
                      <button
                        key={item}
                        className={`admin-pagination-btn ${item === page ? "admin-pagination-btn--active" : ""}`}
                        onClick={() => setPage(item)}
                        aria-label={`Page ${item}`}
                        aria-current={item === page ? "page" : undefined}
                      >{item}</button>
                    )
                  )}
                <button
                  className="admin-pagination-btn"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  aria-label="Next page"
                >›</button>
                <span style={{ marginLeft: 8, fontSize: 12, color: "var(--text-muted)" }}>
                  {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, sorted.length)} of {sorted.length}
                </span>
              </div>
            )}

            {/* Footer */}
            <div className="admin-panel-footer">
              <button className="admin-refresh-btn" onClick={handleSync} disabled={syncing}>
                {syncing ? "Syncing…" : "Repair Missing Profiles"}
              </button>
              {syncMsg && <span className="admin-sync-msg">{syncMsg}</span>}
              <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-muted)" }}>
                Live · updates automatically
              </span>
            </div>
          </div>
        )}

        {/* ── Invites tab ────────────────────────── */}
        {activeTab === "invites" && (
          <div>
            <div className="admin-invite-form-wrap">
              <h4 className="admin-section-title">Invite a New User</h4>
              <p className="admin-section-desc">
                Pre-assign a role to an email address. The user will receive this role automatically when they sign up.
              </p>
              <form onSubmit={handleInvite} className="admin-invite-form">
                <input
                  type="email"
                  className="issuance-input"
                  placeholder="user@example.com"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  required
                  aria-label="Invite email"
                />
                <select
                  className="admin-role-select"
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value)}
                  aria-label="Invite role"
                >
                  {ROLES.filter((r) => r !== "admin").map((r) => (
                    <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                  ))}
                </select>
                <button type="submit" className="issuance-submit-btn" disabled={inviting}>
                  {inviting ? "Sending…" : "Send Invite"}
                </button>
              </form>
              {inviteMsg && (
                <div className={`admin-invite-msg ${inviteMsg.startsWith("Error") ? "admin-invite-msg--err" : "admin-invite-msg--ok"}`}>
                  {inviteMsg}
                </div>
              )}
            </div>

            <div style={{ padding: "0 16px 16px" }}>
              <h4 className="admin-section-title">Pending Invites</h4>
              {invitesLoading && (
                <div className="loading-state" style={{ minHeight: 80 }}>
                  <div className="spinner" /><p>Loading…</p>
                </div>
              )}
              {!invitesLoading && invitesError && (
                <div className="error-state" style={{ minHeight: 60 }}>
                  <span className="error-icon">!</span>
                  <p className="error-detail">{invitesError}</p>
                </div>
              )}
              {!invitesLoading && !invitesError && invites.length === 0 && (
                <p style={{ fontSize: 13, color: "var(--text-muted)" }}>No pending invites.</p>
              )}
              {!invitesLoading && !invitesError && invites.length > 0 && (
                <div className="table-scroll">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th scope="col">Email</th>
                        <th scope="col">Assigned Role</th>
                        <th scope="col">Invited On</th>
                        <th scope="col">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {invites.map((inv) => (
                        <tr key={inv.email}>
                          <td className="bold">{inv.email}</td>
                          <td>
                            <span className="admin-role-pill admin-role-pill--pending">
                              {ROLE_LABELS[inv.role] || inv.role}
                            </span>
                          </td>
                          <td className="mono" style={{ fontSize: 12 }}>{fmt(inv.invitedAt)}</td>
                          <td>
                            <button
                              className="admin-revoke-btn"
                              onClick={() => handleRevoke(inv.email)}
                              disabled={revoking[inv.email]}
                            >
                              {revoking[inv.email] ? "…" : "Revoke"}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Diagnostics tab ───────────────────── */}
        {activeTab === "diagnostics" && (() => {
          const missingEmail      = users.filter((u) => !u.email).length;
          const missingCreatedAt  = users.filter((u) => !u.createdAt).length;
          const missingStatus     = users.filter((u) => !u.accountStatus).length;
          const missingName       = users.filter((u) => !u.fullName?.trim()).length;
          const incompleteCount   = users.filter(
            (u) => !u.email || !u.createdAt || !u.accountStatus
          ).length;

          const roleCounts = ["admin", "supervisor", "storekeeper", "viewer"].map((r) => ({
            role: r,
            count: users.filter((u) => u.role === r).length,
          }));

          const handleTestWrite = async () => {
            setWriteTesting(true);
            setWriteTest(null);
            const result = await testFirestoreWrite(user?.uid || "test");
            setWriteTest(result);
            setWriteTesting(false);
          };

          return (
            <div className="diag-wrap">
              <h4 className="admin-section-title">Registration &amp; Sync Diagnostics</h4>
              <p className="admin-section-desc">
                All counts are derived from the live Firestore <code>userRoles</code> collection.
                Firebase Auth user count requires the Admin SDK and cannot be read from the browser.
              </p>

              {/* Stat grid */}
              <div className="diag-stat-grid">
                <div className="diag-stat">
                  <span className="diag-stat-value">{usersLoading ? "—" : users.length}</span>
                  <span className="diag-stat-label">Firestore Users</span>
                </div>
                <div className="diag-stat">
                  <span className="diag-stat-value diag-ok">{usersLoading ? "—" : activeCount}</span>
                  <span className="diag-stat-label">Active</span>
                </div>
                <div className="diag-stat">
                  <span className="diag-stat-value diag-warn">{usersLoading ? "—" : pendingCount}</span>
                  <span className="diag-stat-label">Pending Approval</span>
                </div>
                <div className="diag-stat">
                  <span className={`diag-stat-value ${incompleteCount > 0 ? "diag-err" : "diag-ok"}`}>
                    {usersLoading ? "—" : incompleteCount}
                  </span>
                  <span className="diag-stat-label">Incomplete Profiles</span>
                </div>
                <div className="diag-stat">
                  <span className={`diag-stat-value ${missingEmail > 0 ? "diag-err" : "diag-ok"}`}>
                    {usersLoading ? "—" : missingEmail}
                  </span>
                  <span className="diag-stat-label">Missing Email</span>
                </div>
                <div className="diag-stat">
                  <span className={`diag-stat-value ${missingCreatedAt > 0 ? "diag-warn" : "diag-ok"}`}>
                    {usersLoading ? "—" : missingCreatedAt}
                  </span>
                  <span className="diag-stat-label">Missing createdAt</span>
                </div>
                <div className="diag-stat">
                  <span className={`diag-stat-value ${missingStatus > 0 ? "diag-warn" : "diag-ok"}`}>
                    {usersLoading ? "—" : missingStatus}
                  </span>
                  <span className="diag-stat-label">Missing Status</span>
                </div>
                <div className="diag-stat">
                  <span className="diag-stat-value diag-muted">{usersLoading ? "—" : missingName}</span>
                  <span className="diag-stat-label">Missing Full Name</span>
                </div>
              </div>

              {/* Role breakdown */}
              <h4 className="admin-section-title" style={{ marginTop: 20 }}>Users by Role</h4>
              <div className="diag-role-row">
                {roleCounts.map(({ role, count }) => (
                  <div key={role} className="diag-role-pill">
                    <span className="diag-role-name">{role}</span>
                    <span className="diag-role-count">{usersLoading ? "—" : count}</span>
                  </div>
                ))}
              </div>

              {/* Last snapshot */}
              <div className="diag-meta">
                <span>Last snapshot update:</span>
                <strong>
                  {lastUpdated
                    ? lastUpdated.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
                    : "—"}
                </strong>
              </div>

              {/* Firestore write test */}
              <h4 className="admin-section-title" style={{ marginTop: 20 }}>Firestore Write-Access Test</h4>
              <p className="admin-section-desc">
                Verifies that this browser can write to Firestore. A write failure here
                means Firestore security rules are blocking new user profile creation —
                the most common reason new users do not appear in Admin Panel.
              </p>
              <div className="diag-test-row">
                <button
                  className="admin-refresh-btn"
                  onClick={handleTestWrite}
                  disabled={writeTesting}
                >
                  {writeTesting ? "Testing…" : "Run Write Test"}
                </button>
                {writeTest && (
                  <span className={`diag-test-result ${writeTest.ok ? "diag-ok" : "diag-err"}`}>
                    {writeTest.ok
                      ? `PASS — write + delete completed in ${writeTest.ms}ms`
                      : `FAIL — ${writeTest.error}: ${writeTest.message}`}
                  </span>
                )}
              </div>
              {writeTest && !writeTest.ok && (
                <div className="diag-rules-hint">
                  <strong>Fix:</strong> Open Firebase Console → Firestore → Rules and ensure
                  authenticated users can create their own <code>userRoles</code> document:
                  <pre className="diag-rules-pre">{`rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    match /userRoles/{uid} {
      allow read  : if request.auth != null;
      allow create: if request.auth.uid == uid;
      allow update: if request.auth.uid == uid
                    || get(/databases/$(database)/documents/userRoles/$(request.auth.uid)).data.role == 'admin';
      allow delete: if get(/databases/$(database)/documents/userRoles/$(request.auth.uid)).data.role == 'admin';
    }

    match /pendingRoles/{email} {
      allow read, write: if request.auth != null
                         && get(/databases/$(database)/documents/userRoles/$(request.auth.uid)).data.role == 'admin';
      allow delete: if request.auth != null;
    }

    match /_diagnostics/{id} {
      allow read, write, delete: if request.auth != null;
    }

    match /{document=**} {
      allow read, write: if request.auth != null;
    }
  }
}`}</pre>
                </div>
              )}

              {/* Failed registrations recovery */}
              <h4 className="admin-section-title" style={{ marginTop: 20 }}>
                Pending Registration Approvals
                {failedRegs.length > 0 && (
                  <span className="admin-tab-badge" style={{ marginLeft: 8 }}>{failedRegs.length}</span>
                )}
              </h4>
              <p className="admin-section-desc">
                Accounts created in Firebase Auth that could not write their profile to Firestore
                (typically due to security rules). Click <strong>Approve</strong> to create their
                profile using your admin credentials.
              </p>
              {failedRegs.length === 0 ? (
                <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 8 }}>
                  No pending registration approvals.
                </p>
              ) : (
                <div className="table-scroll" style={{ marginTop: 8 }}>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Email</th>
                        <th>Full Name</th>
                        <th>UID</th>
                        <th>Failed At</th>
                        <th>Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {failedRegs.map((entry) => {
                        const isApproving = approving[entry.id];
                        return (
                          <tr key={entry.id}>
                            <td className="bold">{entry.email || "—"}</td>
                            <td>{entry.fullName || "—"}</td>
                            <td className="mono" style={{ fontSize: 11 }}>{entry.id.slice(0, 12)}…</td>
                            <td className="mono" style={{ fontSize: 11 }}>
                              {entry.failedAt
                                ? (entry.failedAt.toDate
                                    ? entry.failedAt.toDate().toLocaleString("en-GB")
                                    : new Date(entry.failedAt).toLocaleString("en-GB"))
                                : "—"}
                            </td>
                            <td>
                              <button
                                className="admin-save-btn"
                                disabled={isApproving}
                                onClick={async () => {
                                  setApproving((a) => ({ ...a, [entry.id]: true }));
                                  try {
                                    await approveFailedRegistration(entry, entry.role || "viewer");
                                  } catch (err) {
                                    console.error("[ARIMA] Approve failed:", err.message);
                                  } finally {
                                    setApproving((a) => { const n = { ...a }; delete n[entry.id]; return n; });
                                  }
                                }}
                              >
                                {isApproving ? "Approving…" : "Approve"}
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Data migration */}
              <h4 className="admin-section-title" style={{ marginTop: 20 }}>Migrate Legacy Receipt Data</h4>
              <p className="admin-section-desc">
                One-time migration: copies any records from the old <code>manualReceipts</code> collection
                into the new <code>receipts</code> collection. Safe to run multiple times — existing records are skipped.
                Run this once after the inventory-only upgrade to preserve historical data.
              </p>
              <div className="diag-test-row">
                <button
                  className="admin-refresh-btn"
                  onClick={async () => {
                    setMigrating(true);
                    setMigrateMsg("");
                    try {
                      const count = await migrateManualReceipts();
                      setMigrateMsg(count > 0
                        ? `Migrated ${count} record${count !== 1 ? "s" : ""} to the receipts collection.`
                        : "Nothing to migrate — all records already exist in receipts, or manualReceipts is empty.");
                    } catch (err) {
                      setMigrateMsg(`Migration failed: ${err.message}`);
                    } finally {
                      setMigrating(false);
                    }
                  }}
                  disabled={migrating}
                >
                  {migrating ? "Migrating…" : "Run Migration"}
                </button>
                {migrateMsg && (
                  <span className={`admin-sync-msg ${migrateMsg.startsWith("Migration failed") ? "" : ""}`}>
                    {migrateMsg}
                  </span>
                )}
              </div>

              {/* Repair button */}
              <h4 className="admin-section-title" style={{ marginTop: 20 }}>Repair Incomplete Profiles</h4>
              <p className="admin-section-desc">
                Backfills any missing fields on existing <code>userRoles</code> documents.
                Run this after updating security rules to fix any accounts that failed to sync.
              </p>
              <div className="diag-test-row">
                <button className="admin-refresh-btn" onClick={handleSync} disabled={syncing}>
                  {syncing ? "Repairing…" : "Repair Missing Fields"}
                </button>
                {syncMsg && <span className="admin-sync-msg">{syncMsg}</span>}
              </div>
            </div>
          );
        })()}

        {/* ── Department Permissions tab ────────── */}
        {activeTab === "permissions" && (
          <div style={{ padding: "16px" }}>
            <div className="admin-perm-header">
              <p className="admin-section-desc" style={{ marginBottom: 0, maxWidth: 720 }}>
                Set each department's access level for every page. Administrators always
                have Full Access regardless of these settings. Changes apply immediately,
                platform-wide, and are recorded in the audit log below.
              </p>
              <button className="admin-refresh-btn" onClick={handleSeedMatrix} disabled={seeding}>
                {seeding ? "Seeding…" : "Seed Default Permissions"}
              </button>
            </div>
            {seedMsg && <p className="admin-sync-msg" style={{ marginTop: 8 }}>{seedMsg}</p>}

            {permLoading && <p className="admin-section-desc">Loading permission matrix…</p>}
            {permError && (
              <p className="admin-section-desc" style={{ color: "var(--danger)" }}>Error: {permError}</p>
            )}

            {!permLoading && !permError && permRows.map((row) => {
              const edits = permEdits[row.key] ?? {};
              const dirty = Object.keys(edits).length > 0;
              return (
                <div key={row.key} className="admin-perm-page-card">
                  <div className="admin-perm-page-head">
                    <h4 className="admin-section-title" style={{ margin: 0 }}>
                      {row.label}
                      {row.locked && (
                        <span className="admin-perm-locked-badge">Administrators only</span>
                      )}
                    </h4>
                    <div className="admin-perm-page-actions">
                      {permMsg[row.key] && <span className="admin-sync-msg">{permMsg[row.key]}</span>}
                      <button
                        className="admin-refresh-btn"
                        onClick={() => handleSavePagePermissions(row)}
                        disabled={!dirty || row.locked || permSaving[row.key]}
                      >
                        {permSaving[row.key] ? "Saving…" : "Save Changes"}
                      </button>
                    </div>
                  </div>

                  {row.locked ? (
                    <p className="admin-section-desc">
                      This page is restricted to platform Administrators only — it is not
                      governed by department permissions and cannot be reconfigured here.
                    </p>
                  ) : (
                    <div className="admin-matrix-wrap">
                      <table className="data-table admin-matrix">
                        <thead>
                          <tr>
                            <th scope="col">Department</th>
                            <th scope="col">Permission Level</th>
                          </tr>
                        </thead>
                        <tbody>
                          {DEPARTMENTS.map((dept) => {
                            const saved   = row.permissions?.[dept] ?? "View Only";
                            const level   = edits[dept] ?? saved;
                            const changed = dept in edits && edits[dept] !== saved;
                            return (
                              <tr key={dept}>
                                <td className="bold">{dept}</td>
                                <td>
                                  <select
                                    className="admin-role-select"
                                    value={level}
                                    onChange={(e) => handlePermLevelChange(row.key, dept, e.target.value)}
                                    aria-label={`${row.label} permission level for ${dept}`}
                                  >
                                    {PERMISSION_LEVELS.map((lvl) => (
                                      <option key={lvl} value={lvl}>{lvl}</option>
                                    ))}
                                  </select>
                                  {changed && (
                                    <span
                                      className="admin-perm-changed-dot"
                                      title="Unsaved change"
                                      aria-label="Unsaved change"
                                    />
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}

            {/* Audit log */}
            <h4 className="admin-section-title" style={{ marginTop: 28 }}>Permission Change Audit Log</h4>
            <p className="admin-section-desc">Most recent changes to department permissions, newest first.</p>
            {auditLoading && <p className="admin-section-desc">Loading audit log…</p>}
            {!auditLoading && auditLog.length === 0 && (
              <p className="admin-section-desc">No permission changes have been recorded yet.</p>
            )}
            {!auditLoading && auditLog.length > 0 && (
              <div className="admin-matrix-wrap">
                <table className="data-table admin-matrix">
                  <thead>
                    <tr>
                      <th scope="col">When</th>
                      <th scope="col">Administrator</th>
                      <th scope="col">Page</th>
                      <th scope="col">Department</th>
                      <th scope="col">Previous Level</th>
                      <th scope="col">New Level</th>
                    </tr>
                  </thead>
                  <tbody>
                    {auditLog.map((entry) => (
                      <tr key={entry.id}>
                        <td className="mono" style={{ fontSize: 11, whiteSpace: "nowrap" }}>{fmtDateTime(entry.changedAt)}</td>
                        <td>{entry.changedBy || "—"}</td>
                        <td>{entry.pageLabel || entry.pageKey}</td>
                        <td>{entry.department}</td>
                        <td>{entry.previousLevel}</td>
                        <td className="bold">{entry.newLevel}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

export default AdminPanel;
