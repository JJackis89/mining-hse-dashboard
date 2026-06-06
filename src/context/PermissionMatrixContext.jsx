import { createContext, useContext } from "react";

// { [pageKey]: { [department]: level } } — live department permission
// matrix loaded once in App.jsx (departmentPermissionsService) and shared
// platform-wide via this context. Defaults to {}, which the helpers in
// utils/permissions.js (pagePermission/canPerform/canAccessRoute) treat
// as "nothing loaded yet" and resolve safely against each page's own
// configured defaults — components never need to null-check the matrix.
export const PermissionMatrixContext = createContext({});
export const usePermissionMatrix = () => useContext(PermissionMatrixContext);
