// ── Departments (fixed list) ───────────────────────────────────
// To add a department: add its name here and to firestore.rules'
// DEPARTMENTS-mirroring validation (departmentPermissions write rule).
// Every page in the matrix automatically gains a row for it.
export const DEPARTMENTS = [
  "Administration",
  "Management",
  "Survey & GIS",
  "Drone Operations",
  "Stores / Inventory",
  "Projects / Construction",
  "Environmental",
  "Health & Safety",
  "Finance",
  "Human Resources",
  "IT & Digital Services",
];

// ── Roles ──────────────────────────────────────────────────────
// `role: "admin"` is the only role that still gates access by itself —
// administrators are the unrestricted super-user override (principle:
// "Administrators get unrestricted access to everything"; see
// pagePermission/canPerform below). supervisor/storekeeper/viewer are
// now job-classification labels only — page and action access for
// non-admins is driven entirely by `department` plus the configurable
// matrix in the `departmentPermissions` collection.
export const ROLES = ["admin", "supervisor", "storekeeper", "viewer"];

export const ROLE_LABELS = {
  admin:       "Administrator",
  supervisor:  "Supervisor",
  storekeeper: "Storekeeper",
  viewer:      "Officer",
};

// ── Permission levels ──────────────────────────────────────────
// Ordered low → high. A department's level on a page implies every
// capability below it on this ladder (e.g. "Edit" also covers View
// and Create; "Full Access" covers everything). Index doubles as the
// numeric rank used to compare levels — see levelRank/levelSatisfies.
export const PERMISSION_LEVELS = [
  "No Access",
  "View Only",
  "Create",
  "Edit",
  "Delete",
  "Approve",
  "Full Access",
];

const LEVEL_RANK = Object.fromEntries(PERMISSION_LEVELS.map((lvl, i) => [lvl, i]));

export function levelRank(level) {
  return LEVEL_RANK[level] ?? 0;
}

// True when `level` grants at least as much access as `required`.
export function levelSatisfies(level, required) {
  return levelRank(level) >= levelRank(required ?? "View Only");
}

// Minimum level required to perform each kind of gated action.
export const ACTION_LEVELS = {
  view:    "View Only",
  create:  "Create",
  edit:    "Edit",
  delete:  "Delete",
  approve: "Approve",
  manage:  "Full Access",
};

// Used whenever a department has no explicit entry for a page. Matches
// "all departments can view most modules by default for transparency"
// while still defaulting every mutating action (Create/Edit/Delete/
// Approve/Full Access) to denied — a missing configuration can never
// accidentally grant write access.
export const DEFAULT_PERMISSION_LEVEL = "View Only";

// ── Pages / modules registry ───────────────────────────────────
// One entry = one row of the Department Permissions matrix = one
// independently configurable unit of access. `routes` lists every
// route this entry gates; a department's effective access to a route
// is the HIGHEST level granted by any entry that gates it — this is
// what lets "Map View" and "Geospatial IT & Digital Services" both
// govern the single /map route without conflicting (see
// routePermission). `defaults` seed the matrix the first time an
// administrator opens Department Permissions (departmentPermissionsService
// .ensureSeeded) and are also used as the fallback if Firestore has not
// been seeded yet, so behaviour matches the spec from first load.
//
// Scaling: adding a module here — plus a route/NAV_ITEMS entry if it
// has its own page — is the only code change needed; the matrix UI,
// route guards, action gates and audit log all pick it up automatically.
export const PAGES = [
  {
    key: "dashboard",
    label: "Overview",
    routes: ["/dashboard"],
    defaults: {},
  },
  {
    key: "inventory",
    label: "Inventory",
    routes: ["/inventory"],
    defaults: { "Stores / Inventory": "Full Access" },
  },
  {
    key: "suppliers",
    label: "Supplier Directory",
    routes: ["/suppliers"],
    defaults: { "Stores / Inventory": "Full Access", "Finance": "View Only" },
  },
  {
    key: "stockTake",
    label: "Stock Take",
    routes: ["/stocktake"],
    defaults: { "Stores / Inventory": "Full Access" },
  },
  {
    key: "reports",
    label: "Reports",
    routes: ["/reports"],
    defaults: { "Management": "Full Access", "Finance": "Full Access", "Stores / Inventory": "Full Access" },
  },
  {
    key: "adminModule",
    label: "Administration Module",
    routes: ["/admin"],
    // Gated by role:"admin" (see canPerform/routePermission), not by
    // department — "Administrators only" means the platform super-user
    // tier, not the "Administration" department.
    locked:   true,
    fallback: "No Access",
    defaults: {},
  },
];

export function getPage(pageKey) {
  return PAGES.find((p) => p.key === pageKey) ?? null;
}

function pageFallback(page) {
  return page?.fallback ?? DEFAULT_PERMISSION_LEVEL;
}

// Full { [department]: level } row for a page — gaps filled from
// `defaults`, then the page's fallback. This is the seed value written
// to Firestore and the value used before seeding has happened.
export function getPageDefaultPermissions(page) {
  const fallback = pageFallback(page);
  return Object.fromEntries(
    DEPARTMENTS.map((dept) => [dept, page.defaults?.[dept] ?? fallback])
  );
}

// ── Live matrix shape ──────────────────────────────────────────
// { [pageKey]: { [department]: level } } — built from Firestore
// `departmentPermissions` docs by departmentPermissionsService
// .matrixFromRows(), gaps filled with each page's configured defaults.

// Permission level `user` holds on a single matrix entry.
// Administrators always hold "Full Access" — the unrestricted override
// (principle: "Administrators get unrestricted access to everything").
export function pagePermission(user, matrix, pageKey) {
  if (user?.role === "admin") return "Full Access";
  const page = getPage(pageKey);
  if (!page) return "No Access";
  const dept = user?.department;
  if (!dept) return pageFallback(page);
  return matrix?.[pageKey]?.[dept] ?? page.defaults?.[dept] ?? pageFallback(page);
}

// Effective permission for a ROUTE = the highest level granted by any
// matrix entry that gates it. A route with no gating entry is inaccessible.
export function routePermission(user, matrix, path) {
  if (user?.role === "admin") return "Full Access";
  const gating = PAGES.filter((p) => p.routes.includes(path));
  if (gating.length === 0) return "No Access";
  return gating.reduce((best, page) => {
    const level = pagePermission(user, matrix, page.key);
    return levelRank(level) > levelRank(best) ? level : best;
  }, "No Access");
}

export function canAccessRoute(user, matrix, path) {
  return levelSatisfies(routePermission(user, matrix, path), "View Only");
}

// Can `user` perform `action` ("view"|"create"|"edit"|"delete"|"approve"|
// "manage") on the page identified by `pageKey`? Administrators always pass.
export function canPerform(user, matrix, pageKey, action) {
  if (user?.role === "admin") return true;
  const required = ACTION_LEVELS[action] ?? "Full Access";
  return levelSatisfies(pagePermission(user, matrix, pageKey), required);
}

// All nav items — Sidebar filters these via canAccessRoute(user, matrix, path)
export const NAV_ITEMS = [
  { path: "/dashboard",  label: "Overview",         icon: "chart"    },
  { path: "/inventory",  label: "Inventory",         icon: "box"      },
  { path: "/suppliers",  label: "Suppliers",         icon: "truck"    },
  { path: "/stocktake",  label: "Stock Take",        icon: "clipboard" },
  { path: "/reports",    label: "Reports",           icon: "bar"      },
  { path: "/admin",      label: "Admin Panel",       icon: "settings" },
];
