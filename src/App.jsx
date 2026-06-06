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
  serverTimestamp,
} from "firebase/firestore";
import { auth, db } from "./firebase";
import { UserContext, useUser } from "./context/UserContext";
import { canAccess, ROUTE_ACCESS } from "./utils/permissions";

import arimaLogo from "./assets/arima-logo.png";

import Sidebar from "./components/Sidebar";
import Header from "./components/Header";

const MapViewer      = lazy(() => import("./pages/MapViewer"));
const Inventory      = lazy(() => import("./pages/Inventory"));
const DroneSurveyOps = lazy(() => import("./pages/DroneSurveyOps"));
const WorkSchedule   = lazy(() => import("./pages/WorkSchedule"));
const AdminPanel     = lazy(() => import("./pages/AdminPanel"));

import "./App.css";

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
  const user = useUser();
  if (!user || !canAccess(user.role, path)) {
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

  useEffect(() => {
    // Support comma-separated list of admin emails
    const ADMIN_EMAILS = (import.meta.env.VITE_FIRST_ADMIN_EMAIL ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);

    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      const t0  = Date.now();
      const iso = () => new Date().toISOString();
      console.log(`[ARIMA ${iso()}] onAuthStateChanged:`, firebaseUser ? firebaseUser.email : "signed out");

      if (firebaseUser) {
        const isDesignatedAdmin = ADMIN_EMAILS.includes(
          firebaseUser.email.toLowerCase()
        );

        const onSyncFail = () => setProfileSyncFailed(true);

        if (isDesignatedAdmin) {
          const capturedName = signupFullNameRef.current;
          signupFullNameRef.current = "";
          writeProfileRetrying(firebaseUser.uid, {
            uid:           firebaseUser.uid,
            email:         firebaseUser.email,
            fullName:      capturedName,
            role:          "admin",
            department:    "",
            rank:          "",
            accountStatus: "Active",
            createdAt:     serverTimestamp(),
            lastLogin:     serverTimestamp(),
          }, onSyncFail);
          setUser({ email: firebaseUser.email, uid: firebaseUser.uid, role: "admin" });
          setAuthLoading(false);
          console.log(`[ARIMA ${iso()}] Auth resolved in ${Date.now() - t0}ms (admin)`);
          return;
        }

        let role = "viewer";
        try {
          // Promise.allSettled so a permission-denied on pendingRoles never
          // crashes the entire read — we fall back gracefully to viewer role.
          console.log(`[ARIMA ${iso()}] Starting parallel reads…`);
          const t1 = Date.now();
          const [roleResult, pendingResult] = await Promise.allSettled([
            getDoc(doc(db, "userRoles",    firebaseUser.uid)),
            getDoc(doc(db, "pendingRoles", firebaseUser.email)),
          ]);
          console.log(
            `[ARIMA ${iso()}] Reads done in ${Date.now() - t1}ms —`,
            `roleStatus=${roleResult.status} pendingStatus=${pendingResult.status}`
          );

          // If the critical userRoles read itself failed, re-throw to the catch block.
          if (roleResult.status === "rejected") throw roleResult.reason;

          const roleSnap    = roleResult.value;
          const pendingSnap = pendingResult.status === "fulfilled" ? pendingResult.value : null;

          if (roleSnap.exists()) {
            role = roleSnap.data().role ?? "viewer";
            signupFullNameRef.current = "";
            const existing = roleSnap.data();
            const updates  = { lastLogin: serverTimestamp() };
            if (!Object.prototype.hasOwnProperty.call(existing, "accountStatus")) {
              updates.uid           = firebaseUser.uid;
              updates.fullName      = existing.fullName   || "";
              updates.department    = existing.department || "";
              updates.rank          = existing.rank       || "";
              updates.accountStatus = "Active";
            }
            // lastLogin update — single attempt, not worth retrying
            setDoc(doc(db, "userRoles", firebaseUser.uid), updates, { merge: true })
              .catch((err) =>
                console.error(`[ARIMA ${iso()}] lastLogin update failed:`, err.code, err.message)
              );
            console.log(`[ARIMA ${iso()}] Existing user role=${role}`);
          } else {
            // Brand-new user
            const capturedName = signupFullNameRef.current;
            signupFullNameRef.current = "";

            if (pendingSnap?.exists()) {
              role = pendingSnap.data().role ?? "viewer";
              deleteDoc(doc(db, "pendingRoles", firebaseUser.email))
                .catch((err) =>
                  console.warn(`[ARIMA ${iso()}] pendingRoles delete failed:`, err.code)
                );
            }

            console.log(`[ARIMA ${iso()}] New user — writing profile role=${role} name="${capturedName}"`);
            writeProfileRetrying(firebaseUser.uid, {
              uid:           firebaseUser.uid,
              email:         firebaseUser.email,
              fullName:      capturedName,
              role,
              department:    "",
              rank:          "",
              accountStatus: "Active",
              createdAt:     serverTimestamp(),
              lastLogin:     serverTimestamp(),
            }, onSyncFail);
          }
        } catch (err) {
          console.error(`[ARIMA ${iso()}] Read error:`, err.code, err.message);
          const recoveryName = signupFullNameRef.current;
          signupFullNameRef.current = "";
          writeProfileRetrying(firebaseUser.uid, {
            uid:           firebaseUser.uid,
            email:         firebaseUser.email,
            fullName:      recoveryName || "",
            role,
            department:    "",
            rank:          "",
            accountStatus: "Active",
            createdAt:     serverTimestamp(),
            lastLogin:     serverTimestamp(),
          }, onSyncFail);
        }

        setUser({ email: firebaseUser.email, uid: firebaseUser.uid, role });
      } else {
        setUser(null);
      }
      setAuthLoading(false);
      console.log(`[ARIMA ${iso()}] Auth complete in ${Date.now() - t0}ms`);
    });

    return unsubscribe;
  }, []);

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
            <p className="login-subtitle">Survey, Drone &amp; Inventory Platform</p>
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
              New accounts are assigned <strong>Viewer</strong> access by default.
              An administrator can upgrade your permissions.
            </p>
          ) : (
            <p className="login-footer">Authorized personnel only. All access is logged.</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <UserContext.Provider value={user}>
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
                <Route path="/" element={<Navigate to="/inventory" replace />} />

                <Route
                  path="/map"
                  element={
                    <GuardedRoute path="/map">
                      <MapViewer />
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
                  path="/operations"
                  element={
                    <GuardedRoute path="/operations">
                      <DroneSurveyOps />
                    </GuardedRoute>
                  }
                />
                <Route
                  path="/schedule"
                  element={
                    <GuardedRoute path="/schedule">
                      <WorkSchedule />
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

                <Route path="*" element={<Navigate to="/inventory" replace />} />
              </Routes>
            </Suspense>
          </main>
        </div>
      </div>
    </UserContext.Provider>
  );
}

export default App;
