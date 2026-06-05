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
export async function updateUserRole(uid, role) {
  await setDoc(doc(db, "userRoles", uid), { role }, { merge: true });
}

/** Merge profile fields (department, rank, accountStatus, etc.) into userRoles. */
export async function updateUserProfile(uid, data) {
  await setDoc(doc(db, "userRoles", uid), data, { merge: true });
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
