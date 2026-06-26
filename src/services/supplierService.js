import { db } from "../firebase";
import {
  collection, addDoc, getDocs, getDoc, query,
  orderBy, serverTimestamp, doc, updateDoc, deleteDoc,
} from "firebase/firestore";

const SUPPLIERS_COL = "suppliers";

export async function getSuppliers() {
  const snap = await getDocs(
    query(collection(db, SUPPLIERS_COL), orderBy("name", "asc"))
  );
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function getSupplier(id) {
  const snap = await getDoc(doc(db, SUPPLIERS_COL, id));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function addSupplier(data, addedByEmail) {
  return addDoc(collection(db, SUPPLIERS_COL), {
    ...data,
    createdBy: addedByEmail,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

export async function updateSupplier(id, data) {
  await updateDoc(doc(db, SUPPLIERS_COL, id), {
    ...data,
    updatedAt: serverTimestamp(),
  });
}

export async function deleteSupplier(id) {
  await deleteDoc(doc(db, SUPPLIERS_COL, id));
}
