import { db } from "../firebase";
import {
  collection, addDoc, getDocs, getDoc, query,
  orderBy, serverTimestamp, doc, updateDoc,
} from "firebase/firestore";
import { logAction } from "./auditService";

const STOCK_TAKES_COL = "stockTakes";

export async function getStockTakes() {
  const snap = await getDocs(
    query(collection(db, STOCK_TAKES_COL), orderBy("createdAt", "desc"))
  );
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function getStockTake(id) {
  const snap = await getDoc(doc(db, STOCK_TAKES_COL, id));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function createStockTake(data, by) {
  const ref = await addDoc(collection(db, STOCK_TAKES_COL), {
    ...data,
    conductedBy: by?.email || null,
    status:      "in-progress",
    createdAt:   serverTimestamp(),
  });
  logAction({
    action: "stocktake.create", module: "stocktake",
    performedBy: by?.email, performedByUid: by?.uid,
    target: data.date || "New stock take",
    details: { notes: data.notes || null },
  });
  return ref;
}

export async function updateStockTakeItems(id, items, by = null) {
  await updateDoc(doc(db, STOCK_TAKES_COL, id), {
    items,
    updatedAt: serverTimestamp(),
  });
  logAction({
    action: "stocktake.update", module: "stocktake",
    performedBy: by?.email, performedByUid: by?.uid,
    target: id,
    details: { itemCount: items.length },
  });
}

export async function completeStockTake(id, by = null) {
  await updateDoc(doc(db, STOCK_TAKES_COL, id), {
    status:      "completed",
    completedAt: serverTimestamp(),
  });
  logAction({
    action: "stocktake.complete", module: "stocktake",
    performedBy: by?.email, performedByUid: by?.uid,
    target: id,
    details: null,
  });
}
