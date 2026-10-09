// Cross-origin isolation for static hosts that can't set COOP/COEP headers
// (e.g. GitHub Pages): register coi-sw.js, which adds the headers to every
// response, then reload once so the page itself is served through it.
(() => {
  if (self.crossOriginIsolated || !self.isSecureContext || !("serviceWorker" in navigator)) return;
  const KEY = "coi-reloaded";
  let reloaded = false;
  try { reloaded = sessionStorage.getItem(KEY) === "1"; } catch {}
  navigator.serviceWorker.register("coi-sw.js").then(
    (reg) => {
      if (reloaded) return; // already tried once this session; don't loop
      const reload = () => {
        try { sessionStorage.setItem(KEY, "1"); } catch {}
        location.reload();
      };
      if (reg.active && navigator.serviceWorker.controller) reload();
      else navigator.serviceWorker.addEventListener("controllerchange", reload, { once: true });
    },
    (err) => console.error("coi service worker registration failed", err),
  );
})();
