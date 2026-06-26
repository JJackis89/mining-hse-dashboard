import { db } from "../firebase";
import {
  collection, addDoc, getDocs, getDoc, query,
  orderBy, serverTimestamp, where, doc, setDoc, updateDoc, deleteDoc,
} from "firebase/firestore";
import { logAction } from "./auditService";

const RECEIPTS_COL    = "receipts";
const ISSUANCES_COL   = "issuances";
const INVENTORY_COL   = "inventoryItems";
const ADJUSTMENTS_COL = "inventoryAdjustments";
const APP_SETTINGS    = "appSettings";

// ─── App / Inventory Settings ────────────────────────────────
export async function getInventorySettings() {
  const snap = await getDoc(doc(db, APP_SETTINGS, "inventory"));
  return snap.exists()
    ? snap.data()
    : { issuanceApprovalThreshold: 50, lowStockDefault: 10 };
}

export async function saveInventorySettings(settings, by = null) {
  await setDoc(doc(db, APP_SETTINGS, "inventory"), settings, { merge: true });
  logAction({
    action: "settings.inventory", module: "settings",
    performedBy: by?.email, performedByUid: by?.uid,
    target: "Inventory Settings",
    details: settings,
  });
}

// ─── Receipts ────────────────────────────────────────────────
export async function getReceipts() {
  const snap = await getDocs(
    query(collection(db, RECEIPTS_COL), orderBy("createdAt", "desc"))
  );
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function addReceipt(data) {
  const ref = await addDoc(collection(db, RECEIPTS_COL), {
    ...data,
    createdAt: serverTimestamp(),
  });
  logAction({
    action: "receipt.add", module: "inventory",
    performedBy: data.addedByEmail, performedByUid: null,
    target: data.material_name,
    details: {
      qty:      data.quantity_received,
      unit:     data.unit,
      supplier: data.supplier || null,
      poRef:    data.po_reference || null,
      category: data.category || null,
    },
  });
  return ref;
}

export async function updateReceipt(docId, data, by = null) {
  await updateDoc(doc(db, RECEIPTS_COL, docId), {
    ...data,
    updatedAt: serverTimestamp(),
  });
  logAction({
    action: "receipt.edit", module: "inventory",
    performedBy: by?.email, performedByUid: by?.uid,
    target: data.material_name,
    details: {
      qty:      data.quantity_received,
      unit:     data.unit,
      supplier: data.supplier || null,
      poRef:    data.po_reference || null,
    },
  });
}

export async function deleteReceipt(docId, materialName = null, by = null) {
  await deleteDoc(doc(db, RECEIPTS_COL, docId));
  logAction({
    action: "receipt.delete", module: "inventory",
    performedBy: by?.email, performedByUid: by?.uid,
    target: materialName,
    details: { docId },
  });
}

// ─── One-time migration: manualReceipts → receipts ───────────
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

// ─── Issuances ───────────────────────────────────────────────
export async function getIssuances() {
  const snap = await getDocs(
    query(collection(db, ISSUANCES_COL), orderBy("issuedAt", "desc"))
  );
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function getPendingIssuances() {
  const snap = await getDocs(
    query(
      collection(db, ISSUANCES_COL),
      where("approvalStatus", "==", "pending"),
      orderBy("issuedAt", "desc")
    )
  );
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// Only count approved/auto-approved issuances toward stock balance.
// Legacy issuances (no approvalStatus) are treated as approved.
export async function getIssuanceTotals() {
  const snap = await getDocs(collection(db, ISSUANCES_COL));
  const totals = {};
  snap.docs.forEach((d) => {
    const { materialName, qtyIssued, approvalStatus } = d.data();
    if (approvalStatus === "pending" || approvalStatus === "rejected") return;
    if (materialName) {
      totals[materialName] = (totals[materialName] || 0) + (Number(qtyIssued) || 0);
    }
  });
  return totals;
}

export async function addIssuance(data) {
  const ref = await addDoc(collection(db, ISSUANCES_COL), {
    ...data,
    issuedAt: serverTimestamp(),
  });
  logAction({
    action: "issuance.create", module: "inventory",
    performedBy: data.issuedByEmail, performedByUid: null,
    target: data.materialName,
    details: {
      ref:           data.issueRefNumber,
      qty:           data.qtyIssued,
      unit:          data.unit,
      issuedTo:      data.issuedTo,
      department:    data.department,
      projectCode:   data.projectCode || null,
      approvalStatus: data.approvalStatus,
    },
  });
  return ref;
}

export async function approveIssuance(docId, by) {
  await updateDoc(doc(db, ISSUANCES_COL, docId), {
    approvalStatus: "approved",
    approvedBy:     by.email,
    approvedAt:     serverTimestamp(),
  });
  logAction({
    action: "issuance.approve", module: "inventory",
    performedBy: by.email, performedByUid: by.uid,
    target: docId,
    details: { issuanceId: docId },
  });
}

export async function rejectIssuance(docId, by) {
  await updateDoc(doc(db, ISSUANCES_COL, docId), {
    approvalStatus: "rejected",
    rejectedBy:     by.email,
    rejectedAt:     serverTimestamp(),
  });
  logAction({
    action: "issuance.reject", module: "inventory",
    performedBy: by.email, performedByUid: by.uid,
    target: docId,
    details: { issuanceId: docId },
  });
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
    reorderPoint:      defaults.reorderPoint      ?? 10,
    leadTimeDays:      defaults.leadTimeDays       ?? 7,
    itemType:          defaults.itemType          || "Consumable",
    createdAt:         serverTimestamp(),
    updatedAt:         serverTimestamp(),
  };
  await setDoc(docRef, payload);
  const item = { id: key, ...payload };
  _itemCache.set(key, item);
  return item;
}

export async function updateInventoryItem(key, data, by = null) {
  _itemCache.delete(key);
  await updateDoc(doc(db, INVENTORY_COL, key), {
    ...data,
    updatedAt: serverTimestamp(),
  });
  if (by && data.reorderPoint !== undefined) {
    logAction({
      action: "adjustment.create", module: "inventory",
      performedBy: by.email, performedByUid: by.uid,
      target: key,
      details: { field: "reorderPoint", newValue: data.reorderPoint },
    });
  }
}

export async function getAllInventoryItems() {
  const snap = await getDocs(collection(db, INVENTORY_COL));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
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

// ─── Inventory Adjustments ───────────────────────────────────
export async function getAdjustments() {
  const snap = await getDocs(
    query(collection(db, ADJUSTMENTS_COL), orderBy("createdAt", "desc"))
  );
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function addAdjustment(data) {
  const ref = await addDoc(collection(db, ADJUSTMENTS_COL), {
    ...data,
    createdAt: serverTimestamp(),
  });
  logAction({
    action: "adjustment.create", module: "inventory",
    performedBy: data.adjustedByEmail, performedByUid: null,
    target: data.materialName,
    details: {
      type:     data.adjustmentType,
      qty:      data.quantity,
      unit:     data.unit,
      reason:   data.reason || null,
    },
  });
  return ref;
}
