import { db } from "../firebase";
import {
  collection, addDoc, getDocs, getDoc, query,
  orderBy, serverTimestamp, doc, updateDoc, deleteDoc,
} from "firebase/firestore";
import { logAction } from "./auditService";

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

export async function addSupplier(data, by) {
  const ref = await addDoc(collection(db, SUPPLIERS_COL), {
    ...data,
    createdBy: by?.email || null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
  logAction({
    action: "supplier.add", module: "suppliers",
    performedBy: by?.email, performedByUid: by?.uid,
    target: data.name,
    details: { phone: data.phone || null, email: data.email || null },
  });
  return ref;
}

export async function updateSupplier(id, data, by = null) {
  await updateDoc(doc(db, SUPPLIERS_COL, id), {
    ...data,
    updatedAt: serverTimestamp(),
  });
  logAction({
    action: "supplier.edit", module: "suppliers",
    performedBy: by?.email, performedByUid: by?.uid,
    target: data.name,
    details: { supplierId: id },
  });
}

export async function deleteSupplier(id, name = null, by = null) {
  await deleteDoc(doc(db, SUPPLIERS_COL, id));
  logAction({
    action: "supplier.delete", module: "suppliers",
    performedBy: by?.email, performedByUid: by?.uid,
    target: name,
    details: { supplierId: id },
  });
}
