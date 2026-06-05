import { useEffect, useState, useCallback, useMemo } from "react";
import { useUser } from "../context/UserContext";
import {
  subscribeToUsers,
  updateUserRole,
  updateUserProfile,
  getPendingInvites,
  createPendingInvite,
  revokePendingInvite,
  syncLegacyUsers,
} from "../services/adminService";
import { ROLES, ROLE_LABELS, ROUTE_ACCESS, NAV_ITEMS } from "../utils/permissions";

const PAGE_SIZE = 20;
const STATUS_OPTIONS = ["Active", "Inactive", "Suspended"];

function fmt(ts) {
  if (!ts) return "—";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function initials(name, email) {
  if (name && name.trim()) {
    return name.trim().split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  }
  return ((email || "?")[0]).toUpperCase();
}

function SkeletonRow() {
  const widths = [65, 45, 35, 35, 30, 35, 40];
  return (
    <tr aria-hidden="true">
      {widths.map((w, i) => (
        <td key={i}><div className="skeleton" style={{ width: `${w}%` }} /></td>
      ))}
    </tr>
  );
}

// ─── Role Access Matrix ───────────────────────────────────────
function AccessMatrix() {
  const pages = NAV_ITEMS.filter((n) => n.path !== "/admin");
  const adminItem = NAV_ITEMS.find((n) => n.path === "/admin");
  return (
    <div className="admin-matrix-wrap">
      <table className="data-table admin-matrix">
        <thead>
          <tr>
            <th scope="col">Role</th>
            {pages.map((p) => <th key={p.path} scope="col">{p.label}</th>)}
            <th scope="col">{adminItem.label}</th>
            <th scope="col">Can Issue Items</th>
          </tr>
        </thead>
        <tbody>
          {ROLES.map((role) => (
            <tr key={role}>
              <td className="bold">{ROLE_LABELS[role]}</td>
              {pages.map((p) => (
                <td key={p.path} className="admin-matrix-cell">
                  {(ROUTE_ACCESS[p.path] ?? []).includes(role)
                    ? <span className="access-yes" aria-label="Access granted">✓</span>
                    : <span className="access-no"  aria-label="No access">—</span>}
                </td>
              ))}
              <td className="admin-matrix-cell">
                {role === "admin"
                  ? <span className="access-yes" aria-label="Access granted">✓</span>
                  : <span className="access-no"  aria-label="No access">—</span>}
              </td>
              <td className="admin-matrix-cell">
                {["admin", "storekeeper"].includes(role)
                  ? <span className="access-yes" aria-label="Access granted">✓</span>
                  : <span className="access-no"  aria-label="No access">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Main Admin Panel ─────────────────────────────────────────
function AdminPanel() {
  const user = useUser();
  const [activeTab, setActiveTab] = useState("users");

  // ── Users ───────────────────────────────────────────────────
  const [users, setUsers]                   = useState([]);
  const [usersLoading, setUsersLoading]     = useState(true);
  const [usersError, setUsersError]         = useState(null);
  const [pendingChanges, setPendingChanges] = useState({});
  const [saving, setSaving]                 = useState({});
  const [saveMsg, setSaveMsg]               = useState({});

  // ── Search & Filter ─────────────────────────────────────────
  const [search, setSearch]             = useState("");
  const [filterRole, setFilterRole]     = useState("");
  const [filterStatus, setFilterStatus] = useState("");
  const [filterDept, setFilterDept]     = useState("");
  const [filterRank, setFilterRank]     = useState("");
  const [page, setPage]                 = useState(1);

  // ── Migration ───────────────────────────────────────────────
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");

  // ── Invites ─────────────────────────────────────────────────
  const [invites, setInvites]               = useState([]);
  const [invitesLoading, setInvitesLoading] = useState(true);
  const [invitesError, setInvitesError]     = useState(null);
  const [inviteEmail, setInviteEmail]       = useState("");
  const [inviteRole, setInviteRole]         = useState("viewer");
  const [inviting, setInviting]             = useState(false);
  const [inviteMsg, setInviteMsg]           = useState("");
  const [revoking, setRevoking]             = useState({});

  // Real-time subscription — replaces one-shot getDocs
  useEffect(() => {
    const unsub = subscribeToUsers(
      (data) => { setUsers(data); setUsersLoading(false); setUsersError(null); },
      (err)  => { setUsersError(err.message); setUsersLoading(false); }
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

  // Derived filter options
  const departments = useMemo(
    () => [...new Set(users.map((u) => u.department).filter(Boolean))].sort(),
    [users]
  );
  const ranks = useMemo(
    () => [...new Set(users.map((u) => u.rank).filter(Boolean))].sort(),
    [users]
  );

  // Client-side search + filter
  const filtered = useMemo(() => {
    let list = users;
    if (search.trim()) {
      const s = search.trim().toLowerCase();
      list = list.filter(
        (u) =>
          (u.fullName || "").toLowerCase().includes(s) ||
          (u.email    || "").toLowerCase().includes(s)
      );
    }
    if (filterRole)   list = list.filter((u) => u.role === filterRole);
    if (filterStatus) list = list.filter((u) => (u.accountStatus || "Active") === filterStatus);
    if (filterDept)   list = list.filter((u) => u.department === filterDept);
    if (filterRank)   list = list.filter((u) => u.rank === filterRank);
    return list;
  }, [users, search, filterRole, filterStatus, filterDept, filterRank]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const paged      = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // Reset to page 1 whenever filters change
  useEffect(() => setPage(1), [search, filterRole, filterStatus, filterDept, filterRank]);

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
      setSaveMsg((m) => ({ ...m, [uid]: "Saved" }));
      setTimeout(() => setSaveMsg((m) => { const n = { ...m }; delete n[uid]; return n; }), 2000);
    } catch {
      setSaveMsg((m) => ({ ...m, [uid]: "Error" }));
    } finally {
      setSaving((s) => { const n = { ...s }; delete n[uid]; return n; });
    }
  };

  // ── Invites ──────────────────────────────────────────────────
  const handleInvite = async (e) => {
    e.preventDefault();
    const trimmed = inviteEmail.trim().toLowerCase();
    if (!trimmed) return;
    setInviting(true);
    setInviteMsg("");
    try {
      await createPendingInvite(trimmed, inviteRole);
      setInviteMsg(`Invite set for ${trimmed}. They will receive the "${ROLE_LABELS[inviteRole]}" role when they sign up.`);
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

  // ── Migration ────────────────────────────────────────────────
  const handleSync = async () => {
    setSyncing(true);
    setSyncMsg("");
    try {
      const count = await syncLegacyUsers();
      setSyncMsg(count > 0 ? `Synced ${count} legacy user(s).` : "All users already up to date.");
    } catch (err) {
      setSyncMsg(`Sync failed: ${err.message}`);
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncMsg(""), 5000);
    }
  };

  return (
    <div className="page-admin">
      {/* ── KPI row ─────────────────────────────── */}
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
          <div className="kpi-icon" style={{ background: "rgba(26,116,188,0.1)", color: "#1A74BC" }} aria-hidden="true" />
          <div className="kpi-data">
            <span className="kpi-value">{invites.length || "—"}</span>
            <span className="kpi-title">Pending Invites</span>
            <span className="kpi-trend">Awaiting sign-up</span>
          </div>
        </div>
        <div className="kpi-card">
          <div className="kpi-icon" style={{ background: "rgba(30,158,82,0.1)", color: "#1E9E52" }} aria-hidden="true" />
          <div className="kpi-data">
            <span className="kpi-value">{ROLES.length}</span>
            <span className="kpi-title">Available Roles</span>
            <span className="kpi-trend">Admin · Supervisor · Storekeeper · Viewer</span>
          </div>
        </div>
      </section>

      {/* ── Main Panel ──────────────────────────── */}
      <section className="panel" aria-label="Admin panel">
        <div className="panel-header">
          <h3>System Administration</h3>
          <span className="panel-badge">Signed in as {user?.email}</span>
        </div>

        {/* Tab bar */}
        <div className="inv-tab-bar" role="tablist" aria-label="Admin sections">
          {[
            { id: "users",   label: "Active Users" },
            { id: "invites", label: "Invite Users" },
            { id: "access",  label: "Role Access Guide" },
          ].map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={activeTab === t.id}
              className={`inv-tab-btn ${activeTab === t.id ? "inv-tab-btn--active" : ""}`}
              onClick={() => setActiveTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* ── Active Users ─────────────────────── */}
        {activeTab === "users" && (
          <div>
            {/* Search & Filter bar — only shown when data is ready */}
            {!usersLoading && !usersError && (
              <div className="admin-filter-bar">
                <input
                  type="search"
                  className="admin-search-input"
                  placeholder="Search by name or email…"
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
                {ranks.length > 0 && (
                  <select
                    className="admin-filter-select"
                    value={filterRank}
                    onChange={(e) => setFilterRank(e.target.value)}
                    aria-label="Filter by rank"
                  >
                    <option value="">All Ranks</option>
                    {ranks.map((r) => (
                      <option key={r} value={r}>{r}</option>
                    ))}
                  </select>
                )}
                {(search || filterRole || filterStatus || filterDept || filterRank) && (
                  <button
                    className="admin-refresh-btn"
                    onClick={() => {
                      setSearch("");
                      setFilterRole("");
                      setFilterStatus("");
                      setFilterDept("");
                      setFilterRank("");
                    }}
                  >
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
                      <th>User</th>
                      <th>Role</th>
                      <th>Status</th>
                      <th>Department</th>
                      <th>Rank</th>
                      <th>Member Since</th>
                      <th>Actions</th>
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

            {!usersLoading && !usersError && filtered.length === 0 && (
              <div className="empty-state" style={{ padding: "40px 20px" }}>
                <p>
                  {users.length === 0
                    ? "No registered users yet."
                    : "No users match the current filters."}
                </p>
              </div>
            )}

            {!usersLoading && !usersError && filtered.length > 0 && (
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th scope="col">User</th>
                      <th scope="col">Role</th>
                      <th scope="col">Status</th>
                      <th scope="col">Department</th>
                      <th scope="col">Rank</th>
                      <th scope="col">Member Since</th>
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

                      return (
                        <tr key={u.id} className={isMe ? "row--selected" : ""}>
                          <td>
                            <div className="admin-user-cell">
                              <div className="admin-user-avatar">
                                {initials(u.fullName, u.email)}
                              </div>
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
                          <td>
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
                          </td>
                          <td>
                            <input
                              className="admin-field-input"
                              type="text"
                              value={displayDept}
                              onChange={(e) => handleFieldChange(u.id, "department", e.target.value)}
                              placeholder="—"
                              disabled={saving[u.id]}
                              aria-label={`Department for ${u.email}`}
                            />
                          </td>
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
                          <td className="mono" style={{ fontSize: 12 }}>
                            {fmt(u.createdAt)}
                          </td>
                          <td>
                            {isMe ? (
                              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                                Cannot edit own account
                              </span>
                            ) : (
                              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                <button
                                  className="admin-save-btn"
                                  onClick={() => handleSave(u.id)}
                                  disabled={!isDirty || saving[u.id]}
                                >
                                  {saving[u.id] ? "Saving…" : "Save"}
                                </button>
                                {msg && (
                                  <span className={`admin-save-msg ${msg === "Saved" ? "admin-save-msg--ok" : "admin-save-msg--err"}`}>
                                    {msg}
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
                >
                  ‹
                </button>
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
                      >
                        {item}
                      </button>
                    )
                  )}
                <button
                  className="admin-pagination-btn"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  aria-label="Next page"
                >
                  ›
                </button>
                <span style={{ marginLeft: 8, color: "var(--text-muted)" }}>
                  {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, filtered.length)} of {filtered.length}
                </span>
              </div>
            )}

            {/* Footer */}
            <div className="admin-panel-footer">
              <button className="admin-refresh-btn" onClick={handleSync} disabled={syncing}>
                {syncing ? "Syncing…" : "Sync Legacy Users"}
              </button>
              {syncMsg && <span className="admin-sync-msg">{syncMsg}</span>}
              <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-muted)" }}>
                Live · updates automatically
              </span>
            </div>
          </div>
        )}

        {/* ── Invite Users ─────────────────────── */}
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

        {/* ── Role Access Guide ────────────────── */}
        {activeTab === "access" && (
          <div style={{ padding: "16px" }}>
            <p className="admin-section-desc" style={{ marginBottom: 16 }}>
              This table shows which sections of the platform each role can access.
              Administrators can update roles at any time in the Active Users tab.
            </p>
            <AccessMatrix />
          </div>
        )}
      </section>
    </div>
  );
}

export default AdminPanel;
