// Shared "Insufficient Permissions" messaging — per the spec's UX
// requirement to surface a clear notice whenever a department's
// configured access level hides or blocks a restricted action.
//
// `variant="banner"` (default) renders an inline strip for read-only
// tab/section views (reuses the existing .permission-notice style from
// Inventory's Issuances tab). `variant="blocked"` renders a standalone
// state for an attempted action that was rejected outright.
function PermissionNotice({ department, action = "modify records", variant = "banner" }) {
  const whoText = department
    ? `Your department (${department}) has`
    : "Your account has";

  if (variant === "blocked") {
    return (
      <div className="permission-notice permission-notice--blocked" role="alert">
        <strong>Insufficient Permissions.</strong>{" "}
        {whoText} read-only access to this page. Contact an administrator
        if you need to {action}.
      </div>
    );
  }

  return (
    <div className="permission-notice" role="note">
      {whoText} view-only access here. Contact an administrator if you need to {action}.
    </div>
  );
}

export default PermissionNotice;
