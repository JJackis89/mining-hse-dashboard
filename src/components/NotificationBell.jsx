import { useEffect, useState, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { getRecentSubmissions } from "../services/arcgisService";

const TYPE_META = {
  WorkSchedule: { color: "#1A74BC", label: "Work Schedule" },
  DroneSurvey:  { color: "#B8881A", label: "Drone/Survey"  },
};

function timeAgo(epoch) {
  if (!epoch) return "";
  const mins = Math.floor((Date.now() - epoch) / 60000);
  if (mins < 1)  return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function itemKey(item) {
  return `${item._type}-${item.objectid}`;
}

function NotificationBell({ onZoomTo }) {
  const [items,    setItems]    = useState([]);
  const [open,     setOpen]     = useState(false);
  const [seenKeys, setSeenKeys] = useState(new Set());
  const knownKeysRef  = useRef(new Set());
  const firstLoadRef  = useRef(true);
  const wrapRef       = useRef(null);
  const navigate      = useNavigate();

  const fetchAndDiff = useCallback(() => {
    getRecentSubmissions(24)
      .then((data) => {
        if (firstLoadRef.current) {
          knownKeysRef.current = new Set(data.map(itemKey));
          firstLoadRef.current = false;
        } else {
          data.forEach((item) => knownKeysRef.current.add(itemKey(item)));
        }
        setItems(data);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchAndDiff();
    const id = setInterval(fetchAndDiff, 15_000);
    return () => clearInterval(id);
  }, [fetchAndDiff]);

  useEffect(() => {
    const handler = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const unseenCount = items.filter((i) => !seenKeys.has(itemKey(i))).length;

  const handleToggle = () => {
    if (!open) setSeenKeys(new Set(items.map(itemKey)));
    setOpen((o) => !o);
  };

  const handleItemClick = (item) => {
    setOpen(false);
    if (item._type === "WorkSchedule") {
      navigate("/schedule");
    } else if (item._geometry && onZoomTo) {
      onZoomTo(item._geometry, item);
      navigate("/map");
    } else {
      navigate("/operations");
    }
  };

  return (
    <div className="notif-bell-wrap" ref={wrapRef}>
      <button
        className="notif-bell-btn"
        onClick={handleToggle}
        aria-label={`Notifications${unseenCount > 0 ? ` (${unseenCount} new)` : ""}`}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {unseenCount > 0 && (
          <span className="notif-badge" aria-hidden="true">
            {unseenCount > 99 ? "99+" : unseenCount}
          </span>
        )}
      </button>

      {open && (
        <div className="notif-dropdown" role="listbox" aria-label="Recent notifications">
          <div className="notif-dropdown-header">
            <span>Notifications</span>
            <span className="notif-count">{items.length} in last 24h</span>
          </div>

          {items.length === 0 ? (
            <div className="notif-empty">
              No recent submissions
              <span style={{ display: "block", fontSize: 11, marginTop: 6, color: "var(--text-muted)", opacity: 0.7 }}>
                Notifications will appear here once the Survey123 form is connected.
              </span>
            </div>
          ) : (
            <ul className="notif-list">
              {items.slice(0, 30).map((item, i) => {
                const meta  = TYPE_META[item._type] || { color: "#B8881A", label: item._type };
                const title = item._type === "WorkSchedule"
                  ? (item.project_name || item.project || item.activity || "New work schedule entry")
                  : (item.operator_name
                      ? `${item.operation_type || "Submission"} — ${item.operator_name}`
                      : item.operation_type || "New submission");
                const isNew      = !seenKeys.has(itemKey(item));
                const hasLocation = !!item._geometry;
                return (
                  <li
                    key={`${item._type}-${item.objectid}-${i}`}
                    role="option"
                    aria-selected={false}
                    className={`notif-item ${isNew ? "notif-item--new" : ""} notif-item--clickable`}
                    onClick={() => handleItemClick(item)}
                  >
                    <span className="notif-dot" style={{ background: meta.color }} aria-hidden="true" />
                    <div className="notif-item-body">
                      <span className="notif-item-title">{title}</span>
                      <span className="notif-item-meta">
                        <span className="notif-type-tag" style={{ color: meta.color }}>{meta.label}</span>
                        <span className="notif-time">{timeAgo(item.CreationDate)}</span>
                      </span>
                      {hasLocation && (
                        <span className="notif-zoom-hint">Click to view on map</span>
                      )}
                      {!hasLocation && (
                        <span className="notif-zoom-hint">Click to open Operations</span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export default NotificationBell;
