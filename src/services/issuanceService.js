import { db } from "../firebase";
import {
  collection, addDoc, getDocs, getDoc, query,
  orderBy, serverTimestamp, where, doc, setDoc,
} from "firebase/firestore";

const ISSUANCES_COL = "issuances";
const INVENTORY_COL = "inventoryItems";

// ─── Read ────────────────────────────────────────────────────
export async function getIssuances() {
  const snap = await getDocs(
    query(collection(db, ISSUANCES_COL), orderBy("issuedAt", "desc"))
  );
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// Returns { materialName: totalQtyIssued } across all issuance records.
export async function getIssuanceTotals() {
  const snap = await getDocs(collection(db, ISSUANCES_COL));
  const totals = {};
  snap.docs.forEach((d) => {
    const { materialName, qtyIssued } = d.data();
    if (materialName) {
      totals[materialName] = (totals[materialName] || 0) + (Number(qtyIssued) || 0);
    }
  });
  return totals;
}

// ─── Inventory Item Metadata ─────────────────────────────────
// Module-level Map cache — avoids repeated Firestore reads when the user
// switches between materials in the issuance modal.
const _itemCache = new Map();

export async function getOrCreateInventoryItem(materialName, defaults = {}) {
  const key = materialName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
  if (_itemCache.has(key)) return _itemCache.get(key);

  const docRef = doc(db, INVENTORY_COL, key);
  const snap   = await getDoc(docRef);
  if (snap.exists()) {
    const item = { id: snap.id, ...snap.data() };
    _itemCache.set(key, item);
    return item;
  }

  const allSnap  = await getDocs(collection(db, INVENTORY_COL));
  const itemCode = `ITM-${String(allSnap.size + 1).padStart(4, "0")}`;
  const payload  = {
    materialName,
    itemCode,
    category:          defaults.category          || "",
    unit:              defaults.unit              || "",
    warehouseLocation: defaults.warehouseLocation || "Main Store",
    createdAt:         serverTimestamp(),
    updatedAt:         serverTimestamp(),
  };
  await setDoc(docRef, payload);
  const item = { id: key, ...payload };
  _itemCache.set(key, item);
  return item;
}

// ─── Issue Reference Number ──────────────────────────────────
// Produces a daily-sequential ref: ISS-YYYYMMDD-0001
export async function generateIssueRef() {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const prefix  = `ISS-${dateStr}-`;
  // Query issuances whose ref starts with today's prefix to find the next sequence number.
  const snap = await getDocs(
    query(
      collection(db, ISSUANCES_COL),
      where("issueRefNumber", ">=", prefix),
      where("issueRefNumber", "<=", prefix + "9999"),
    )
  );
  return `${prefix}${String(snap.size + 1).padStart(4, "0")}`;
}

// ─── Write ───────────────────────────────────────────────────
export async function addIssuance(data) {
  return addDoc(collection(db, ISSUANCES_COL), {
    ...data,
    issuedAt: serverTimestamp(),
  });
}
