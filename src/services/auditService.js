import { db } from "../firebase";
import {
  collection, addDoc, getDocs, query,
  orderBy, limit, startAfter, serverTimestamp, where,
} from "firebase/firestore";

const AUDIT_COL = "auditLog";

// Human-readable labels for every loggable action
export const ACTION_LABELS = {
  "receipt.add":             "Added receipt",
  "receipt.edit":            "Edited receipt",
  "receipt.delete":          "Deleted receipt",
  "issuance.create":         "Issued item",
  "issuance.approve":        "Approved issuance",
  "issuance.reject":         "Rejected issuance",
  "adjustment.create":       "Stock adjustment",
  "stocktake.create":        "Started stock take",
  "stocktake.update":        "Updated stock take counts",
  "stocktake.complete":      "Completed stock take",
  "stocktake.variances":     "Applied variances to stock",
  "supplier.add":            "Added supplier",
  "supplier.edit":           "Edited supplier",
  "supplier.delete":         "Deleted supplier",
  "user.approve":            "Approved user account",
  "user.suspend":            "Suspended user account",
  "user.deactivate":         "Deactivated user account",
  "user.reactivate":         "Reactivated user account",
  "user.delete":             "Removed user from platform",
  "user.roleChange":         "Changed user role",
  "user.profileUpdate":      "Updated user profile",
  "settings.inventory":      "Updated inventory settings",
  "permissions.update":      "Updated department permissions",
};

export const MODULE_LABELS = {
  inventory:   "Inventory",
  suppliers:   "Suppliers",
  stocktake:   "Stock Take",
  admin:       "Administration",
  settings:    "Settings",
  permissions: "Permissions",
};

// Fire-and-forget — never blocks the main operation.
// Callers should NOT await this; a failed audit write must never crash the primary action.
export function logAction({ action, module: mod, performedBy, performedByUid, target, details }) {
  return addDoc(collection(db, AUDIT_COL), {
    action,
    module:       mod || "unknown",
    performedBy:  performedBy  || "unknown",
    performedByUid: performedByUid || null,
    target:       target  || null,
    details:      details || null,
    performedAt:  serverTimestamp(),
  }).catch((err) =>
    console.warn("[ARIMA] Audit log write failed:", err.code, err.message)
  );
}

// ─── Read ─────────────────────────────────────────────────────
// Returns up to `pageSize` entries newest-first.
// Pass the last document snapshot as `after` for pagination.
export async function getAuditLog({ pageSize = 100, after = null, module: mod = null, performedBy = null } = {}) {
  const constraints = [orderBy("performedAt", "desc"), limit(pageSize)];
  if (mod)         constraints.unshift(where("module", "==", mod));
  if (performedBy) constraints.unshift(where("performedBy", "==", performedBy));
  if (after)       constraints.push(startAfter(after));

  const q    = query(collection(db, AUDIT_COL), ...constraints);
  const snap = await getDocs(q);
  return {
    entries:  snap.docs.map((d) => ({ id: d.id, ...d.data() })),
    lastDoc:  snap.docs[snap.docs.length - 1] ?? null,
    hasMore:  snap.docs.length === pageSize,
  };
}
