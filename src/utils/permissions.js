export const ROLES = ["admin", "supervisor", "storekeeper", "viewer"];

export const ROLE_LABELS = {
  admin:       "Administrator",
  supervisor:  "Supervisor",
  storekeeper: "Storekeeper",
  viewer:      "Viewer",
};

// Pages each role can access
export const ROUTE_ACCESS = {
  "/":           ["viewer", "storekeeper", "supervisor", "admin"],
  "/map":        ["supervisor", "admin"],
  "/inventory":  ["storekeeper", "supervisor", "admin"],
  "/operations": ["supervisor", "admin"],
  "/schedule":   ["supervisor", "admin"],
  "/admin":      ["admin"],
};

// Roles allowed to record issuances
export const ISSUANCE_ROLES = ["admin", "storekeeper"];

export function canAccess(role, path) {
  const allowed = ROUTE_ACCESS[path] ?? [];
  return allowed.includes(role ?? "viewer");
}

// All nav items (Sidebar uses this and filters by role)
export const NAV_ITEMS = [
  { path: "/",           label: "Dashboard",          icon: "grid"     },
  { path: "/map",        label: "Map Viewer",         icon: "map"      },
  { path: "/inventory",  label: "Inventory",          icon: "box"      },
  { path: "/operations", label: "Drone & Survey Ops", icon: "target"   },
  { path: "/schedule",   label: "Work Schedule",      icon: "chart"    },
  { path: "/admin",      label: "Admin Panel",        icon: "settings" },
];
