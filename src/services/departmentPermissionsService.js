import { db } from "../firebase";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  addDoc,
  onSnapshot,
  serverTimestamp,
  writeBatch,
  query,
  orderBy,
  limit as fbLimit,
} from "firebase/firestore";
import { PAGES, DEPARTMENTS, getPageDefaultPermissions } from "../utils/permissions";

const MATRIX_COL = "departmentPermissions";
const AUDIT_COL  = "permissionAuditLog";

// ── Matrix ─────────────────────────────────────────────────────

/**
 * Subscribe to the live permission matrix in real time.
 *
 * Emits an array of "page rows" — one per PAGES entry — each carrying
 * the merged { [department]: level } map (Firestore overrides layered
 * onto the page's configured defaults, so the UI and gating helpers
 * always see a complete matrix even before a page has been saved) plus
 * `updatedAt` / `updatedBy` metadata for display. Returns the unsubscribe fn.
 */
export function subscribeToPermissionRows(onData, onError) {
  return onSnapshot(
    collection(db, MATRIX_COL),
    (snap) => {
      const stored = {};
      snap.docs.forEach((d) => { stored[d.id] = d.data(); });

      const rows = PAGES.map((page) => {
        const saved   = stored[page.key];
        const base    = getPageDefaultPermissions(page);
        const merged  = saved?.permissions ? { ...base, ...saved.permissions } : base;
        return {
          key:         page.key,
          label:       page.label,
          locked:      !!page.locked,
          routes:      page.routes,
          permissions: merged,
          updatedAt:   saved?.updatedAt ?? null,
          updatedBy:   saved?.updatedBy ?? null,
          seeded:      !!saved,
        };
      });

      onData(rows);
    },
    onError
  );
}

/** Pure helper: derive the { [pageKey]: { [department]: level } } lookup
 *  consumed by pagePermission/canPerform/canAccessRoute from subscription rows. */
export function matrixFromRows(rows) {
  return Object.fromEntries(rows.map((r) => [r.key, r.permissions]));
}

/**
 * One-time, idempotent seed: writes a `departmentPermissions/{pageKey}`
 * document (using each page's spec-defined defaults) for any page that
 * doesn't have one yet. Never overwrites an existing/customized doc.
 *
 * Called when an administrator opens the Department Permissions tab —
 * this guarantees the spec's default matrix (Stores/Inventory = Full
 * Access on Inventory, Survey & GIS = Full Access on Drone & Survey Ops
 * and Map View, etc.) is in place from the very first view, with no
 * separate migration step. Returns the number of pages seeded.
 */
export async function ensureMatrixSeeded(adminUser) {
  const snap = await getDocs(collection(db, MATRIX_COL));
  const existing = new Set(snap.docs.map((d) => d.id));
  const missing  = PAGES.filter((p) => !existing.has(p.key));
  if (missing.length === 0) return 0;

  const batch = writeBatch(db);
  missing.forEach((page) => {
    batch.set(doc(db, MATRIX_COL, page.key), {
      pageKey:     page.key,
      label:       page.label,
      permissions: getPageDefaultPermissions(page),
      updatedAt:   serverTimestamp(),
      updatedBy:   adminUser?.email ?? "system",
    });
  });
  await batch.commit();
  return missing.length;
}

/**
 * Save a page's full department → level row and write one immutable
 * audit-log entry per department whose level actually changed (mirrors
 * the administrator/department/previous/new/timestamp shape requested
 * for permission-change auditing — see writeLog/diff in
 * droneActivityService.js for the template this follows).
 */
export async function savePagePermissions(pageKey, nextPermissions, adminUser) {
  const page = PAGES.find((p) => p.key === pageKey);
  if (!page) throw new Error(`Unknown page "${pageKey}"`);

  const ref  = doc(db, MATRIX_COL, pageKey);
  const snap = await getDoc(ref);
  const before = snap.exists() && snap.data().permissions
    ? { ...getPageDefaultPermissions(page), ...snap.data().permissions }
    : getPageDefaultPermissions(page);

  const changed = DEPARTMENTS.filter((dept) => (before[dept] ?? null) !== (nextPermissions[dept] ?? null));

  await setDoc(ref, {
    pageKey,
    label:       page.label,
    permissions: nextPermissions,
    updatedAt:   serverTimestamp(),
    updatedBy:   adminUser.email,
  }, { merge: true });

  await Promise.all(changed.map((dept) => addDoc(collection(db, AUDIT_COL), {
    pageKey,
    pageLabel:     page.label,
    department:    dept,
    previousLevel: before[dept] ?? null,
    newLevel:      nextPermissions[dept] ?? null,
    changedBy:     adminUser.email,
    changedByUid:  adminUser.uid,
    changedAt:     serverTimestamp(),
  })));

  return changed.length;
}

// ── Audit log ──────────────────────────────────────────────────

/**
 * Subscribe to the most recent permission-change audit entries
 * (newest first). Immutable, append-only — see firestore.rules.
 */
export function subscribeToAuditLog(onData, onError, max = 100) {
  return onSnapshot(
    query(collection(db, AUDIT_COL), orderBy("changedAt", "desc"), fbLimit(max)),
    (snap) => onData(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    onError
  );
}
