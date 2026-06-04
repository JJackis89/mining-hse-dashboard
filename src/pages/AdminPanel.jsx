import { useEffect, useState, useCallback } from "react";
import { useUser } from "../context/UserContext";
import {
  getAllUserRoles,
  updateUserRole,
  getPendingInvites,
  createPendingInvite,
  revokePendingInvite,
} from "../services/adminService";
import { ROLES, ROLE_LABELS, ROUTE_ACCESS, NAV_ITEMS } from "../utils/permissions";

function fmt(ts) {
  if (!ts) return "—";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
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
            {pages.map((p) => (
              <th key={p.path} scope="col">{p.label}</th>
            ))}
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

  // Users state
  const [users, setUsers]               = useState([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [usersError, setUsersError]     = useState(null);
  const [pendingChanges, setPendingChanges] = useState({});
  const [saving, setSaving]             = useState({});
  const [saveMsg, setSaveMsg]           = useState({});

  // Invites state
  const [invites, setInvites]               = useState([]);
  const [invitesLoading, setInvitesLoading] = useState(true);
  const [invitesError, setInvitesError]     = useState(null);
  const [inviteEmail, setInviteEmail]       = useState("");
  const [inviteRole, setInviteRole]         = useState("viewer");
  const [inviting, setInviting]             = useState(false);
  const [inviteMsg, setInviteMsg]           = useState("");
  const [revoking, setRevoking]             = useState({});

  const loadUsers = useCallback(async () => {
    setUsersLoading(true);
    setUsersError(null);
    try {
      setUsers(await getAllUserRoles());
    } catch (err) {
      setUsersError(err.message);
    } finally {
      setUsersLoading(false);
    }
  }, []);

  const loadInvites = useCallback(async () => {
    setInvitesLoading(true);
    setInvitesError(null);
    try {
      setInvites(await getPendingInvites());
    } catch (err) {
      setInvitesError(err.message);
    } finally {
      setInvitesLoading(false);
    }
  }, []);

  useEffect(() => { loadUsers(); }, [loadUsers]);
  useEffect(() => {
    if (activeTab === "invites") loadInvites();
  }, [activeTab, loadInvites]);

  const handleRoleChange = (uid, newRole) => {
    setPendingChanges((p) => ({ ...p, [uid]: newRole }));
  };

  const handleSaveRole = async (uid) => {
    const newRole = pendingChanges[uid];
    if (!newRole) return;
    setSaving((s) => ({ ...s, [uid]: true }));
    try {
      await updateUserRole(uid, newRole);
      setUsers((u) => u.map((usr) => usr.id === uid ? { ...usr, role: newRole } : usr));
      setPendingChanges((p) => { const n = { ...p }; delete n[uid]; return n; });
      setSaveMsg((m) => ({ ...m, [uid]: "Saved" }));
      setTimeout(() => setSaveMsg((m) => { const n = { ...m }; delete n[uid]; return n; }), 2000);
    } catch {
      setSaveMsg((m) => ({ ...m, [uid]: "Error" }));
    } finally {
      setSaving((s) => { const n = { ...s }; delete n[uid]; return n; });
    }
  };

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
    } catch {
      // ignore
    } finally {
      setRevoking((r) => { const n = { ...r }; delete n[email]; return n; });
    }
  };

  return (
    <div className="page-admin">
      {/* ── KPI row ─────────────────────────────── */}
      <section className="kpi-grid" style={{ marginBottom: 20 }} aria-label="Admin summary">
        <div className="kpi-card">
          <div className="kpi-icon" style={{ background: "rgba(125,60,152,0.1)", color: "var(--purple)" }} aria-hidden="true" />
          <div className="kpi-data">
            <span className="kpi-value">{users.length}</span>
            <span className="kpi-title">Registered Users</span>
            <span className="kpi-trend">With assigned roles</span>
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
            { id: "users",  label: "Active Users" },
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
            {usersLoading && (
              <div className="loading-state" style={{ minHeight: 160 }}>
                <div className="spinner" /><p>Loading users…</p>
              </div>
            )}
            {!usersLoading && usersError && (
              <div className="error-state" style={{ minHeight: 120 }}>
                <span className="error-icon">!</span>
                <p>Failed to load users</p>
                <p className="error-detail">{usersError}</p>
              </div>
            )}
            {!usersLoading && !usersError && users.length === 0 && (
              <div className="empty-state" style={{ padding: "40px 20px" }}>
                <p>No registered users yet.</p>
              </div>
            )}
            {!usersLoading && !usersError && users.length > 0 && (
              <div className="table-scroll">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th scope="col">Email</th>
                      <th scope="col">Current Role</th>
                      <th scope="col">Member Since</th>
                      <th scope="col">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((u) => {
                      const isMe = u.id === user?.uid;
                      const displayRole = pendingChanges[u.id] ?? u.role ?? "viewer";
                      const isDirty = pendingChanges[u.id] !== undefined;
                      const msg = saveMsg[u.id];
                      return (
                        <tr key={u.id} className={isMe ? "row--selected" : ""}>
                          <td className="bold">
                            {u.email || "—"}
                            {isMe && <span className="admin-you-badge">You</span>}
                          </td>
                          <td>
                            <select
                              className="admin-role-select"
                              value={displayRole}
                              onChange={(e) => handleRoleChange(u.id, e.target.value)}
                              disabled={isMe || saving[u.id]}
                              aria-label={`Role for ${u.email}`}
                            >
                              {ROLES.map((r) => (
                                <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                              ))}
                            </select>
                          </td>
                          <td className="mono" style={{ fontSize: 12 }}>
                            {fmt(u.createdAt)}
                          </td>
                          <td>
                            {isMe ? (
                              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Cannot change own role</span>
                            ) : (
                              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                <button
                                  className="admin-save-btn"
                                  onClick={() => handleSaveRole(u.id)}
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
            <div style={{ padding: "10px 16px", borderTop: "1px solid var(--border-color)" }}>
              <button className="admin-refresh-btn" onClick={loadUsers} disabled={usersLoading}>
                ↻ Refresh
              </button>
            </div>
          </div>
        )}

        {/* ── Invite Users ─────────────────────── */}
        {activeTab === "invites" && (
          <div>
            {/* Invite form */}
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

            {/* Pending invites list */}
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
