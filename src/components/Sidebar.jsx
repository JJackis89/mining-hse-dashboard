import { NavLink } from "react-router-dom";
import arimaLogo from "../assets/arima-logo.png";
import { useUser } from "../context/UserContext";
import { usePermissionMatrix } from "../context/PermissionMatrixContext";
import { NAV_ITEMS, canAccessRoute } from "../utils/permissions";

const S = { fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinecap: "round", strokeLinejoin: "round" };

const NAV_ICONS = {
  grid: (
    <svg width="16" height="16" viewBox="0 0 16 16" {...S}>
      <rect x="1.5" y="1.5" width="5" height="5" rx="0.75"/>
      <rect x="9.5" y="1.5" width="5" height="5" rx="0.75"/>
      <rect x="1.5" y="9.5" width="5" height="5" rx="0.75"/>
      <rect x="9.5" y="9.5" width="5" height="5" rx="0.75"/>
    </svg>
  ),
  map: (
    <svg width="16" height="16" viewBox="0 0 16 16" {...S}>
      <path d="M1 3.5l5-2 4 2 5-2v9l-5 2-4-2-5 2V3.5z"/>
      <line x1="6" y1="1.5" x2="6" y2="11.5"/>
      <line x1="10" y1="3.5" x2="10" y2="13.5"/>
    </svg>
  ),
  box: (
    <svg width="16" height="16" viewBox="0 0 16 16" {...S}>
      <path d="M2 5.5L8 3l6 2.5v5L8 13l-6-2.5v-5z"/>
      <path d="M8 3v10M2 5.5l6 2.5 6-2.5"/>
    </svg>
  ),
  target: (
    <svg width="16" height="16" viewBox="0 0 16 16" {...S}>
      <circle cx="8" cy="8" r="4.5"/>
      <line x1="8" y1="1" x2="8" y2="3.5"/>
      <line x1="8" y1="12.5" x2="8" y2="15"/>
      <line x1="1" y1="8" x2="3.5" y2="8"/>
      <line x1="12.5" y1="8" x2="15" y2="8"/>
    </svg>
  ),
  chart: (
    <svg width="16" height="16" viewBox="0 0 16 16" {...S}>
      <line x1="1" y1="14" x2="15" y2="14"/>
      <rect x="2.5" y="7.5" width="3" height="6.5" rx="0.5"/>
      <rect x="6.5" y="4.5" width="3" height="9.5" rx="0.5"/>
      <rect x="10.5" y="9.5" width="3" height="4.5" rx="0.5"/>
    </svg>
  ),
  settings: (
    <svg width="16" height="16" viewBox="0 0 16 16" {...S}>
      <circle cx="8" cy="8" r="2.5"/>
      <path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3"/>
    </svg>
  ),
};

function Sidebar({ collapsed, onToggle, isOpen, onClose }) {
  const user = useUser();
  const matrix = usePermissionMatrix();
  const visibleItems = NAV_ITEMS.filter((item) => canAccessRoute(user, matrix, item.path));

  // On mobile overlay, always show labels regardless of desktop collapsed state
  const showLabels = isOpen || !collapsed;

  return (
    <aside
      id="main-sidebar"
      className={`sidebar ${collapsed ? "sidebar--collapsed" : ""} ${isOpen ? "sidebar--mobile-open" : ""}`}
      aria-label="Main navigation"
    >
      <div className="sidebar-brand">
        <img src={arimaLogo} alt="ARIMA Resources" className="sidebar-brand-logo" />
        {showLabels && (
          <div className="sidebar-brand-text">
            <span className="brand-title">ARIMA RESOURCES</span>
            <span className="brand-sub">Operations Platform</span>
          </div>
        )}
      </div>

      <nav className="sidebar-nav" aria-label="Site navigation">
        {visibleItems.map((item) => (
          <NavLink
            key={item.path}
            to={item.path}
            end={item.path === "/"}
            className={({ isActive }) =>
              `sidebar-link ${isActive ? "sidebar-link--active" : ""} ${item.path === "/admin" ? "sidebar-link--admin" : ""}`
            }
            title={!showLabels ? item.label : undefined}
            aria-label={item.label}
            onClick={onClose}
          >
            <span className="sidebar-link-icon" aria-hidden="true">{NAV_ICONS[item.icon]}</span>
            {showLabels && (
              <span className="sidebar-link-label">{item.label}</span>
            )}
          </NavLink>
        ))}
      </nav>

      <button
        className="sidebar-toggle"
        onClick={onToggle}
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        aria-expanded={!collapsed}
      >
        {collapsed ? "›" : "‹"}
      </button>
    </aside>
  );
}

export default Sidebar;
