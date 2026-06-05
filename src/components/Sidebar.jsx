import { NavLink } from "react-router-dom";
import arimaLogo from "../assets/arima-logo.png";
import { useUser } from "../context/UserContext";
import { NAV_ITEMS, canAccess } from "../utils/permissions";

function Sidebar({ collapsed, onToggle, isOpen, onClose }) {
  const user = useUser();
  const role = user?.role ?? "viewer";
  const visibleItems = NAV_ITEMS.filter((item) => canAccess(role, item.path));

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
            <span className="sidebar-link-icon" aria-hidden="true">{item.icon}</span>
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
