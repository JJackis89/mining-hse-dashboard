import { db } from "../firebase";
import {
  collection, addDoc, getDocs, getDoc, query,
  orderBy, serverTimestamp, where, doc, setDoc, updateDoc, deleteDoc,
} from "firebase/firestore";
import {
  addReceiptToArcGIS, updateReceiptInArcGIS, deleteReceiptFromArcGIS,
  invalidateMaterialsCache,
} from "./arcgisService";

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

// ─── Manual Receipts ─────────────────────────────────────────
const MANUAL_RECEIPTS_COL = "manualReceipts";

export async function getManualReceipts() {
  const snap = await getDocs(
    query(collection(db, MANUAL_RECEIPTS_COL), orderBy("createdAt", "desc"))
  );
  // Only return records that haven't synced yet — once synced, the record
  // lives in ArcGIS and comes back via getMaterials(), avoiding duplicates.
  return snap.docs
    .filter((d) => d.data().syncStatus !== "synced")
    .map((d) => ({
      objectid:    `manual_${d.id}`,
      firestoreId: d.id,
      source:      "manual",
      ...d.data(),
    }));
}

export async function addManualReceipt(data) {
  // Write to Firestore first — works offline, gives instant UI feedback.
  const docRef = await addDoc(collection(db, MANUAL_RECEIPTS_COL), {
    ...data,
    arcgisObjectId: null,
    syncStatus:     "pending",
    createdAt:      serverTimestamp(),
  });

  // Sync to ArcGIS (the primary source of truth for receipts).
  try {
    const objectId = await addReceiptToArcGIS(data);
    await updateDoc(docRef, { arcgisObjectId: objectId, syncStatus: "synced" });
    invalidateMaterialsCache();
  } catch {
    await updateDoc(docRef, { syncStatus: "failed" });
  }

  return docRef;
}

// Update a manual receipt in Firestore and attempt to push the change to ArcGIS.
// arcgisObjectId is null when the record was never synced (pending/failed).
export async function updateManualReceipt(firestoreDocId, data, arcgisObjectId) {
  const docRef = doc(db, MANUAL_RECEIPTS_COL, firestoreDocId);
  await updateDoc(docRef, {
    ...data,
    syncStatus: arcgisObjectId ? "pending" : "failed",
    updatedAt:  serverTimestamp(),
  });
  if (arcgisObjectId) {
    try {
      await updateReceiptInArcGIS(arcgisObjectId, data);
      await updateDoc(docRef, { syncStatus: "synced" });
      invalidateMaterialsCache();
    } catch {
      await updateDoc(docRef, { syncStatus: "failed" });
    }
  }
}

// Hard-delete from Firestore; attempt ArcGIS delete (requires auth — may fail).
// Returns { arcgisDeleted: bool } so the caller can warn the user if needed.
export async function deleteManualReceipt(firestoreDocId, arcgisObjectId) {
  let arcgisDeleted = false;
  if (arcgisObjectId) {
    try {
      await deleteReceiptFromArcGIS(arcgisObjectId);
      arcgisDeleted = true;
      invalidateMaterialsCache();
    } catch {
      // Auth-blocked — Firestore deletion still proceeds.
    }
  }
  await deleteDoc(doc(db, MANUAL_RECEIPTS_COL, firestoreDocId));
  return { arcgisDeleted };
}

// Returns ALL manual-receipt docs including synced — used by the Admin Sync Log.
export async function getAllManualReceipts() {
  const snap = await getDocs(
    query(collection(db, MANUAL_RECEIPTS_COL), orderBy("createdAt", "desc"))
  );
  return snap.docs.map((d) => ({ firestoreId: d.id, ...d.data() }));
}

// ─── Inventory Adjustments ───────────────────────────────────
const ADJUSTMENTS_COL = "inventoryAdjustments";

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

// Retry a previously failed ArcGIS sync for a Firestore manual-receipt doc.
export async function retrySyncReceipt(firestoreDocId, receiptData) {
  const docRef = doc(db, MANUAL_RECEIPTS_COL, firestoreDocId);
  await updateDoc(docRef, { syncStatus: "pending" });
  try {
    const objectId = await addReceiptToArcGIS(receiptData);
    await updateDoc(docRef, { arcgisObjectId: objectId, syncStatus: "synced" });
    invalidateMaterialsCache();
    return objectId;
  } catch (err) {
    await updateDoc(docRef, { syncStatus: "failed" });
    throw err;
  }
}
