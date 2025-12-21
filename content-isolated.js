// ============================================================================
// content-isolated.js
// Runs in ISOLATED world
// Responsibilities:
//   • Auto-POST Pic-Time dashboard on load
//   • Handle DOWNLOAD: FETCH_PROJECT_PHOTOS
//   • Handle TRANSFER: FETCH_AND_TRANSFER
//   • CAPTCHA detection (empty metadata / zero-photo responses)
//   • Communicate CAPTCHA_OCCURRED / CAPTCHA_ZERO_PHOTO to background.js
//   • Provide VERIFY_PROJECT_METADATA and SHOW_CAPTCHA_FAILED_ALERT endpoints
//
// *** NO LOGIC HAS BEEN CHANGED — only structure, grouping, and comments added ***
// ============================================================================

(() => {

  // ==========================================================================
  // SECTION 0 — GUARD AGAINST MULTIPLE INJECTIONS
  // ==========================================================================

  if (window.__pts_bridge_activePoster) {
    console.warn("[PTS Isolated] Duplicate content script detected, aborting init.");
    return;
  }
  window.__pts_bridge_activePoster = true;

  // ==========================================================================
  // SECTION 1 — CONSTANTS & UTILITIES
  // ==========================================================================

  const ORIGIN = location.origin;

  // API endpoints
  const DASHBOARD_URL = `${ORIGIN}/!servicesp.asmx/dashboard`;
  const PROJECT_PHOTOS_URL = `${ORIGIN}/!servicesp.asmx/projectPhotos2`;

  // Local-storage keys
  const LS_KEY = "pts_last_capture";
  const VPATH_CACHE = {};
  const VPATH_LS_PREFIX = "pts_vpath_";

  // Logging helpers
  const log = (...a) => console.log("[PTS Isolated]", ...a);
  const warn = (...a) => console.warn("[PTS Isolated]", ...a);
  const errorLog = (...a) => console.warn("[PTS Isolated]", ...a);

  // Convert fetch headers → object
  const headersToObject = h => {
    const o = {};
    try { h?.forEach?.((v, k) => (o[k] = v)); } catch (_) {}
    return o;
  };

  // ==========================================================================
  // SECTION 2 — DASHBOARD POST ON LOAD (PTS_CAPTURE)
  // ==========================================================================

  async function postDashboard() {
    const started = performance.now();

    const resp = await fetch(DASHBOARD_URL, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({})
    });

    const ended = performance.now();
    const text = await resp.clone().text().catch(() => null);

    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) {}

    const payload = {
      meta: {
        origin: "isolated-content-script",
        url: DASHBOARD_URL,
        method: "POST",
        status: resp.status,
        statusText: resp.statusText,
        headers: headersToObject(resp.headers),
        timingMs: Math.round(ended - started),
        capturedAt: Date.now()
      },
      bodyText: text,
      bodyJson: json
    };

    // Send to background, to main world, and store locally
    try { chrome.runtime.sendMessage({ type: "PTS_CAPTURE", payload }); } catch (_) {}
    try { window.postMessage({ type: "PTS_CAPTURE_FROM_ISOLATED", payload }, "*"); } catch (_) {}
    try { chrome.storage.local.set({ [LS_KEY]: payload }); } catch (_) {}

    return payload;
  }

  // Fire dashboard POST after load
  const kickDashboard = () =>
    setTimeout(() => {
      postDashboard().catch(e => errorLog("dashboard POST failed:", e));
    }, 100);

  if (document.readyState === "complete" || document.readyState === "interactive") {
    kickDashboard();
  } else {
    document.addEventListener("DOMContentLoaded", kickDashboard, { once: true });
  }

  // ==========================================================================
  // SECTION 3 — PROJECT INFO HELPER + CAPTCHA EMPTY-METADATA DETECTION
  // ==========================================================================

  async function getProjectInfo(projectId) {
    const key = `${VPATH_LS_PREFIX}${projectId}`;
    log("getProjectInfo() called for projectId:", projectId);

    // (A) RAM cache
    if (VPATH_CACHE[projectId]) {
      log("Using in-memory projectInfo for", projectId);
      return VPATH_CACHE[projectId];
    }

    // (B) Persistent storage cache
    try {
      const data = await chrome.storage.local.get(key);
      const stored = data[key];

      if (stored?.virtualPath) {
        log("Using cached projectInfo for", projectId);
        VPATH_CACHE[projectId] = stored;
        return stored;
      }
    } catch (err) {
      warn("Storage read failed:", err);
    }

    // (C) Fetch fresh metadata
    const res = await fetch(`${ORIGIN}/!servicesp.asmx/loadProject`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ projectId })
    });

    if (!res.ok) {
      errorLog("loadProject failed:", res.status);
      throw new Error("loadProject failed " + res.status);
    }

    const json = await res.json().catch(e => {
      errorLog("Failed to parse loadProject JSON:", e);
      throw e;
    });

    const metadata = json?.d;
    const empty = !metadata || (typeof metadata === "object" && Object.keys(metadata).length === 0);

    // *** CAPTCHA: METADATA EMPTY ***
    if (empty || !metadata.virtualPath) {
      errorLog("🚨 METADATA_EMPTY_BLOCK detected for project:", projectId);

      try { chrome.runtime.sendMessage({ type: "CAPTCHA_OCCURRED" }); } catch (_) {}
      throw new Error("METADATA_EMPTY_BLOCK");
    }

    const out = {
      virtualPath: metadata.virtualPath,
      fullMetadata: metadata
    };

    log("✔ FULL PROJECT METADATA FETCHED:", out.fullMetadata);

    VPATH_CACHE[projectId] = out;

    try { await chrome.storage.local.set({ [key]: out }); } catch (_) {}

    return out;
  }

  // Construct hi-res URL
  const buildHiresUrl = (virtualPath, photoId) =>
    `${ORIGIN}/-${encodeURIComponent(virtualPath)}/download?mode=hiresphoto&photoId=${encodeURIComponent(photoId)}&systemName=pictime&gui=yes&accessToken=`;


  // ==========================================================================
  // SECTION 4 — TRIGGER_CAPTCHA_FIX (background → isolated → main)
  // ==========================================================================

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === "TRIGGER_CAPTCHA_FIX") {
      log("Received TRIGGER_CAPTCHA_FIX → forwarding PTS_RUN_UNBLOCK");

      try { window.postMessage({ type: "PTS_RUN_UNBLOCK" }, "*"); } catch (_) {}

      sendResponse?.({ ok: true });
      return true;
    }
  });

  // ==========================================================================
  // SECTION 5 — FETCH_PROJECT_PHOTOS (Download workflow)
  // ==========================================================================

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "FETCH_PROJECT_PHOTOS") return;

    (async () => {
      const { projectId, count } = msg;
      let imageUrls = [];

      try {
        const { virtualPath } = await getProjectInfo(projectId);

        // Request photo list
        const res = await fetch(PROJECT_PHOTOS_URL, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify({ projectId, photoIds: null })
        });

        if (!res.ok) throw new Error("projectPhotos2 failed " + res.status);

        const json = await res.json();
        const photos_s = json?.d?.photos_s || [];

        log("FETCH_PROJECT_PHOTOS length:", photos_s.length);

        // *** CAPTCHA ZERO-PHOTO DETECTION ***
        if (photos_s.length === 0) {
          warn("🚨 ZERO-PHOTO CAPTCHA DETECTED in DOWNLOAD:", { projectId });
          try { chrome.runtime.sendMessage({ type: "CAPTCHA_ZERO_PHOTO" }); } catch (_) {}
          throw new Error("ZERO_PHOTO_CAPTCHA_BLOCK");
        }

        // Extract IDs
        const allIds = photos_s.map(p => p?.[1]).filter(Boolean);
        const limit = Math.min(allIds.length, Number(count || allIds.length));
        const selected = allIds.slice(0, limit);

        imageUrls = [...new Set(selected.map(id => buildHiresUrl(virtualPath, id)))];

        // Notify background to download
        chrome.runtime.sendMessage({
          type: "PTS_DOWNLOAD_READY",
          payload: { imageUrls, projectId, virtualPath }
        });

        sendResponse?.({ ok: true, count: imageUrls.length, virtualPath });

      } catch (err) {
        errorLog("FETCH_PROJECT_PHOTOS error:", err);

        if (String(err).includes("METADATA_EMPTY_BLOCK")) {
          try { chrome.runtime.sendMessage({ type: "CAPTCHA_OCCURRED" }); } catch (_) {}
        }

        chrome.runtime.sendMessage({
          type: "PTS_DOWNLOAD_READY",
          payload: { imageUrls: [], error: String(err) }
        });

        sendResponse?.({ ok: false, error: String(err) });
      }
    })();

    return true;
  });

  // ==========================================================================
  // SECTION 6 — FETCH_AND_TRANSFER (Transfer workflow)
  // ==========================================================================

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "FETCH_AND_TRANSFER") return;

    (async () => {
      try {
        const { projectId, count, albumName, failedFilenames } = msg;
        log("FETCH_AND_TRANSFER:", { projectId, count, albumName });

        const { virtualPath, fullMetadata } = await getProjectInfo(projectId);

        // Fetch list of photos for the album
        const res = await fetch(PROJECT_PHOTOS_URL, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId, photoIds: null })
        });

        if (!res.ok) throw new Error("projectPhotos2 failed " + res.status);

        const json = await res.json();
        const photos_s = json?.d?.photos_s || [];

        // *** CAPTCHA ZERO-PHOTO DETECTION ***
        if (photos_s.length === 0) {
          warn("🚨 ZERO-PHOTO CAPTCHA DETECTED in TRANSFER:", { projectId });
          try { chrome.runtime.sendMessage({ type: "CAPTCHA_ZERO_PHOTO" }); } catch (_) {}
          throw new Error("ZERO_PHOTO_CAPTCHA_BLOCK");
        }

        const scenes_s = json?.d?.scenes_s || [];

        // Map sceneId → sceneName
        const sceneMap = {};
        scenes_s.forEach(s => (sceneMap[s[1]] = s[0]));

        // Build full photo objects
        const allPhotos = photos_s.map(p => ({
          filename: `${p[0]}`,
          photoId: p[1],
          scene: sceneMap[p[4]] || "Unknown",
          url: buildHiresUrl(virtualPath, p[1])
        }));

        // Retry mode vs normal mode
        let selected;
        if (Array.isArray(failedFilenames) && failedFilenames.length) {
          const set = new Set(failedFilenames);
          selected = allPhotos.filter(p => set.has(p.filename));
        } else {
          selected = allPhotos.slice(0, count);
        }

        // Trigger background.js upload pipeline
        chrome.runtime.sendMessage({
          type: "START_UPLOAD_BATCH",
          projectId,
          albumName,
          virtualPath,
          fullMetadata,
          photos: selected
        });

        sendResponse?.({ ok: true });

      } catch (err) {
        errorLog("FETCH_AND_TRANSFER error:", err);

        if (String(err).includes("METADATA_EMPTY_BLOCK")) {
          try { chrome.runtime.sendMessage({ type: "CAPTCHA_OCCURRED" }); } catch (_) {}
        }

        sendResponse?.({ ok: false, error: String(err) });
      }
    })();

    return true;
  });

  // ==========================================================================
  // SECTION 7 — VERIFY_PROJECT_METADATA + SHOW_CAPTCHA_FAILED_ALERT
  // ==========================================================================

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

    // Background asks: “Does loadProject metadata still empty?”
    if (msg?.type === "VERIFY_PROJECT_METADATA") {
      (async () => {
        const { projectId } = msg;

        try {
          const res = await fetch(`${ORIGIN}/!servicesp.asmx/loadProject`, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json; charset=utf-8" },
            body: JSON.stringify({ projectId })
          });

          const json = await res.json();
          const metadata = json?.d;
          const empty =
            !metadata ||
            (typeof metadata === "object" && Object.keys(metadata).length === 0);

          sendResponse?.({ ok: true, cleared: !empty });

        } catch (err) {
          sendResponse?.({ ok: false, error: String(err) });
        }
      })();

      return true;
    }

    // When CAPTCHA recovery failed after 3 cycles
    if (msg?.type === "SHOW_CAPTCHA_FAILED_ALERT") {
      alert(
        "Pic-Time captcha could not be bypassed after several attempts.\n" +
        "Please solve it manually, then restart your transfer."
      );
      sendResponse?.({ ok: true });
      return;
    }

  });

})(); // End IIFE
