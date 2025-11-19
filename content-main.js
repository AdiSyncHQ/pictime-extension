// content-main.js (MAIN world)
// just logs / exposes what the isolated script captured

(() => {
  if (window.__pts_main_installed) return;
  window.__pts_main_installed = true;

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const data = ev.data;
    if (!data || data.type !== 'PTS_CAPTURE_FROM_ISOLATED') return;

    console.log('[PTS main] capture from isolated:', data.payload?.meta);
    try {
      window.__pts_lastCapture = data.payload;
    } catch (_) {
      // ignore
    }
  });
})();
