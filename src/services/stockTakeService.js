import { db } from "../firebase";
import {
  collection, addDoc, getDocs, getDoc, query,
  orderBy, serverTimestamp, doc, updateDoc,
} from "firebase/firestore";

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

export async function createStockTake(data, conductedByEmail) {
  return addDoc(collection(db, STOCK_TAKES_COL), {
    ...data,
    conductedBy: conductedByEmail,
    status:      "in-progress",
    createdAt:   serverTimestamp(),
  });
}

export async function updateStockTakeItems(id, items) {
  await updateDoc(doc(db, STOCK_TAKES_COL, id), {
    items,
    updatedAt: serverTimestamp(),
  });
}

export async function completeStockTake(id) {
  await updateDoc(doc(db, STOCK_TAKES_COL, id), {
    status:      "completed",
    completedAt: serverTimestamp(),
  });
}
