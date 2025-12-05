// content-main.js (MAIN world)
// Logs / exposes what the isolated script captured
// AND handles unBlockMe execution in the native context

(() => {
  if (window.__pts_main_installed) return;
  window.__pts_main_installed = true;

  function log(msg, data) {
    console.log(`%c[Pic-Time Sniffer] ${msg}`, "background: #6366f1; color: white; padding: 2px 4px; border-radius: 2px;", data || "");
  }

  // 1. Listen for Capture (Existing)
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const data = ev.data;

    // Existing capture logic
    if (data && data.type === 'PTS_CAPTURE_FROM_ISOLATED') {
      // console.log('[PTS main] capture from isolated:', data.payload?.meta);
      try { window.__pts_lastCapture = data.payload; } catch (_) {}
    }

    // 2. NEW: Listen for Unblock Request
    if (data && data.type === 'PTS_RUN_UNBLOCK') {
      log("🚨 CAPTCHA/BLOCK DETECTED! Attempting to resolve...");
      
      if (typeof window.unBlockMe === 'function') {
        log("Executing unBlockMe()...");
        try {
          window.unBlockMe();
          log("✅ unBlockMe() executed successfully.");
        } catch (err) {
          console.error("[Pic-Time Sniffer] ❌ unBlockMe() threw an error:", err);
        }
      } else {
        console.error("[Pic-Time Sniffer] ❌ unBlockMe function NOT FOUND on window object.");
        // Attempt to find the modal button as a fallback?
        const btn = document.querySelector(".blocked-user-modal button, #unblockBtn"); // Pseudo-selector example
        if(btn) {
            log("Found unblock button in DOM, clicking...");
            btn.click();
        }
      }
    }
  });
})();