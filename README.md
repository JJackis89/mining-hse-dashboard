# ARIMA Resources Operations Platform

A React web dashboard for mining and HSE operations. Integrates with ArcGIS Feature Services (boundary pillars, concession, infrastructure) and Survey123 forms (incidents, environmental monitoring, materials receipts).

## Stack

| Layer | Technology |
| --- | --- |
| UI | React 19 + Vite |
| Auth | Firebase Authentication (email/password) |
| Geospatial data | ArcGIS Feature Services |
| Charts | Recharts |
| Routing | React Router v7 |
| Tests | Vitest + Testing Library |

---

## Prerequisites

- Node.js 18+
- A Firebase project with **Email/Password authentication** enabled
- Access to the ARIMA ArcGIS Feature Services (existing URLs in `src/services/arcgisService.js`)

---

## Setup

### 1. Clone and install dependencies

```bash
git clone <repo-url>
cd mining-hse-dashboard
npm install
```

### 2. Configure environment variables

```bash
cp .env.example .env.local
```

Edit `.env.local` and fill in your Firebase project values (found in **Firebase Console → Project Settings → Your apps**).

> The ArcGIS Feature Service URLs are hardcoded in `src/services/arcgisService.js` and do not require environment variables.

### 3. Start the dev server

```bash
npm run dev
```

The app runs at [http://localhost:8009](http://localhost:8009).

---

## Available Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Start development server (port 8009) |
| `npm run build` | Production build to `dist/` |
| `npm run preview` | Preview the production build locally |
| `npm run lint` | Run ESLint |
| `npm test` | Run all unit tests once |
| `npm run test:watch` | Run tests in watch mode |

---

## Project Structure

```text
src/
├── assets/              Static images (logo, etc.)
├── components/
│   ├── Header.jsx       Top bar — clock, user info, notifications, logout
│   ├── NotificationBell.jsx  Polls ArcGIS for new submissions every 15s
│   └── Sidebar.jsx      Collapsible navigation with grouped sections
├── pages/
│   ├── Dashboard.jsx    KPI cards + charts + paginated receipts table
│   ├── DroneOps.jsx     UAV fleet, missions, processing  [demo data]
│   ├── Environment.jsx  Environmental monitoring records
│   ├── Incidents.jsx    HSE incident register
│   ├── Infrastructure.jsx  Site infrastructure cards
│   ├── Inventory.jsx    Materials receipts + photo viewer + pagination
│   ├── MapViewer.jsx    Embedded ArcGIS Experience
│   ├── Pillars.jsx      Boundary pillar register
│   └── SurveyOps.jsx   Survey projects + control points  [demo data]
├── services/
│   └── arcgisService.js  All ArcGIS + Survey123 API calls.
│                         LAYERS constants, 15s timeout, 2-retry backoff.
│                         Async stubs for DroneOps/SurveyOps demo data.
├── styles/              Modular CSS (all imported by App.css)
│   ├── variables.css    CSS custom properties / design tokens
│   ├── login.css        Login screen
│   ├── layout.css       App shell, sidebar, header, notification bell
│   ├── components.css   Panels, tables, pagination, filters, badges
│   ├── dashboard.css    Dashboard-specific styles
│   ├── pages.css        All page-specific styles
│   └── states.css       Loading, empty, error states
├── test/
│   ├── setup.js                  jest-dom matchers
│   ├── arcgisService.test.js     queryFeatures, LAYERS, retry behaviour
│   └── inventoryFilter.test.js   Filter + pagination logic
└── utils/
    └── exportCsv.js     CSV export helper
```

---

## Architecture Notes

### Data flow

All ArcGIS queries go through `arcgisService.js`. Every fetch has a **15-second timeout** and **2 automatic retries** (exponential backoff) on network failures and 5xx errors. 4xx errors and ArcGIS application errors (returned in the JSON body) are not retried.

### Authentication

Firebase `onAuthStateChanged` manages session state in `App.jsx`. The app renders a full-page spinner until the auth state resolves, preventing a flash of the login screen on reload.

### Code splitting

All pages are loaded with `React.lazy()` inside a `<Suspense>` boundary. Each page's JavaScript loads only when the user first navigates to that route.

### Demo data pages

**DroneOps** and **SurveyOps** display representative sample data, marked with a visible **Demo Data** badge. Their data is served via async functions in `arcgisService.js` (`getDroneFleet`, `getSurveyProjects`, etc.) so the mock can be replaced with real ArcGIS calls without touching the page components.

---

## Deployment

### Firebase Hosting (recommended)

```bash
npm run build
firebase deploy --only hosting
```

Ensure `firebase.json` has a SPA rewrite rule:

```json
{
  "hosting": {
    "public": "dist",
    "rewrites": [{ "source": "**", "destination": "/index.html" }]
  }
}
```

### Other static hosts (Netlify, Vercel, etc.)

Point the publish directory to `dist/` and configure all routes to rewrite to `/index.html`.

---

## Environment Variables

See [`.env.example`](.env.example) for the full list. All variables are prefixed `VITE_` so Vite includes them in the client bundle.

> **Firebase API keys in the browser**: Firebase web keys are intentionally public — they identify the project but grant no elevated access. Security is enforced by Firebase Authentication rules and Firestore/Database security rules server-side.
