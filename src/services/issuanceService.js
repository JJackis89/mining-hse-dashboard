import { db } from "../firebase";
import {
  collection, addDoc, getDocs, getDoc, query,
  orderBy, serverTimestamp, where, doc, setDoc, updateDoc, deleteDoc,
} from "firebase/firestore";

const RECEIPTS_COL   = "receipts";
const ISSUANCES_COL  = "issuances";
const INVENTORY_COL  = "inventoryItems";
const ADJUSTMENTS_COL = "inventoryAdjustments";

// ─── Receipts ────────────────────────────────────────────────
export async function getReceipts() {
  const snap = await getDocs(
    query(collection(db, RECEIPTS_COL), orderBy("createdAt", "desc"))
  );
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function addReceipt(data) {
  return addDoc(collection(db, RECEIPTS_COL), {
    ...data,
    createdAt: serverTimestamp(),
  });
}

export async function updateReceipt(docId, data) {
  await updateDoc(doc(db, RECEIPTS_COL, docId), {
    ...data,
    updatedAt: serverTimestamp(),
  });
}

export async function deleteReceipt(docId) {
  await deleteDoc(doc(db, RECEIPTS_COL, docId));
}

// ─── Issuances ───────────────────────────────────────────────
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
export async function generateIssueRef() {
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const prefix  = `ISS-${dateStr}-`;
  const snap = await getDocs(
    query(
      collection(db, ISSUANCES_COL),
      where("issueRefNumber", ">=", prefix),
      where("issueRefNumber", "<=", prefix + "9999"),
    )
  );
  return `${prefix}${String(snap.size + 1).padStart(4, "0")}`;
}

export async function addIssuance(data) {
  return addDoc(collection(db, ISSUANCES_COL), {
    ...data,
    issuedAt: serverTimestamp(),
  });
}

// ─── One-time migration: manualReceipts → receipts ───────────
// Copies every document from the legacy manualReceipts collection into
// the new receipts collection, stripping ArcGIS-specific fields.
// Safe to run repeatedly — skips docs that already exist in receipts.
export async function migrateManualReceipts() {
  const oldSnap = await getDocs(collection(db, "manualReceipts"));
  if (oldSnap.empty) return 0;

  const existingSnap = await getDocs(collection(db, RECEIPTS_COL));
  const existingIds  = new Set(existingSnap.docs.map((d) => d.id));

  let count = 0;
  for (const oldDoc of oldSnap.docs) {
    if (existingIds.has(oldDoc.id)) continue;
    // eslint-disable-next-line no-unused-vars
    const { arcgisObjectId, syncStatus, source, ...clean } = oldDoc.data();
    await setDoc(doc(db, RECEIPTS_COL, oldDoc.id), clean);
    count++;
  }
  return count;
}

// ─── Inventory Adjustments ───────────────────────────────────
export async function getAdjustments() {
  const snap = await getDocs(
    query(collection(db, ADJUSTMENTS_COL), orderBy("createdAt", "desc"))
  );
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function addAdjustment(data) {
  return addDoc(collection(db, ADJUSTMENTS_COL), {
    ...data,
    createdAt: serverTimestamp(),
  });
}
