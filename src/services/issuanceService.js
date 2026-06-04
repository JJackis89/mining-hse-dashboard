import { db } from "../firebase";
import {
  collection,
  addDoc,
  query,
  orderBy,
  getDocs,
  serverTimestamp,
} from "firebase/firestore";

const COL = "issuances";

export async function addIssuance(data) {
  return addDoc(collection(db, COL), {
    ...data,
    issuedAt: serverTimestamp(),
  });
}

export async function getIssuances() {
  const q = query(collection(db, COL), orderBy("issuedAt", "desc"));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}
