// content-isolated.js
// ISOLATED world
// - Posts dashboard on load (unchanged)
// - Responds to FETCH_PROJECT_PHOTOS for "Download" (unchanged)
// - Responds to FETCH_AND_TRANSFER for "Transfer", sends metadata to background

(() => {
  if (window.__pts_bridge_activePoster) return;
  window.__pts_bridge_activePoster = true;

  const ORIGIN = location.origin; // e.g. https://pulkit.pic-time.com
  const DASHBOARD_URL = `${ORIGIN}/!servicesp.asmx/dashboard`;
  const PROJECT_PHOTOS_URL = `${ORIGIN}/!servicesp.asmx/projectPhotos2`;

  const LS_KEY = "pts_last_capture";
  const VPATH_CACHE = {};
  const VPATH_LS_PREFIX = "pts_vpath_";

  function headersToObject(headers) {
    const out = {};
    try {
      headers?.forEach?.((v, k) => (out[k] = v));
    } catch (_) {}
    return out;
  }

  // ---------- 1) DASHBOARD POST ON LOAD ----------
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
    try {
      json = text ? JSON.parse(text) : null;
    } catch (_) {}

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

    try {
      chrome.runtime.sendMessage({ type: "PTS_CAPTURE", payload });
    } catch (e) {
      console.warn("[PTS isolated] could not send PTS_CAPTURE to background:", e);
    }

    try {
      window.postMessage({ type: "PTS_CAPTURE_FROM_ISOLATED", payload }, "*");
    } catch (_) {}

    try {
      chrome.storage.local.set({ [LS_KEY]: payload });
    } catch (_) {}

    return payload;
  }

  function kickDashboard() {
    setTimeout(() => {
      postDashboard().catch(err =>
        console.error("[PTS isolated] dashboard POST failed:", err)
      );
    }, 100);
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    kickDashboard();
  } else {
    document.addEventListener("DOMContentLoaded", kickDashboard, { once: true });
  }

  // ---------- 2) HELPERS FOR VIRTUAL PATH / HI-RES URL ----------

  async function getProjectInfo(projectId) {
    const key = `${VPATH_LS_PREFIX}${projectId}`;
  
    // 1) Check local cache (object only)
    if (VPATH_CACHE[projectId]) {
      return VPATH_CACHE[projectId];
    }
  
    // 2) Check storage (ensure it's an object)
    try {
      const data = await chrome.storage.local.get(key);
      const stored = data[key];
      if (stored && typeof stored === "object" && stored.virtualPath) {
        VPATH_CACHE[projectId] = stored;
        return stored;
      }
    } catch (err) {
      console.warn("storage read failed", err);
    }
  
    // 3) Fresh fetch
    const res = await fetch(`${ORIGIN}/!servicesp.asmx/loadProject`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ projectId })
    });
  
    if (!res.ok) throw new Error("loadProject failed " + res.status);
    const json = await res.json();
  
    const projectInfo = {
      virtualPath: json?.d?.virtualPath || null,
      fullMetadata: json?.d || {}  // FULL metadata is here!
    };
  
    console.log("✔ FULL PROJECT METADATA FETCHED:", projectInfo.fullMetadata);
  
    // 4) Save correct object to cache and storage
    VPATH_CACHE[projectId] = projectInfo;
    try {
      await chrome.storage.local.set({ [key]: projectInfo });
    } catch (_) {}
  
    return projectInfo;
  }
  
  
  function buildHiresUrl(virtualPath, photoId) {
    const vp = encodeURIComponent(virtualPath);
    return `${ORIGIN}/-${vp}/download?mode=hiresphoto&photoId=${encodeURIComponent(
      photoId
    )}&systemName=pictime&gui=yes&accessToken=`;
  }

  // ---------- 3) OLD: DOWNLOAD PIPELINE (Download button) ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "FETCH_PROJECT_PHOTOS") return;

    (async () => {
      const { projectId, count } = msg;
      try {
        const { virtualPath } = await getProjectInfo(projectId);


        const body = JSON.stringify({ projectId, photoIds: null });
        const res = await fetch(PROJECT_PHOTOS_URL, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body
        });

        if (!res.ok) {
          throw new Error(`projectPhotos2 failed: ${res.status} ${res.statusText}`);
        }

        const json = await res.json();
        const photos = json?.d?.photos_s || [];

        const allIds = photos.map(p => p?.[1]).filter(Boolean);
        const limit = Math.min(allIds.length, Number(count || allIds.length));
        const selectedIds = allIds.slice(0, limit);

        let imageUrls = selectedIds.map(id => buildHiresUrl(virtualPath, id));
        imageUrls = [...new Set(imageUrls)];

        chrome.runtime.sendMessage({
          type: "PTS_DOWNLOAD_READY",
          payload: { imageUrls, projectId, virtualPath }
        });

        sendResponse?.({ ok: true, count: imageUrls.length, virtualPath });
      } catch (err) {
        console.error("[PTS isolated] FETCH_PROJECT_PHOTOS (hires) error:", err);
        chrome.runtime.sendMessage({
          type: "PTS_DOWNLOAD_READY",
          payload: { imageUrls: [], error: String(err) }
        });
        sendResponse?.({ ok: false, error: String(err) });
      }
    })();

    return true;
  });

  // ---------- 4) NEW: TRANSFER PIPELINE (Transfer button) ----------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "FETCH_AND_TRANSFER") return;

    (async () => {
      try {
        const { projectId, count, albumName } = msg;

        const { virtualPath, fullMetadata } = await getProjectInfo(projectId);
        console.log("********FULL META DATA FETCHED:", fullMetadata)

        const body = JSON.stringify({ projectId, photoIds: null });
        const res = await fetch(PROJECT_PHOTOS_URL, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body
        });
        const json = await res.json();

        const photos_s = json?.d?.photos_s || [];
        const scenes_s = json?.d?.scenes_s || [];

        const sceneMap = {};
        scenes_s.forEach(s => {
          const name = s[0];
          const sceneId = s[1];
          sceneMap[sceneId] = name;
        });

        const allPhotos = photos_s.map(p => ({
          filename: `${p[0]}.jpg`,
          photoId: p[1],
          scene: sceneMap[p[4]] || "Unknown",
          url: buildHiresUrl(virtualPath, p[1])
        }));

        let selected;
        const failedFilenames = Array.isArray(msg.failedFilenames)
          ? msg.failedFilenames
          : null;

        if (failedFilenames && failedFilenames.length) {
          // RETRY MODE: only photos whose filename is in failedFilenames
          const set = new Set(failedFilenames);
          selected = allPhotos.filter(p => set.has(p.filename));
        } else {
          // NORMAL MODE: first N photos
          selected = allPhotos.slice(0, count);
        }

        // Hand off to background: metadata + URLs only
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
        console.error("FETCH_AND_TRANSFER error:", err);
        sendResponse?.({ ok: false, error: String(err) });
      }
    })();

    return true;
  });
})();
