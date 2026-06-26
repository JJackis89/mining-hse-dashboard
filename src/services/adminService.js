import { db } from "../firebase";
import {
  collection,
  getDocs,
  setDoc,
  deleteDoc,
  doc,
  serverTimestamp,
  onSnapshot,
  writeBatch,
} from "firebase/firestore";
import { logAction } from "./auditService";

// ── Diagnostics ───────────────────────────────────────────────

/**
 * Creates then immediately deletes a test document in _diagnostics/{uid}.
 * Returns { ok, ms } on success or { ok: false, error, message } on failure.
 * Used by the Admin Panel to verify Firestore write access and surface
 * security-rule blocks that would prevent new user profiles from being written.
 */
export async function testFirestoreWrite(uid) {
  const testRef = doc(db, "_diagnostics", uid);
  const t0 = Date.now();
  try {
    await setDoc(testRef, { uid, testedAt: serverTimestamp() });
    await deleteDoc(testRef);
    return { ok: true, ms: Date.now() - t0 };
  } catch (err) {
    return { ok: false, error: err.code, message: err.message };
  }
}

// ── helpers ───────────────────────────────────────────────────
function tsMs(val) {
  if (!val) return 0;
  if (typeof val.toMillis === "function") return val.toMillis();
  if (typeof val === "number") return val;
  return 0;
}

// ── userRoles (single source of truth for users + roles) ──────

/**
 * Subscribe to all user profiles in real time.
 *
 * IMPORTANT: the query intentionally has NO orderBy clause.
 * Firestore orderBy silently excludes documents that are missing
 * the ordered field — any user whose createdAt write failed would
 * never appear.  We fetch the whole collection and sort client-side
 * so every document is always visible.
 *
 * Returns the unsubscribe function.
 */
export function subscribeToUsers(onData, onError) {
  return onSnapshot(
    collection(db, "userRoles"),
    (snap) => {
      const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      rows.sort((a, b) => tsMs(b.createdAt) - tsMs(a.createdAt));
      onData(rows);
    },
    onError
  );
}

/** Update role in userRoles. */
export async function updateUserRole(uid, role, by = null, targetUser = null) {
  await setDoc(doc(db, "userRoles", uid), { role }, { merge: true });
  logAction({
    action: "user.roleChange", module: "admin",
    performedBy: by?.email, performedByUid: by?.uid,
    target: targetUser?.email || uid,
    details: { newRole: role, targetUid: uid },
  });
}

/** Merge profile fields (department, rank, accountStatus, etc.) into userRoles. */
export async function updateUserProfile(uid, data, by = null, targetUser = null) {
  await setDoc(doc(db, "userRoles", uid), data, { merge: true });
  logAction({
    action: "user.profileUpdate", module: "admin",
    performedBy: by?.email, performedByUid: by?.uid,
    target: targetUser?.email || uid,
    details: { fields: Object.keys(data), targetUid: uid },
  });
}

// ── User lifecycle (status transitions + profile removal) ─────
//
// All status writes are merge-only field updates — the Firestore rules are
// the actual enforcement boundary (only an admin's session can change role
// or accountStatus on someone else's document; see firestore.rules). The
// live watchOwnProfile() subscription in App.jsx pushes every change here
// to the affected session immediately, which is what makes "permission
// changes take effect immediately" / "force session refresh" true without
// a logout — the account-status gate screen appears the instant the write
// lands, and the user signs themselves out from there.

/** Approve a pending registration: assign its role and activate the account. */
export async function approveUser(uid, role = "viewer", by = null, targetUser = null) {
  await setDoc(doc(db, "userRoles", uid), { role, accountStatus: "Active" }, { merge: true });
  logAction({
    action: "user.approve", module: "admin",
    performedBy: by?.email, performedByUid: by?.uid,
    target: targetUser?.email || uid,
    details: { role, targetUid: uid },
  });
}

/** Temporarily block sign-in (e.g. while investigating) without losing the profile or role. */
export async function suspendUser(uid, by = null, targetUser = null) {
  await setDoc(doc(db, "userRoles", uid), { accountStatus: "Suspended" }, { merge: true });
  logAction({
    action: "user.suspend", module: "admin",
    performedBy: by?.email, performedByUid: by?.uid,
    target: targetUser?.email || uid,
    details: { targetUid: uid },
  });
}

/** Longer-term block — keeps the record for audit but treats the account as retired. */
export async function deactivateUser(uid, by = null, targetUser = null) {
  await setDoc(doc(db, "userRoles", uid), { accountStatus: "Deactivated" }, { merge: true });
  logAction({
    action: "user.deactivate", module: "admin",
    performedBy: by?.email, performedByUid: by?.uid,
    target: targetUser?.email || uid,
    details: { targetUid: uid },
  });
}

/** Restore a Suspended or Deactivated account to Active. */
export async function reactivateUser(uid, by = null, targetUser = null) {
  await setDoc(doc(db, "userRoles", uid), { accountStatus: "Active" }, { merge: true });
  logAction({
    action: "user.reactivate", module: "admin",
    performedBy: by?.email, performedByUid: by?.uid,
    target: targetUser?.email || uid,
    details: { targetUid: uid },
  });
}

export async function deleteUserProfile(uid, by = null, targetUser = null) {
  await deleteDoc(doc(db, "userRoles", uid));
  logAction({
    action: "user.delete", module: "admin",
    performedBy: by?.email, performedByUid: by?.uid,
    target: targetUser?.email || uid,
    details: { targetUid: uid },
  });
}

// ── Pending invites ───────────────────────────────────────────

export async function getPendingInvites() {
  const snap = await getDocs(collection(db, "pendingRoles"));
  return snap.docs.map((d) => ({ id: d.id, email: d.id, ...d.data() }));
}

export async function createPendingInvite(email, role) {
  await setDoc(doc(db, "pendingRoles", email), {
    role,
    invitedAt: serverTimestamp(),
  });
}

export async function revokePendingInvite(email) {
  await deleteDoc(doc(db, "pendingRoles", email));
}

// ── Migration: backfill missing profile fields ────────────────

/**
 * For every userRoles document missing any canonical field,
 * write the defaults so they appear in the Admin Panel and
 * are ordered correctly by the client-side sort.
 * Returns the number of documents updated.
 */
export async function syncLegacyUsers() {
  const snap = await getDocs(collection(db, "userRoles"));
  const batch = writeBatch(db);
  let count = 0;

  for (const d of snap.docs) {
    const data = d.data();
    const has  = (f) => Object.prototype.hasOwnProperty.call(data, f);
    const patch = {
      ...(!has("uid")            && { uid: d.id }),
      ...(!has("fullName")       && { fullName: "" }),
      ...(!has("department")     && { department: "" }),
      ...(!has("rank")           && { rank: "" }),
      ...(!has("accountStatus")  && { accountStatus: "Active" }),
      ...(!has("createdAt")      && { createdAt: serverTimestamp() }),
    };
    if (Object.keys(patch).length > 0) {
      batch.set(doc(db, "userRoles", d.id), patch, { merge: true });
      count++;
    }
  }

  if (count > 0) await batch.commit();
  return count;
}

// kept for any external callers
export async function getAllUserRoles() {
  const snap = await getDocs(collection(db, "userRoles"));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// ── Failed Registrations ──────────────────────────────────────

/**
 * Real-time subscription to accounts that failed to sync during registration.
 * Written by the client when all userRoles write retries are exhausted.
 * Returns the unsubscribe function.
 */
export function subscribeToFailedRegistrations(onData, onError) {
  return onSnapshot(collection(db, "failedRegistrations"), (snap) => {
    onData(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  }, onError);
}

/**
 * Admin-side recovery: creates the userRoles document for a failed registration
 * using the admin's write credentials, then removes the failedRegistrations entry.
 */
export async function approveFailedRegistration(entry, roleOverride = "viewer") {
  const { id: uid, failedAt: _fa, failReason: _fr, ...profile } = entry;
  await setDoc(doc(db, "userRoles", uid), {
    ...profile,
    role:          roleOverride,
    accountStatus: profile.accountStatus || "Active",
    createdAt:     serverTimestamp(),
    lastLogin:     serverTimestamp(),
  });
  await deleteDoc(doc(db, "failedRegistrations", uid));
}
