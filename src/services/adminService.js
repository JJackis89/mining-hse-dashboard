import { db } from "../firebase";
import {
  collection,
  getDocs,
  setDoc,
  deleteDoc,
  doc,
  serverTimestamp,
} from "firebase/firestore";

export async function getAllUserRoles() {
  const snap = await getDocs(collection(db, "userRoles"));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function updateUserRole(uid, role) {
  await setDoc(doc(db, "userRoles", uid), { role }, { merge: true });
}

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
