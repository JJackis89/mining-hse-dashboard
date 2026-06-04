import { useLocation } from "react-router-dom";
import NotificationBell from "./NotificationBell";
import { ROLE_LABELS } from "../utils/permissions";

const PAGE_TITLES = {
  "/":           "Dashboard Overview",
  "/map":        "Map Viewer",
  "/inventory":  "Inventory",
  "/operations": "Drone & Survey Operations",
  "/schedule":   "Work Schedule & Progress Monitoring",
  "/admin":      "System Administration",
};

const ROLE_BADGE_STYLE = {
  admin:       { background: "rgba(125,60,152,0.12)", color: "var(--purple)" },
  supervisor:  { background: "rgba(26,116,188,0.12)", color: "var(--accent-blue)" },
  storekeeper: { background: "rgba(184,136,26,0.12)", color: "var(--accent-orange)" },
  viewer:      { background: "rgba(139,150,166,0.12)", color: "var(--text-muted)" },
};

function Header({ user, onLogout, onZoomTo }) {
  const location = useLocation();
  const title = PAGE_TITLES[location.pathname] || "ARIMA Resources";
  const roleStyle = ROLE_BADGE_STYLE[user.role] ?? ROLE_BADGE_STYLE.viewer;

  return (
    <header className="app-header">
      <div className="header-left">
        <h2 className="header-page-title">{title}</h2>
      </div>

      <div className="header-right">
        <span className="header-clock">
          {new Date().toLocaleDateString("en-GB", {
            day: "2-digit", month: "short", year: "numeric",
          })}
        </span>

        <NotificationBell onZoomTo={onZoomTo} />

        <span className="header-role-badge" style={roleStyle} aria-label={`Role: ${ROLE_LABELS[user.role]}`}>
          {ROLE_LABELS[user.role] ?? user.role}
        </span>

        <span className="header-user-email">{user.email}</span>

        <button onClick={onLogout} className="header-logout-btn" aria-label="Log out">
          Log Out
        </button>
      </div>
    </header>
  );
}

export default Header;
