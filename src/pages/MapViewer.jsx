const EXPERIENCE_URL =
  "https://experience.arcgis.com/experience/a7e5c3c8537a438e9c1c002ca439762f";

function MapViewer() {
  return (
    <div className="page-map">
      <iframe
        src={EXPERIENCE_URL}
        title="ARIMA Map Experience"
        className="experience-frame"
        allowFullScreen
        aria-label="Interactive site map"
      />
    </div>
  );
}

export default MapViewer;
