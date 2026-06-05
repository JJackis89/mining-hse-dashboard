import { useState, useEffect, lazy, Suspense } from "react";
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

const Dashboard      = lazy(() => import("./pages/Dashboard"));
const MapViewer      = lazy(() => import("./pages/MapViewer"));
const Inventory      = lazy(() => import("./pages/Inventory"));
const DroneSurveyOps = lazy(() => import("./pages/DroneSurveyOps"));
const WorkSchedule   = lazy(() => import("./pages/WorkSchedule"));
const AdminPanel     = lazy(() => import("./pages/AdminPanel"));

import "./App.css";

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
    return <Navigate to="/" replace />;
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
  const [error, setError]               = useState("");
  const [loginLoading, setLoginLoading] = useState(false);
  const [isSignUp, setIsSignUp]         = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  useEffect(() => {
    // Support comma-separated list of admin emails
    const ADMIN_EMAILS = (import.meta.env.VITE_FIRST_ADMIN_EMAIL ?? "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);

    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        const isDesignatedAdmin = ADMIN_EMAILS.includes(
          firebaseUser.email.toLowerCase()
        );

        // Designated admins always get admin — Firestore write is a non-blocking side effect
        if (isDesignatedAdmin) {
          setDoc(
            doc(db, "userRoles", firebaseUser.uid),
            { email: firebaseUser.email, role: "admin", createdAt: serverTimestamp() },
            { merge: true }
          ).catch(() => {});
          setUser({ email: firebaseUser.email, uid: firebaseUser.uid, role: "admin" });
          setAuthLoading(false);
          return;
        }

        // For everyone else, look up their role from Firestore
        let role = "viewer";
        try {
          const roleSnap = await getDoc(doc(db, "userRoles", firebaseUser.uid));

          if (roleSnap.exists()) {
            role = roleSnap.data().role ?? "viewer";
          } else {
            // Check for a pending invite
            const pendingSnap = await getDoc(
              doc(db, "pendingRoles", firebaseUser.email)
            );
            if (pendingSnap.exists()) {
              role = pendingSnap.data().role ?? "viewer";
              await setDoc(doc(db, "userRoles", firebaseUser.uid), {
                email: firebaseUser.email,
                role,
                createdAt: serverTimestamp(),
              });
              await deleteDoc(doc(db, "pendingRoles", firebaseUser.email));
            } else {
              await setDoc(doc(db, "userRoles", firebaseUser.uid), {
                email: firebaseUser.email,
                role: "viewer",
                createdAt: serverTimestamp(),
              });
            }
          }
        } catch (err) {
          console.error("Firestore role lookup failed:", err.code, err.message);
        }
        setUser({ email: firebaseUser.email, uid: firebaseUser.uid, role });
      } else {
        setUser(null);
      }
      setAuthLoading(false);
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
    if (password !== confirmPass) {
      setError("Passwords do not match.");
      return;
    }
    setError("");
    setLoginLoading(true);
    try {
      await createUserWithEmailAndPassword(auth, email, password);
      // onAuthStateChanged fires next and creates the role document
    } catch (err) {
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

          <main className="app-content">
            <Suspense fallback={<PageLoader />}>
              <Routes>
                <Route path="/" element={<Dashboard />} />

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

                {/* Fallback: redirect unknown paths to dashboard */}
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Suspense>
          </main>
        </div>
      </div>
    </UserContext.Provider>
  );
}

export default App;
