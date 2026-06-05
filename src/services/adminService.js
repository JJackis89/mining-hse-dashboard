import { db } from "../firebase";
import {
  collection,
  getDocs,
  setDoc,
  deleteDoc,
  doc,
  serverTimestamp,
  onSnapshot,
  query,
  orderBy,
  writeBatch,
} from "firebase/firestore";

// ── userRoles (single source of truth for users + roles) ──────

/** Subscribe to all user profiles in real time. Returns unsubscribe fn. */
export function subscribeToUsers(onData, onError) {
  const q = query(collection(db, "userRoles"), orderBy("createdAt", "desc"));
  return onSnapshot(
    q,
    (snap) => onData(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
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
 * For existing userRoles docs that pre-date the profile fields,
 * add default values so they display correctly in the Admin Panel.
 * Returns count of records updated.
 */
export async function syncLegacyUsers() {
  const snap = await getDocs(collection(db, "userRoles"));
  const batch = writeBatch(db);
  let count = 0;

  for (const d of snap.docs) {
    const data = d.data();
    if (!Object.prototype.hasOwnProperty.call(data, "accountStatus")) {
      batch.set(doc(db, "userRoles", d.id), {
        uid: d.id,
        fullName: data.fullName || "",
        department: data.department || "",
        rank: data.rank || "",
        accountStatus: "Active",
        lastLogin: data.lastLogin ?? null,
      }, { merge: true });
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
