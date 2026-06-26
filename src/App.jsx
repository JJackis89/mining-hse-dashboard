import { useState, useEffect, lazy, Suspense, useRef } from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
} from "firebase/auth";
import {
  doc,
  getDoc,
  setDoc,
  deleteDoc,
  onSnapshot,
  serverTimestamp,
} from "firebase/firestore";
import { auth, db } from "./firebase";
import { UserContext, useUser } from "./context/UserContext";
import { PermissionMatrixContext, usePermissionMatrix } from "./context/PermissionMatrixContext";
import { canAccessRoute } from "./utils/permissions";
import { subscribeToPermissionRows, matrixFromRows } from "./services/departmentPermissionsService";

import arimaLogo from "./assets/arima-logo.png";

import Sidebar from "./components/Sidebar";
import Header from "./components/Header";

const Dashboard  = lazy(() => import("./pages/Dashboard"));
const Inventory  = lazy(() => import("./pages/Inventory"));
const Suppliers  = lazy(() => import("./pages/Suppliers"));
const StockTake  = lazy(() => import("./pages/StockTake"));
const Reports    = lazy(() => import("./pages/Reports"));
const AdminPanel = lazy(() => import("./pages/AdminPanel"));

import "./App.css";

// Baked in at build time — safe to hoist to module scope so watchOwnProfile
// can reference it without being inside the useEffect closure.
const ADMIN_EMAILS = (import.meta.env.VITE_FIRST_ADMIN_EMAIL ?? "")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

// ─── Registration: resilient profile write ────────────────────
// Retries setDoc up to 3 times (1.5 s / 3 s backoff), fully non-blocking.
// onFinalFailure() is called when all attempts are exhausted so the UI
// can surface an error banner and the fallback collection can be written.
function writeProfileRetrying(uid, profile, onFinalFailure = null, attempt = 1) {
  const iso = () => new Date().toISOString();
  setDoc(doc(db, "userRoles", uid), profile, { merge: true })
    .then(() =>
      console.log(`[ARIMA ${iso()}] ✓ Profile synced uid=${uid.slice(0, 8)} (attempt ${attempt})`)
    )
    .catch((err) => {
      console.error(
        `[ARIMA ${iso()}] ✗ Profile write attempt ${attempt} failed uid=${uid.slice(0, 8)}:`,
        err.code, err.message
      );
      if (attempt < 3) {
        const delay = attempt * 1500;
        console.log(`[ARIMA ${iso()}] Retrying in ${delay}ms (${3 - attempt} left)…`);
        setTimeout(() => writeProfileRetrying(uid, profile, onFinalFailure, attempt + 1), delay);
      } else {
        console.error(
          `[ARIMA ${iso()}] ✗ All retries exhausted uid=${uid.slice(0, 8)}.`,
          "Root cause: Firestore security rules are blocking writes to userRoles.",
          "Fix: update rules so authenticated users can create their own userRoles document."
        );
        // Fallback: write a minimal stub to failedRegistrations so the admin
        // can see and approve the account from the Diagnostics tab.
        const { createdAt: _cAt, lastLogin: _lL, ...stub } = profile;
        setDoc(doc(db, "failedRegistrations", uid), {
          ...stub,
          failedAt: serverTimestamp(),
          failReason: "permission-denied",
        }).then(() =>
          console.log(`[ARIMA ${iso()}] Queued uid=${uid.slice(0, 8)} in failedRegistrations for admin recovery`)
        ).catch(() =>
          console.error(`[ARIMA ${iso()}] failedRegistrations write also failed — update Firestore rules.`)
        );
        onFinalFailure?.();
      }
    });
}

const AUTH_ERRORS = {
  "auth/invalid-credential":     "Invalid email or password.",
  "auth/user-not-found":         "No account found with this email.",
  "auth/wrong-password":         "Incorrect password.",
  "auth/too-many-requests":      "Too many attempts. Please try again later.",
  "auth/user-disabled":          "This account has been disabled.",
  "auth/network-request-failed": "Network error. Check your connection.",
  "auth/email-already-in-use":   "An account with this email already exists.",
  "auth/weak-password":          "Password must be at least 6 characters.",
  "auth/invalid-email":          "Please enter a valid email address.",
};

function PageLoader() {
  return (
    <div className="loading-state" aria-label="Loading page">
      <div className="spinner" />
      <p>Loading…</p>
    </div>
  );
}

// ─── Route Guard ──────────────────────────────────────────────
function GuardedRoute({ path, children }) {
  const user   = useUser();
  const matrix = usePermissionMatrix();
  if (!user || !canAccessRoute(user, matrix, path)) {
    return (
      <div className="access-denied-state">
        <p className="access-denied-title">Access Restricted</p>
        <p className="access-denied-body">
          You do not have permission to view this page.
          Contact your administrator to request access.
        </p>
      </div>
    );
  }
  return children;
}

// ─── App ──────────────────────────────────────────────────────
function App() {
  const [user, setUser]                 = useState(null);
  const [authLoading, setAuthLoading]   = useState(true);
  const [permissionMatrix, setPermissionMatrix] = useState({});
  const [email, setEmail]               = useState("");
  const [password, setPassword]         = useState("");
  const [confirmPass, setConfirmPass]   = useState("");
  const [fullName, setFullName]         = useState("");
  const [error, setError]               = useState("");
  const [loginLoading, setLoginLoading] = useState(false);
  const [isSignUp, setIsSignUp]         = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [profileSyncFailed, setProfileSyncFailed] = useState(false);

  // Carries fullName from the signup form into the async onAuthStateChanged handler
  const signupFullNameRef = useRef("");

  // Unsubscribe handle for the live userRoles/{uid} listener — re-created on
  // every auth state change, torn down on the next change or unmount so role
  // and status edits made in the Admin Panel apply to the session immediately.
  const profileUnsubRef = useRef(null);

  // Watches the signed-in user's own profile document in real time and keeps
  // local state (role, accountStatus, etc.) in sync with Firestore. If an
  // administrator suspends/deactivates the account, the session is force-signed-out.
  const watchOwnProfile = (uid) => {
    if (profileUnsubRef.current) {
      profileUnsubRef.current();
      profileUnsubRef.current = null;
    }
    profileUnsubRef.current = onSnapshot(
      doc(db, "userRoles", uid),
      (snap) => {
        if (!snap.exists()) return;
        const data = snap.data();

        setUser((prev) => {
          if (!prev || prev.uid !== uid) return prev;

          // Never let a stale Firestore snapshot demote a designated admin.
          // The profile write is async — until it settles the snapshot may
          // still show the old role. Admins keep their role regardless.
          const isDesignated = ADMIN_EMAILS.includes(prev.email?.toLowerCase());
          const freshRole   = isDesignated ? "admin"  : (data.role          ?? "viewer");
          const freshStatus = isDesignated ? "Active" : (data.accountStatus ?? "Active");

          if (prev.role === freshRole && prev.accountStatus === freshStatus) return prev;
          return {
            ...prev,
            role:          freshRole,
            accountStatus: freshStatus,
            fullName:      data.fullName   ?? prev.fullName,
            department:    data.department ?? prev.department,
            rank:          data.rank       ?? prev.rank,
          };
        });
      },
      (err) => console.warn(`[ARIMA] Profile watch error uid=${uid.slice(0, 8)}:`, err.code)
    );
  };

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      const t0  = Date.now();
      const iso = () => new Date().toISOString();
      console.log(`[ARIMA ${iso()}] onAuthStateChanged:`, firebaseUser ? firebaseUser.email : "signed out");

      // Tear down any live profile listener from a previous session before
      // resolving the new one — prevents cross-account state leakage.
      if (profileUnsubRef.current) {
        profileUnsubRef.current();
        profileUnsubRef.current = null;
      }

      if (firebaseUser) {
        const isDesignatedAdmin = ADMIN_EMAILS.includes(
          firebaseUser.email.toLowerCase()
        );

        const onSyncFail = () => setProfileSyncFailed(true);

        // True only on the request that just called createUserWithEmailAndPassword —
        // distinguishes "new registration" from "returning sign-in" so we never
        // clobber an existing profile's name/createdAt/status on every login.
        const isNewRegistration = !!signupFullNameRef.current;

        if (isDesignatedAdmin) {
          const capturedName = signupFullNameRef.current;
          signupFullNameRef.current = "";

          // Only stamp identity fields on first creation — merge writes on
          // every subsequent login must NOT overwrite fullName/createdAt
          // with blanks, and must NEVER be able to demote this account.
          writeProfileRetrying(firebaseUser.uid, {
            uid:           firebaseUser.uid,
            email:         firebaseUser.email,
            ...(isNewRegistration && {
              fullName:  capturedName,
              createdAt: serverTimestamp(),
            }),
            role:          "admin",
            accountStatus: "Active",
            lastLogin:     serverTimestamp(),
          }, onSyncFail);

          setUser({
            email: firebaseUser.email, uid: firebaseUser.uid,
            role: "admin", accountStatus: "Active",
          });
          watchOwnProfile(firebaseUser.uid);
          setAuthLoading(false);
          console.log(`[ARIMA ${iso()}] Auth resolved in ${Date.now() - t0}ms (admin)`);
          return;
        }

        // ── Default posture for every non-designated-admin account ──
        // Never trust a client-supplied role; the safe default is the lowest
        // privilege tier, and brand-new accounts always start out unapproved.
        let role          = "viewer";
        let accountStatus = "Active";
        let fullName      = "";
        let department    = "";
        let rank          = "";

        try {
          // Fast path: only read userRoles. For returning users (the common
          // case) this is the only Firestore round-trip needed — pendingRoles
          // is irrelevant once a profile exists. New users get a second read.
          const roleSnap = await getDoc(doc(db, "userRoles", firebaseUser.uid));

          if (roleSnap.exists()) {
            // ── Returning user ────────────────────────────────────
            const existing = roleSnap.data();
            role          = existing.role          ?? "viewer";
            accountStatus = existing.accountStatus ?? "Active";
            fullName      = existing.fullName      ?? "";
            department    = existing.department    ?? "";
            rank          = existing.rank          ?? "";
            signupFullNameRef.current = "";

            const updates = { lastLogin: serverTimestamp() };
            if (!Object.prototype.hasOwnProperty.call(existing, "accountStatus")) {
              updates.uid           = firebaseUser.uid;
              updates.fullName      = existing.fullName   || "";
              updates.department    = existing.department || "";
              updates.rank          = existing.rank       || "";
              updates.accountStatus = "Active";
              accountStatus = "Active";
            }
            // Fire-and-forget — never blocks auth resolution
            setDoc(doc(db, "userRoles", firebaseUser.uid), updates, { merge: true })
              .catch(() => {});
          } else {
            // ── Brand-new account ─────────────────────────────────
            const capturedName = signupFullNameRef.current;
            signupFullNameRef.current = "";

            role          = "viewer";
            accountStatus = "Pending Approval";
            fullName      = capturedName;
            rank          = "Officer";

            // Only new accounts need the pendingRoles check
            const pendingSnap = await getDoc(doc(db, "pendingRoles", firebaseUser.email))
              .catch(() => null);

            if (pendingSnap?.exists()) {
              role = pendingSnap.data().role ?? "viewer";
              deleteDoc(doc(db, "pendingRoles", firebaseUser.email)).catch(() => {});
            }

            writeProfileRetrying(firebaseUser.uid, {
              uid:           firebaseUser.uid,
              email:         firebaseUser.email,
              fullName,
              role,
              department:    "",
              rank,
              accountStatus,
              createdAt:     serverTimestamp(),
              lastLogin:     serverTimestamp(),
            }, onSyncFail);
          }
        } catch (err) {
          console.error(`[ARIMA ${iso()}] Read error:`, err.code, err.message);
          const recoveryName = signupFullNameRef.current;
          signupFullNameRef.current = "";

          // We couldn't confirm whether a profile already exists. Only a
          // registration-in-progress should be parked as Pending Approval;
          // a returning user hitting a transient read error must not be
          // locked out of an account that was already active.
          role          = "viewer";
          accountStatus = isNewRegistration ? "Pending Approval" : "Active";
          fullName      = recoveryName || "";
          rank          = isNewRegistration ? "Officer" : "";

          writeProfileRetrying(firebaseUser.uid, {
            uid:           firebaseUser.uid,
            email:         firebaseUser.email,
            fullName,
            role,
            department:    "",
            rank,
            accountStatus,
            createdAt:     serverTimestamp(),
            lastLogin:     serverTimestamp(),
          }, onSyncFail);
        }

        setUser({
          email: firebaseUser.email, uid: firebaseUser.uid,
          role, accountStatus, fullName, department, rank,
        });
        watchOwnProfile(firebaseUser.uid);
      } else {
        setUser(null);
      }
      setAuthLoading(false);
      console.log(`[ARIMA ${iso()}] Auth complete in ${Date.now() - t0}ms`);
    });

    return () => {
      unsubscribe();
      if (profileUnsubRef.current) {
        profileUnsubRef.current();
        profileUnsubRef.current = null;
      }
    };
  }, []);

  // Live department permission matrix — every signed-in session needs this
  // to compute its own effective access (route guards, nav filtering, button
  // gating). Subscribed once per sign-in and shared platform-wide via
  // PermissionMatrixContext; an admin's edits in Department Permissions
  // therefore take effect for everyone immediately, the same way role/
  // status changes already do via watchOwnProfile.
  useEffect(() => {
    if (!user?.uid) return;
    const unsubscribe = subscribeToPermissionRows(
      (rows) => setPermissionMatrix(matrixFromRows(rows)),
      (err) => console.warn("[ARIMA] Permission matrix read error:", err.code)
    );
    return () => {
      unsubscribe();
      setPermissionMatrix({});
    };
  }, [user?.uid]);

  const handleLogin = async (e) => {
    e.preventDefault();
    setError("");
    setLoginLoading(true);
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (err) {
      setError(AUTH_ERRORS[err.code] || "Authentication failed. Please try again.");
      setLoginLoading(false);
    }
  };

  const handleSignUp = async (e) => {
    e.preventDefault();
    if (!fullName.trim()) {
      setError("Please enter your full name.");
      return;
    }
    if (password !== confirmPass) {
      setError("Passwords do not match.");
      return;
    }
    setError("");
    setLoginLoading(true);
    signupFullNameRef.current = fullName.trim();
    try {
      await createUserWithEmailAndPassword(auth, email, password);
      // onAuthStateChanged fires next and writes the full profile to userRoles
    } catch (err) {
      signupFullNameRef.current = "";
      setError(AUTH_ERRORS[err.code] || "Registration failed. Please try again.");
      setLoginLoading(false);
    }
  };

  const handleLogout = () => signOut(auth);

  const switchMode = (toSignUp) => {
    setIsSignUp(toSignUp);
    setError("");
    setPassword("");
    setConfirmPass("");
    setFullName("");
  };

  if (authLoading) {
    return (
      <div className="login-screen">
        <div className="loading-state" aria-label="Checking authentication">
          <div className="spinner" />
          <p>Checking authentication…</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="login-screen">
        <div className="login-card" role="main">
          <div className="login-header">
            <img src={arimaLogo} alt="ARIMA Resources logo" className="login-logo" />
            <h1>ARIMA RESOURCES OPERATIONS PLATFORM</h1>
            <p className="login-subtitle">Inventory Management System</p>
          </div>

          {/* Mode Toggle */}
          <div className="login-mode-toggle" role="tablist" aria-label="Authentication mode">
            <button
              role="tab"
              aria-selected={!isSignUp}
              className={`login-mode-btn ${!isSignUp ? "login-mode-btn--active" : ""}`}
              onClick={() => switchMode(false)}
              type="button"
            >
              Sign In
            </button>
            <button
              role="tab"
              aria-selected={isSignUp}
              className={`login-mode-btn ${isSignUp ? "login-mode-btn--active" : ""}`}
              onClick={() => switchMode(true)}
              type="button"
            >
              Create Account
            </button>
          </div>

          <form
            onSubmit={isSignUp ? handleSignUp : handleLogin}
            className="login-form"
            aria-label={isSignUp ? "Create account form" : "Sign in form"}
            noValidate
          >
            {error && <div className="login-error" role="alert">{error}</div>}

            <div className="form-group">
              <label htmlFor="email">Email Address</label>
              <input
                id="email"
                type="email"
                placeholder="operator@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
                aria-required="true"
              />
            </div>

            {isSignUp && (
              <div className="form-group">
                <label htmlFor="fullName">Full Name</label>
                <input
                  id="fullName"
                  type="text"
                  placeholder="Your full name"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  required
                  autoComplete="name"
                  aria-required="true"
                />
              </div>
            )}

            <div className="form-group">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                type="password"
                placeholder={isSignUp ? "Minimum 6 characters" : "Enter your password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete={isSignUp ? "new-password" : "current-password"}
                aria-required="true"
              />
            </div>

            {isSignUp && (
              <div className="form-group">
                <label htmlFor="confirmPass">Confirm Password</label>
                <input
                  id="confirmPass"
                  type="password"
                  placeholder="Re-enter your password"
                  value={confirmPass}
                  onChange={(e) => setConfirmPass(e.target.value)}
                  required
                  autoComplete="new-password"
                  aria-required="true"
                />
              </div>
            )}

            <button type="submit" className="login-btn" disabled={loginLoading}>
              {loginLoading
                ? (isSignUp ? "Creating account…" : "Authenticating…")
                : (isSignUp ? "Create Account" : "Sign In")}
            </button>
          </form>

          {isSignUp ? (
            <p className="login-footer">
              New accounts require <strong>administrator approval</strong> before sign-in.
              You will be notified once your access is granted.
            </p>
          ) : (
            <p className="login-footer">Authorized personnel only. All access is logged.</p>
          )}
        </div>
      </div>
    );
  }

  // ── Account status gate ───────────────────────────────────────
  // Authenticated, but not cleared for entry. Render a dedicated holding
  // screen instead of the app shell — this is the enforcement point for
  // "permission changes take effect immediately": the live profile listener
  // (watchOwnProfile) updates user.accountStatus in real time, so an admin
  // flipping a user to Suspended/Deactivated locks them out on their very
  // next render, with no need to wait for a fresh login.
  if (user.accountStatus && user.accountStatus !== "Active") {
    const STATUS_COPY = {
      "Pending Approval": {
        heading: "Account Pending Approval",
        body: "Your account has been created and is awaiting administrator review. " +
              "You will gain access once an administrator approves your registration and assigns your role.",
        tone: "pending",
      },
      "Suspended": {
        heading: "Account Suspended",
        body: "Your access has been temporarily suspended by an administrator. " +
              "Contact your administrator if you believe this is in error.",
        tone: "blocked",
      },
      "Deactivated": {
        heading: "Account Deactivated",
        body: "This account has been deactivated and no longer has access to the platform. " +
              "Contact your administrator for assistance.",
        tone: "blocked",
      },
    };
    const copy = STATUS_COPY[user.accountStatus] || {
      heading: "Access Restricted",
      body: "Your account does not currently have access to the platform. Contact your administrator.",
      tone: "blocked",
    };

    return (
      <div className="login-screen">
        <div className={`login-card status-card status-card--${copy.tone}`} role="main">
          <div className="login-header">
            <img src={arimaLogo} alt="ARIMA Resources logo" className="login-logo" />
            <h1>{copy.heading}</h1>
          </div>
          <p className="status-card-body">{copy.body}</p>
          <p className="status-card-meta">Signed in as <strong>{user.email}</strong></p>
          <button type="button" className="login-btn" onClick={handleLogout}>
            Sign Out
          </button>
        </div>
      </div>
    );
  }

  return (
    <UserContext.Provider value={user}>
    <PermissionMatrixContext.Provider value={permissionMatrix}>
      <div className={`app-layout ${sidebarCollapsed ? "app-layout--collapsed" : ""}`}>
        {mobileSidebarOpen && (
          <div
            className="sidebar-backdrop sidebar-backdrop--visible"
            onClick={() => setMobileSidebarOpen(false)}
            aria-hidden="true"
          />
        )}

        <Sidebar
          collapsed={sidebarCollapsed}
          onToggle={() => setSidebarCollapsed((c) => !c)}
          isOpen={mobileSidebarOpen}
          onClose={() => setMobileSidebarOpen(false)}
        />

        <div className="app-main">
          <Header
            user={user}
            onLogout={handleLogout}
            onMenuToggle={() => setMobileSidebarOpen((v) => !v)}
            menuOpen={mobileSidebarOpen}
          />

          {profileSyncFailed && (
            <div className="profile-sync-banner" role="alert">
              <span>
                Your account profile could not be saved to the database after several attempts.
                You are signed in, but you may not appear in the Admin Panel until an administrator
                approves your registration from the <strong>Diagnostics</strong> tab.
              </span>
              <button
                className="profile-sync-banner__dismiss"
                onClick={() => setProfileSyncFailed(false)}
                aria-label="Dismiss"
              >×</button>
            </div>
          )}
          <main className="app-content">
            <Suspense fallback={<PageLoader />}>
              <Routes>
                <Route path="/" element={<Navigate to="/dashboard" replace />} />

                <Route
                  path="/dashboard"
                  element={
                    <GuardedRoute path="/dashboard">
                      <Dashboard />
                    </GuardedRoute>
                  }
                />
                <Route
                  path="/inventory"
                  element={
                    <GuardedRoute path="/inventory">
                      <Inventory />
                    </GuardedRoute>
                  }
                />
                <Route
                  path="/suppliers"
                  element={
                    <GuardedRoute path="/suppliers">
                      <Suppliers />
                    </GuardedRoute>
                  }
                />
                <Route
                  path="/stocktake"
                  element={
                    <GuardedRoute path="/stocktake">
                      <StockTake />
                    </GuardedRoute>
                  }
                />
                <Route
                  path="/reports"
                  element={
                    <GuardedRoute path="/reports">
                      <Reports />
                    </GuardedRoute>
                  }
                />
                <Route
                  path="/admin"
                  element={
                    <GuardedRoute path="/admin">
                      <AdminPanel />
                    </GuardedRoute>
                  }
                />

                <Route path="*" element={<Navigate to="/dashboard" replace />} />
              </Routes>
            </Suspense>
          </main>
        </div>
      </div>
    </PermissionMatrixContext.Provider>
    </UserContext.Provider>
  );
}

export default App;
