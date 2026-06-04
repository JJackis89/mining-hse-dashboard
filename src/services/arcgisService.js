/**
 * arcgisService.js
 * -----------------
 * Centralised helper for querying ArcGIS Feature Services.
 *
 * LAYER INVENTORY (ARIMA_1_WFL1 FeatureServer):
 *   0  CENTROID             – single point (concession centroid)
 *   1  PILLARS              – 18 boundary pillars  (lat, lon, name)
 *   2  BUFFER               – 5 km buffer polygon  (BUFF_DIST, Shape__Area)
 *   3  CONCESSION           – concession boundary  (Area sqkm, Shape__Area)
 *  14  CAMP_AND_MINE_OFFICE – polygon              (Area acres)
 *  15  WORKERS_CAMP         – polygon              (Area sqm)
 *  16  SENIOR_CAMP          – polygon              (Area sqm)
 *  17  GARLAND_PATH         – polyline             (Length km)
 *
 * ACTIVE SURVEY123 LAYERS:
 *   Materials Receipt Form   (MATERIALS_URL)
 *
 * PLANNED SURVEY123 INTEGRATION:
 *   Drone & Survey Operations Form  (DRONE_SURVEY_URL — set after form creation)
 */

const BASE_WFL =
  "https://services6.arcgis.com/Av3KhOzUMUMSORVt/arcgis/rest/services/ARIMA_1_WFL1/FeatureServer";

const MATERIALS_URL =
  "https://services6.arcgis.com/Av3KhOzUMUMSORVt/arcgis/rest/services/survey123_980a896720d440ad8ed1e246edc90755/FeatureServer/0";

// Set this to your Survey123 form URL once the Drone & Survey Operations
// form has been published in ArcGIS Online.
const DRONE_SURVEY_URL = null;

// Work Schedule & Progress Monitoring — Survey123 form
const WORK_SCHEDULE_URL =
  "https://services6.arcgis.com/Av3KhOzUMUMSORVt/arcgis/rest/services/survey123_21f01ce4d65b496ab0cb34760ddbc2ce/FeatureServer/0";

// Named layer indices — avoids hard-coded magic numbers throughout the file
export const LAYERS = {
  CENTROID:             0,
  PILLARS:              1,
  BUFFER:               2,
  CONCESSION:           3,
  CAMP_AND_MINE_OFFICE: 14,
  WORKERS_CAMP:         15,
  SENIOR_CAMP:          16,
  GARLAND_PATH:         17,
};

const FETCH_TIMEOUT_MS = 15_000;
const MAX_RETRIES      = 2;

// ─── Resilient fetch ─────────────────────────────────────────
// Retries on network failures and 5xx with exponential backoff.
// Does NOT retry 4xx responses or ArcGIS application errors (data.error).
async function resilientFetch(url, options = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timerId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timerId);
      if (!res.ok && res.status < 500) return res; // 4xx — pass through
      if (!res.ok) throw new Error(`Server error ${res.status}`);
      return res;
    } catch (err) {
      clearTimeout(timerId);
      if (err.name === "AbortError") throw new Error("Request timed out");
      lastErr = err;
      if (attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
      }
    }
  }
  throw lastErr;
}

// ─── Generic query helper ────────────────────────────────────
export async function queryFeatures(url, {
  where = "1=1",
  outFields = "*",
  returnGeometry = false,
  orderBy = "",
  resultRecordCount = "",
} = {}) {
  const params = new URLSearchParams({
    where,
    outFields,
    returnGeometry: String(returnGeometry),
    f: "json",
  });
  if (orderBy) params.set("orderByFields", orderBy);
  if (resultRecordCount) params.set("resultRecordCount", String(resultRecordCount));

  const res = await resilientFetch(`${url}/query?${params}`, { cache: "no-store" });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "ArcGIS query failed");
  return returnGeometry
    ? data.features?.map((f) => ({ ...f.attributes, _geometry: f.geometry })) ?? []
    : data.features?.map((f) => f.attributes) ?? [];
}

async function queryCount(url, where = "1=1") {
  const params = new URLSearchParams({ where, returnCountOnly: "true", f: "json" });
  const res = await resilientFetch(`${url}/query?${params}`, { cache: "no-store" });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.count ?? 0;
}

// ─── WFL1 Layer helpers ──────────────────────────────────────
export const getPillars = () =>
  queryFeatures(`${BASE_WFL}/${LAYERS.PILLARS}`, { outFields: "name,lat,lon", orderBy: "OBJECTID" });

export const getConcession = () =>
  queryFeatures(`${BASE_WFL}/${LAYERS.CONCESSION}`, { outFields: "Area,Shape__Area,Shape__Length" });

export const getBuffer = () =>
  queryFeatures(`${BASE_WFL}/${LAYERS.BUFFER}`, { outFields: "BUFF_DIST,Shape__Area,Shape__Length" });

export const getCampOffice = () =>
  queryFeatures(`${BASE_WFL}/${LAYERS.CAMP_AND_MINE_OFFICE}`, { outFields: "Id,Area,Shape__Area,Shape__Length" });

export const getWorkersCamp = () =>
  queryFeatures(`${BASE_WFL}/${LAYERS.WORKERS_CAMP}`, { outFields: "Id,Area,Shape__Area,Shape__Length" });

export const getSeniorCamp = () =>
  queryFeatures(`${BASE_WFL}/${LAYERS.SENIOR_CAMP}`, { outFields: "Id,Area,Shape__Area,Shape__Length" });

export const getGarlandPath = () =>
  queryFeatures(`${BASE_WFL}/${LAYERS.GARLAND_PATH}`, { outFields: "Id,Length,Shape__Length" });

// ─── Materials Receipt (Survey123) ───────────────────────────
export const getMaterials = () =>
  queryFeatures(MATERIALS_URL, {
    outFields: "objectid,date_time_received,material_name,category,unit,unit_cost,quantity_received,received_by,remarks,photos,CreationDate",
    orderBy: "date_time_received DESC",
  });

export const getMaterialsCount = () => queryCount(MATERIALS_URL);

export async function getMaterialAttachments(objectId) {
  const res = await resilientFetch(`${MATERIALS_URL}/${objectId}/attachments?f=json`, { cache: "no-store" });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return (data.attachmentInfos || []).map((a) => ({
    id: a.id,
    name: a.name,
    contentType: a.contentType,
    url: `${MATERIALS_URL}/${objectId}/attachments/${a.id}`,
  }));
}

// ─── Drone & Survey Operations (Survey123) ───────────────────
// Returns live submissions once DRONE_SURVEY_URL is set.
// Fields should match whatever fields your Survey123 form publishes.
// Expected fields (configure to match your form):
//   objectid, CreationDate, operator_name, operation_type,
//   equipment_id, area_covered, datum, flight_date,
//   status, remarks, latitude, longitude
export async function getDroneSurveySubmissions(sinceHoursAgo = 720) {
  if (!DRONE_SURVEY_URL) return [];
  const since = Date.now() - sinceHoursAgo * 60 * 60 * 1000;
  return queryFeatures(DRONE_SURVEY_URL, {
    where: `CreationDate >= ${since}`,
    outFields: "objectid,CreationDate,operator_name,operation_type,equipment_id,area_covered,datum,flight_date,status,remarks",
    orderBy: "CreationDate DESC",
    returnGeometry: true,
  }).catch(() => []);
}

export const getDroneSurveyCount = () =>
  DRONE_SURVEY_URL ? queryCount(DRONE_SURVEY_URL).catch(() => 0) : Promise.resolve(0);

// ─── Work Schedule & Progress Monitoring (Survey123) ─────────
// Fetches all records from the Work Schedule form.
// outFields: "*" captures every field the form publishes so the
// page component can resolve field names flexibly.
export const getWorkSchedule = () =>
  queryFeatures(WORK_SCHEDULE_URL, {
    outFields: "*",
    orderBy: "CreationDate DESC",
  });

export const getWorkScheduleCount = () => queryCount(WORK_SCHEDULE_URL);

// ─── Recent submissions (notifications) ──────────────────────
// Polls both live Survey123 forms. Work Schedule always returns data;
// Drone & Survey returns data only after DRONE_SURVEY_URL is set.
export async function getRecentSubmissions(sinceHoursAgo = 24) {
  const since = Date.now() - sinceHoursAgo * 60 * 60 * 1000;
  const where = `CreationDate >= ${since}`;

  const [workRows, droneRows] = await Promise.all([
    queryFeatures(WORK_SCHEDULE_URL, {
      where,
      outFields: "objectid,CreationDate",
      orderBy: "CreationDate DESC",
      resultRecordCount: 50,
    }).catch(() => []),
    DRONE_SURVEY_URL
      ? queryFeatures(DRONE_SURVEY_URL, {
          where,
          outFields: "objectid,operator_name,operation_type,CreationDate",
          orderBy: "CreationDate DESC",
          resultRecordCount: 50,
          returnGeometry: true,
        }).catch(() => [])
      : Promise.resolve([]),
  ]);

  return [
    ...workRows.map((r) => ({ ...r, _type: "WorkSchedule" })),
    ...droneRows.map((r) => ({ ...r, _type: "DroneSurvey" })),
  ].sort((a, b) => (b.CreationDate || 0) - (a.CreationDate || 0));
}

// ─── Dashboard aggregate ─────────────────────────────────────
export async function getDashboardStats() {
  const [
    pillars,
    [concession],
    [campOffice],
    [workersCamp],
    [seniorCamp],
    [garlandPath],
    [buffer],
  ] = await Promise.all([
    getPillars(),
    getConcession(),
    getCampOffice(),
    getWorkersCamp(),
    getSeniorCamp(),
    getGarlandPath(),
    getBuffer(),
  ]);

  return {
    pillars,
    concession:  concession  || {},
    campOffice:  campOffice  || {},
    workersCamp: workersCamp || {},
    seniorCamp:  seniorCamp  || {},
    garlandPath: garlandPath || {},
    buffer:      buffer      || {},
    pillarCount: pillars.length,
  };
}
