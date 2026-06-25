import { useEffect, useState, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { getReceipts } from "../services/issuanceService";

const WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const POLL_MS   = 60_000;               // 1 minute

function timeAgo(epoch) {
  if (!epoch) return "";
  const mins = Math.floor((Date.now() - epoch) / 60000);
  if (mins < 1)  return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function fmt(epoch) {
  if (!epoch) return "";
  return new Date(epoch).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

function NotificationBell() {
  const [items,    setItems]    = useState([]);
  const [open,     setOpen]     = useState(false);
  const [seenIds,  setSeenIds]  = useState(new Set());
  const knownIdsRef = useRef(new Set());
  const firstLoadRef = useRef(true);
  const wrapRef      = useRef(null);
  const navigate     = useNavigate();

  const fetchAndDiff = useCallback(() => {
    getReceipts()
      .then((rows) => {
        const cutoff = Date.now() - WINDOW_MS;
        const recent = rows.filter((r) => (r.date_time_received || 0) >= cutoff);
        if (firstLoadRef.current) {
          knownIdsRef.current = new Set(recent.map((r) => r.objectid));
          firstLoadRef.current = false;
        } else {
          recent.forEach((r) => knownIdsRef.current.add(r.objectid));
        }
        setItems(recent.sort((a, b) => (b.date_time_received || 0) - (a.date_time_received || 0)));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchAndDiff();
    const id = setInterval(fetchAndDiff, POLL_MS);
    return () => clearInterval(id);
  }, [fetchAndDiff]);

  useEffect(() => {
    const handler = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const unseenCount = items.filter((i) => !seenIds.has(i.id)).length;

  const handleToggle = () => {
    if (!open) setSeenIds(new Set(items.map((i) => i.id)));
    setOpen((o) => !o);
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
        <div className="notif-dropdown" role="listbox" aria-label="Recent receipt notifications">
          <div className="notif-dropdown-header">
            <span>Recent Receipts</span>
            <span className="notif-count">{items.length} in last 24h</span>
          </div>

          {items.length === 0 ? (
            <div className="notif-empty">No receipts in the last 24 hours</div>
          ) : (
            <ul className="notif-list">
              {items.slice(0, 30).map((item) => {
                const isNew = !seenIds.has(item.objectid);
                return (
                  <li
                    key={item.objectid}
                    role="option"
                    aria-selected={false}
                    className={`notif-item ${isNew ? "notif-item--new" : ""} notif-item--clickable`}
                    onClick={() => { setOpen(false); navigate("/inventory"); }}
                  >
                    <span className="notif-dot" style={{ background: "#B8881A" }} aria-hidden="true" />
                    <div className="notif-item-body">
                      <span className="notif-item-title">
                        {item.material_name || "Material received"}
                      </span>
                      <span className="notif-item-meta">
                        <span className="notif-type-tag" style={{ color: "#B8881A" }}>
                          {item.quantity_received != null ? `${item.quantity_received} ${item.unit || ""}`.trim() : "Receipt"}
                        </span>
                        <span className="notif-time">{timeAgo(item.date_time_received)}</span>
                      </span>
                      <span className="notif-zoom-hint">
                        {item.supplier ? `From: ${item.supplier}` : fmt(item.date_time_received)}
                      </span>
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
