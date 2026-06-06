import { db } from "../firebase";
import {
  collection, addDoc, getDocs, doc, updateDoc,
  query, where, serverTimestamp,
} from "firebase/firestore";

const ACT_COL  = "droneActivities";
const LOGS_COL = "droneActivityLogs";

// Auto-generate a human-readable ID: ACT-YYYYMMDD-NNNN
async function genActivityId() {
  const snap = await getDocs(collection(db, ACT_COL));
  const n    = snap.size + 1;
  const d    = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  return `ACT-${d}-${String(n).padStart(4, "0")}`;
}

async function writeLog(activityId, action, user, changes, snapshot) {
  await addDoc(collection(db, LOGS_COL), {
    activityId,
    action,
    performedBy:    user.email,
    performedByUid: user.uid,
    performedAt:    serverTimestamp(),
    changes:  changes  ?? null,
    snapshot: snapshot ?? null,
  });
}

// Returns { fieldName: { from, to } } for changed fields, or null.
function diff(before, after) {
  const skip = new Set([
    "createdAt", "updatedAt", "updatedBy", "updatedByUid",
    "deletedAt", "deletedBy", "deletedByUid",
  ]);
  const out = {};
  new Set([...Object.keys(before), ...Object.keys(after)]).forEach((k) => {
    if (skip.has(k)) return;
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
      out[k] = { from: before[k] ?? null, to: after[k] ?? null };
    }
  });
  return Object.keys(out).length ? out : null;
}

// ── Read ──────────────────────────────────────────────────────────
export async function getActivities() {
  const snap = await getDocs(collection(db, ACT_COL));
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0));
}

export async function getActivityLogs(activityId) {
  const snap = await getDocs(
    query(collection(db, LOGS_COL), where("activityId", "==", activityId))
  );
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (b.performedAt?.toMillis?.() ?? 0) - (a.performedAt?.toMillis?.() ?? 0));
}

// ── Write ─────────────────────────────────────────────────────────
export async function createActivity(data, user) {
  const activityId = await genActivityId();
  const payload = {
    ...data,
    activityId,
    isDeleted:    false,
    deletedAt:    null,
    deletedBy:    null,
    deletedByUid: null,
    createdAt:    serverTimestamp(),
    createdBy:    user.email,
    createdByUid: user.uid,
    updatedAt:    serverTimestamp(),
    updatedBy:    user.email,
    updatedByUid: user.uid,
  };
  const ref = await addDoc(collection(db, ACT_COL), payload);
  await writeLog(ref.id, "created", user, null, { id: ref.id, ...payload });
  return { id: ref.id, ...payload };
}

export async function updateActivity(id, before, data, user) {
  const updates = {
    ...data,
    updatedAt:    serverTimestamp(),
    updatedBy:    user.email,
    updatedByUid: user.uid,
  };
  await updateDoc(doc(db, ACT_COL, id), updates);
  await writeLog(id, "updated", user, diff(before, data), { ...before, ...data });
}

export async function softDeleteActivity(id, snapshot, user) {
  await updateDoc(doc(db, ACT_COL, id), {
    isDeleted:    true,
    deletedAt:    serverTimestamp(),
    deletedBy:    user.email,
    deletedByUid: user.uid,
    updatedAt:    serverTimestamp(),
    updatedBy:    user.email,
    updatedByUid: user.uid,
  });
  await writeLog(id, "deleted", user, null, snapshot);
}

export async function restoreActivity(id, snapshot, user) {
  await updateDoc(doc(db, ACT_COL, id), {
    isDeleted:    false,
    deletedAt:    null,
    deletedBy:    null,
    deletedByUid: null,
    updatedAt:    serverTimestamp(),
    updatedBy:    user.email,
    updatedByUid: user.uid,
  });
  await writeLog(id, "restored", user, null, snapshot);
}
