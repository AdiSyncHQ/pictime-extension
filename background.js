// background.js
// Core background script for Pic-Time → GCP migration extension.

"use strict";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const AUTH_KEY = "pts_auth_token";
const DEFAULT_CONCURRENCY = 6; 
const KEY_CONCURRENCY = "pts_concurrency";
const JITTER_MIN = 150;
const JITTER_MAX = 350;
const MAX_RETRIES = 3;

const KEY_LAST = "pts_last";
const KEY_GALLERIES = "pts_galleries";
const KEY_HISTORY = "pts_history";
const KEY_TRANSFER = "pts_transfer_state";
const HISTORY_MAX = 20;
const KEY_LAST_RUN = "pts_last_run";
const KEY_ALL_FAILURES = "pts_all_failures";

const BACKEND_BASE = "https://pic-time-backend-448778667929.us-central1.run.app";

// -----------------------------------------------------------------------------
// Transfer state helpers
// -----------------------------------------------------------------------------

async function getAuthHeader() {
  const stored = await chrome.storage.local.get(AUTH_KEY);
  const token = stored[AUTH_KEY];
  if (!token) return {};
  return { "X-PT-Auth": token }; 
}

async function saveFinalRunSnapshot() {
  const st = (await chrome.storage.local.get(KEY_TRANSFER))[KEY_TRANSFER];
  await chrome.storage.local.set({ [KEY_LAST_RUN]: st });
}

async function resetTransferState() {
  const empty = {
    running: false,
    paused: false,        // <--- NEW
    pausedReason: null,   // <--- NEW ('user' or 'network')
    projectId: null,
    albumName: null,
    total: 0,
    completed: 0,
    successes: [], 
    failures: [], 
    startedAt: null,
    updatedAt: null,
    delayMs: 0,
    domain: null
  };

  await chrome.storage.local.set({ [KEY_TRANSFER]: empty });
  return empty;
}

async function updateTransferState(patch) {
  const prev = (await chrome.storage.local.get(KEY_TRANSFER))[KEY_TRANSFER] || {};
  const updated = { ...prev, ...patch, updatedAt: Date.now() };
  await chrome.storage.local.set({ [KEY_TRANSFER]: updated });
  return updated;
}

// Initialize transfer state at startup
resetTransferState();

// -----------------------------------------------------------------------------
// Utils
// -----------------------------------------------------------------------------

function log(...args) {
  console.log("[bg]", ...args);
}

function extractProjects(payload) {
  try {
    const root = payload?.bodyJson?.d || payload?.d;
    const list = root?.projects_s || [];
    return list.map(arr => ({
      name: arr?.[7] || arr?.[12] || "(unnamed)",
      mediaCount: arr?.[8] ?? 0,
      projectId: arr?.[9] ?? 0,
      token: arr?.[20] ?? arr?.[19] ?? "",
      raw: arr
    }));
  } catch (e) {
    console.error("[bg] extractProjects error:", e);
    return [];
  }
}

async function saveCapture(payload) {
  const ts = Date.now();
  const galleries = extractProjects(payload);

  try {
    const { [KEY_HISTORY]: history = [] } = await chrome.storage.local.get(KEY_HISTORY);
    const next = Array.isArray(history) ? history.slice(0) : [];
    next.unshift({ ts, galleries, payload });
    if (next.length > HISTORY_MAX) next.length = HISTORY_MAX;

    await chrome.storage.local.set({
      [KEY_LAST]: payload,
      [KEY_GALLERIES]: galleries,
      [KEY_HISTORY]: next
    });
  } catch (err) {
    console.error("[bg] saveCapture error:", err);
  }
}

async function fetchImageFromPicTime(url) {
  const res = await fetch(url, { method: "GET", credentials: "include" });
  if (!res.ok) throw new Error(`Pic-Time fetch failed: ${res.status} ${res.statusText}`);
  return await res.blob();
}

// -----------------------------------------------------------------------------
// NETWORK CHECKER & PAUSE BARRIER
// -----------------------------------------------------------------------------

/**
 * Lightweight check to see if internet is accessible.
 * Uses a no-cors HEAD request to Google (fast, reliable).
 */
async function checkInternetConnection() {
    if (!navigator.onLine) return false;
    try {
        // Random query param prevents caching
        await fetch(`https://www.google.com/favicon.ico?_=${Date.now()}`, { 
            method: 'HEAD', 
            mode: 'no-cors', 
            cache: 'no-store' 
        });
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * THE BARRIER:
 * Blocks execution inside the worker loop until:
 * 1. User unpauses manually.
 * 2. AND Internet connection is restored.
 */
// background.js - Replace the existing waitUntilResumedAndOnline function with this:

/**
 * THE SMART BARRIER:
 * 1. Checks connectivity.
 * 2. If User Paused -> Waits for user.
 * 3. If Offline -> Auto-pauses and loops until Online.
 * 4. If Online & was Network Paused -> Auto-resumes.
 */
async function waitUntilResumedAndOnline() {
  let isBlocked = true;
  
  while (isBlocked) {
      // 1. Get fresh state
      const state = (await chrome.storage.local.get(KEY_TRANSFER))[KEY_TRANSFER];
      
      // If transfer was cancelled completely (stopped), exit immediately
      if (!state || !state.running) return; 

      // 2. Check Network Status
      const isOnline = await checkInternetConnection();

      if (state.paused) {
          // --- SCENARIO A: CURRENTLY PAUSED ---

          if (state.pausedReason === 'user') {
              // Case: User clicked Pause. We MUST wait for user to click Resume.
              // We don't care about internet here, just wait.
              await new Promise(r => setTimeout(r, 1000));
              continue; 
          }

          if (state.pausedReason === 'network') {
              // Case: Paused because of internet. 
              if (isOnline) {
                  // ACTION: Internet is back! Auto-Resume!
                  console.log("[bg] Internet restored. Auto-resuming...");
                  await updateTransferState({ paused: false, pausedReason: null });
                  isBlocked = false; // Break the loop, continue upload
              } else {
                  // Still offline. Keep waiting.
                  await new Promise(r => setTimeout(r, 2000)); 
                  continue;
              }
          }
      } else {
          // --- SCENARIO B: CURRENTLY RUNNING ---
          
          if (!isOnline) {
              // ACTION: Internet dropped! Auto-Pause!
              console.warn("[bg] Network disruption detected. Pausing...");
              await updateTransferState({ paused: true, pausedReason: 'network' });
              await new Promise(r => setTimeout(r, 2000));
              continue;
          }

          // Internet is fine, user hasn't paused. Proceed.
          isBlocked = false;
      }
  }
}

// -----------------------------------------------------------------------------
// SIGNED-URL UPLOAD PIPELINE
// -----------------------------------------------------------------------------

async function processUploadsInParallel(photos, projectId, albumName, domain) {
  let state = (await chrome.storage.local.get(KEY_TRANSFER))[KEY_TRANSFER] || {};
  let successes = state.successes || [];
  let failures = state.failures || [];
  let completed = state.completed || 0;

  const delayMs = Number(state.delayMs) || 0;
  const effectiveDomain = domain || state.domain || null;

  // --- NEW LOGIC START ---
  // 1. Get the dynamic concurrency setting from storage
  const cVal = (await chrome.storage.local.get(KEY_CONCURRENCY))[KEY_CONCURRENCY];
  
  // 2. Use the stored value, or fall back to DEFAULT_CONCURRENCY (6)
  const activeConcurrency = Number(cVal) || DEFAULT_CONCURRENCY;
  // --- NEW LOGIC END ---

  function jitter() {
    const delay = JITTER_MIN + Math.random() * (JITTER_MAX - JITTER_MIN);
    return new Promise(resolve => setTimeout(resolve, delay));
  }

  async function uploadOne(photo, domainForPath) {
    const filename = photo.filename;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        // --- THE BARRIER ---
        await waitUntilResumedAndOnline();
        // -------------------

        if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
        await jitter();

        // 1) Get Signed URL
        const authHeaders = await getAuthHeader();
        const metaResp = await fetch(`${BACKEND_BASE}/api/get-upload-url`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders },
          body: JSON.stringify({
            filename,
            albumName,
            projectId: String(projectId),
            domain: domainForPath || undefined
          })
        }).catch(err => { throw new Error("Network/Backend Error: " + err.message) });

        const metaJson = await metaResp.json().catch(() => ({}));
        if (!metaResp.ok || !metaJson.ok) {
          throw new Error(metaJson?.error || `Signed URL error (HTTP ${metaResp.status})`);
        }

        if (metaJson.skipped) {
          return { ok: true, skipped: true, objectPath: metaJson.objectPath || null };
        }

        const uploadUrl = metaJson.uploadUrl;
        if (!uploadUrl) throw new Error("Missing uploadUrl from backend");

        // 2) Fetch Blob
        const blob = await fetchImageFromPicTime(photo.url);

        // 3) Upload to GCS
        const putResp = await fetch(uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": "application/octet-stream" },
          body: blob
        }).catch(err => { throw new Error("GCS Upload Network Error: " + err.message) });

        if (!putResp.ok) throw new Error(`GCS upload failed: HTTP ${putResp.status}`);

        // 4) Set Metadata
        try {
            const authHeaders2 = await getAuthHeader();
            await fetch(`${BACKEND_BASE}/api/set-image-metadata`, {
                method: "POST",
                headers: { "Content-Type": "application/json", ...authHeaders2 },
                body: JSON.stringify({
                    filename,
                    albumName,
                    projectId: String(projectId),
                    scene: photo.scene || "",
                    photoId: String(photo.photoId ?? ""),
                    domain: domainForPath || ""
                })
            });
        } catch (metaErr) {
            console.warn("Non-fatal: failed to set image metadata", metaErr);
        }

        return { ok: true, skipped: false, objectPath: metaJson.objectPath || null };

      } catch (err) {
        console.warn(`Retry ${attempt}/${MAX_RETRIES} for ${filename}`, err);
        const errString = String(err);

        if (errString.includes("Network") || errString.includes("fetch failed") || errString.includes("Failed to fetch")) {
            console.log("Detected network failure. Forcing pause check...");
            attempt--; 
            await new Promise(r => setTimeout(r, 2000)); 
            continue; 
        }

        if (attempt === MAX_RETRIES) {
          return { ok: false, error: String(err) };
        }
        await new Promise(resolve => setTimeout(resolve, 500 * attempt));
      }
    }
  }

  let index = 0;
  // --- CHANGED: Use activeConcurrency here instead of CONCURRENCY ---
  const pool = Array(activeConcurrency).fill(0).map(async () => {
      while (index < photos.length) {
        await waitUntilResumedAndOnline();
        
        const i = index++;
        if (i >= photos.length) break; 
        
        const photo = photos[i];
        const result = await uploadOne(photo, effectiveDomain);

        if (result.ok) {
          successes.push({ filename: photo.filename, skipped: !!result.skipped, objectPath: result.objectPath });
        } else {
          failures.push({ filename: photo.filename, error: result.error });

          const stored = await chrome.storage.local.get(KEY_ALL_FAILURES);
          const allFails = stored[KEY_ALL_FAILURES] || [];
          allFails.push({ filename: photo.filename, error: result.error, projectId, albumName });
          await chrome.storage.local.set({ [KEY_ALL_FAILURES]: allFails });
        }

        completed++;
        await updateTransferState({ completed, successes, failures });
      }
    });

  await Promise.all(pool);
}

// -----------------------------------------------------------------------------
// MAIN MESSAGE ROUTER
// -----------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
        // --- NEW PAUSE / RESUME HANDLERS ---
        if (msg?.type === "PAUSE_TRANSFER") {
            await updateTransferState({ paused: true, pausedReason: 'user' });
            sendResponse?.({ ok: true });
            return;
        }

        if (msg?.type === "RESUME_TRANSFER") {
            // Check network first
            const online = await checkInternetConnection();
            if(!online) {
                sendResponse?.({ ok: false, error: "Cannot resume: No internet connection detected." });
                return;
            }
            await updateTransferState({ paused: false, pausedReason: null });
            sendResponse?.({ ok: true });
            return;
        }
        // -----------------------------------

      if (msg?.type === "CLEAR_ACTIVE_TRANSFER_ONLY") {
        const empty = await resetTransferState(); 
        sendResponse?.({ ok: true });
        return;
      }

      if (msg?.type === "CLEAR_LAST_RUN_ONLY") {
        await chrome.storage.local.set({ [KEY_LAST_RUN]: { total: 0 } });
        sendResponse?.({ ok: true });
        return;
      }

      if (msg?.type === "TRANSFER_ALL_GALLERIES") {
        const { domain, delayMs, projectIds } = msg;
        await chrome.storage.local.set({ [KEY_ALL_FAILURES]: [] });

        const data = await chrome.storage.local.get(KEY_GALLERIES);
        let galleries = data[KEY_GALLERIES] || [];
        galleries = galleries.filter(g => (g.mediaCount || 0) > 0);

        if (Array.isArray(projectIds) && projectIds.length > 0) {
          const allowed = new Set(projectIds.map(String));
          galleries = galleries.filter(g => allowed.has(String(g.projectId)));
        }

        if (!galleries.length) {
          sendResponse?.({ ok: false, error: "No matching galleries." });
          return;
        }

        (async () => {
           const safeDelay = Number(delayMs) || 0;
           const overallStartedAt = Date.now();
           let globalTotal = 0;
           
           // NEW: Array to hold detailed stats for every album in this run
           const sessionLogs = [];

           for (const g of galleries) {
               // Wait if previous or current is paused/running
               while (true) {
                   const st = (await chrome.storage.local.get(KEY_TRANSFER))[KEY_TRANSFER] || {};
                   if (!st.running) break;
                   await new Promise(resolve => setTimeout(resolve, 1000));
               }

               const count = Number(g.mediaCount || 0);
               globalTotal += count;
   
               await updateTransferState({
                 running: true,
                 paused: false,
                 projectId: g.projectId,
                 albumName: g.name,
                 total: count,
                 completed: 0,
                 successes: [],
                 failures: [],
                 startedAt: Date.now(),
                 delayMs: safeDelay,
                 domain
               });
   
               const galleryUrl = `https://${domain}.pic-time.com/professional#dash|prj_${g.projectId}|photos`;
               const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
               let targetTabId;
               if (tab?.id) {
                   await chrome.tabs.update(tab.id, { url: galleryUrl });
                   targetTabId = tab.id;
               } else {
                   const newTab = await chrome.tabs.create({ url: galleryUrl });
                   targetTabId = newTab.id;
               }
               
               await new Promise(resolve => setTimeout(resolve, 2500));
               
               chrome.tabs.sendMessage(targetTabId, {
                   type: "FETCH_AND_TRANSFER",
                   projectId: g.projectId,
                   albumName: g.name,
                   count
               });

               // Wait for this specific gallery to finish
               while (true) {
                   const st = (await chrome.storage.local.get(KEY_TRANSFER))[KEY_TRANSFER] || {};
                   if (!st.running) {
                       // NEW: Capture the final state of THIS album before loop continues
                       sessionLogs.push({
                           albumName: st.albumName,
                           projectId: st.projectId,
                           totalPhotos: st.total,
                           successful: st.successes?.length || 0,
                           failed: st.failures?.length || 0,
                           startedAt: new Date(st.startedAt).toISOString(),
                           finishedAt: new Date(st.updatedAt).toISOString(),
                           failures: st.failures || [] // Detailed failure list for this album
                       });
                       break;
                   }
                   await new Promise(resolve => setTimeout(resolve, 1000));
               }
           }

            const storedFailsObj = await chrome.storage.local.get(KEY_ALL_FAILURES);
            const allFailures = storedFailsObj[KEY_ALL_FAILURES] || [];
            const totalFailed = allFailures.length;
  
            const lastRunSummary = {
              running: false,
              projectId: totalFailed === 1 ? allFailures[0].projectId : "—",
              albumName: galleries.length > 1 ? `${galleries.length} Albums Processed` : galleries[0]?.name || "—",
              total: globalTotal,
              completed: globalTotal, // Assuming run finished
              successes: [], // We don't keep global success list to save memory, usually
              failures: allFailures,
              startedAt: overallStartedAt,
              updatedAt: Date.now(),
              delayMs: safeDelay,
              domain,
              allFailures,
              totalFailed,
              sessionLogs // <--- NEW: The detailed breakdown
            };
            await chrome.storage.local.set({ [KEY_LAST_RUN]: lastRunSummary });

        })().catch(console.error);

        sendResponse?.({ ok: true, started: true });
        return;
     }

      if (msg?.type === "TRANSFER_TO_GCP") {
        const { gallery, count, domain, delayMs } = msg;
        const state = (await chrome.storage.local.get(KEY_TRANSFER))[KEY_TRANSFER];
        if (state?.running) {
          sendResponse?.({ ok: false, error: "Transfer already running." });
          return;
        }
        await updateTransferState({
          running: true,
          paused: false,
          projectId: gallery.projectId,
          albumName: gallery.name,
          total: count,
          completed: 0,
          successes: [],
          failures: [],
          startedAt: Date.now(),
          delayMs: Number(delayMs) || 0,
          domain
        });

        const galleryUrl = `https://${domain}.pic-time.com/professional#dash|prj_${gallery.projectId}|photos`;
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        let targetTabId = tab?.id ? tab.id : (await chrome.tabs.create({ url: galleryUrl })).id;
        if(tab?.id) await chrome.tabs.update(tab.id, { url: galleryUrl });

        await new Promise(resolve => setTimeout(resolve, 2500));
        chrome.tabs.sendMessage(targetTabId, {
          type: "FETCH_AND_TRANSFER",
          projectId: gallery.projectId,
          albumName: gallery.name,
          count
        });

        sendResponse?.({ ok: true });
        return;
      }

      if (msg?.type === "RETRY_FAILED_UPLOADS") {
         const lastRun = (await chrome.storage.local.get(KEY_LAST_RUN))[KEY_LAST_RUN] || {};
         const globalFails = lastRun.allFailures || lastRun.failures || [];
         if (!Array.isArray(globalFails) || !globalFails.length) {
            sendResponse?.({ ok: false, error: "No failed images in the last run." });
            return;
         }
        
         const groups = {};
         for (const f of globalFails) {
             if (!f || !f.filename || !f.projectId || !f.albumName) continue;
             const key = `${f.projectId}::${f.albumName}`;
             if (!groups[key]) groups[key] = { projectId: f.projectId, albumName: f.albumName, filenames: [] };
             groups[key].filenames.push(f.filename);
         }

         const domain = msg.domain || lastRun.domain;
         const perImageDelay = Number(msg.delayMs ?? lastRun.delayMs ?? 0);

         (async () => {
            const groupKeys = Object.keys(groups);
            for (const key of groupKeys) {
                const { projectId, albumName, filenames } = groups[key];
                
                // wait loop
                while (true) {
                   const st = (await chrome.storage.local.get(KEY_TRANSFER))[KEY_TRANSFER] || {};
                   if (!st.running) break;
                   await new Promise(resolve => setTimeout(resolve, 1000));
                }

                await updateTransferState({
                   running: true,
                   paused: false,
                   projectId,
                   albumName,
                   total: filenames.length,
                   completed: 0,
                   successes: [],
                   failures: [],
                   startedAt: Date.now(),
                   delayMs: perImageDelay,
                   domain
                });
                
                // ... open tab logic ...
                const galleryUrl = `https://${domain}.pic-time.com/professional#dash|prj_${projectId}|photos`;
                const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
                let targetTabId = tab?.id ? tab.id : (await chrome.tabs.create({ url: galleryUrl })).id;
                if(tab?.id) await chrome.tabs.update(tab.id, { url: galleryUrl });
                await new Promise(resolve => setTimeout(resolve, 2500));

                chrome.tabs.sendMessage(targetTabId, {
                  type: "FETCH_AND_TRANSFER",
                  projectId,
                  albumName,
                  count: filenames.length,
                  failedFilenames: filenames
                });

                while (true) {
                    const st = (await chrome.storage.local.get(KEY_TRANSFER))[KEY_TRANSFER] || {};
                    if (!st.running) break;
                    await new Promise(resolve => setTimeout(resolve, 1000));
                }
            }
         })().catch(console.error);
         
         sendResponse?.({ ok: true, started: true });
         return;
      }

      if (msg?.type === "START_UPLOAD_BATCH") {
        const { projectId, albumName, virtualPath, fullMetadata, photos } = msg;
        const currentState = (await chrome.storage.local.get(KEY_TRANSFER))[KEY_TRANSFER] || {};
        
        await updateTransferState({
          running: true,
          paused: false,
          projectId,
          albumName,
          total: photos.length,
          completed: 0,
          successes: [],
          failures: [],
          startedAt: Date.now(),
          delayMs: currentState.delayMs || 0,
          domain: currentState.domain || null
        });

        try {
          const authHeaders = await getAuthHeader();
          await fetch(`${BACKEND_BASE}/api/create-album`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...authHeaders },
            body: JSON.stringify({
              projectId,
              albumName,
              virtualPath,
              totalPhotos: photos.length,
              fullMetadata: fullMetadata || {},
              domain: currentState.domain
            })
          });
        } catch (err) {
          console.error("Failed to create album.json", err);
        }

        (async () => {
          await processUploadsInParallel(photos, projectId, albumName, currentState.domain);
          await updateTransferState({ running: false, paused: false });
          await saveFinalRunSnapshot(); 
        })();

        sendResponse?.({ ok: true, started: true, total: photos.length });
        return;
      }

      if (msg?.type === "GET_TRANSFER_STATE") {
        const state = (await chrome.storage.local.get(KEY_TRANSFER))[KEY_TRANSFER] || null;
        sendResponse?.({ ok: true, state });
        return;
      }

      if (msg?.type === "CLEAR_TRANSFER_LOG") {
        const empty = await resetTransferState();
        sendResponse?.({ ok: true, state: empty });
        return;
      }

      if (msg?.type === "DOWNLOAD_IMAGES") {
        const { gallery, count, domain } = msg;
        const galleryUrl = `https://${domain}.pic-time.com/professional#dash|prj_${gallery.projectId}|photos`;
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        let targetTabId = tab?.id ? tab.id : (await chrome.tabs.create({ url: galleryUrl })).id;
        if(tab?.id) await chrome.tabs.update(tab.id, { url: galleryUrl });
        await new Promise(resolve => setTimeout(resolve, 2500));
        await chrome.tabs.sendMessage(targetTabId, {
          type: "FETCH_PROJECT_PHOTOS",
          projectId: gallery.projectId,
          token: gallery.token,
          count
        });
        sendResponse?.({ ok: true });
        return;
      }

      if (msg?.type === "PTS_DOWNLOAD_READY") {
        const payload = msg.payload || {};
        let imageUrls = (payload.imageUrls || []).map(item => (typeof item === "string" ? item : item?.url)).filter(Boolean);
        imageUrls = [...new Set(imageUrls)];

        if (!imageUrls.length) {
          sendResponse?.({ ok: false, error: "no_urls" });
          return;
        }
        for (const u of imageUrls) {
          try { await chrome.downloads.download({ url: u }); } catch (e) {}
        }
        sendResponse?.({ ok: true, downloaded: imageUrls.length });
        return;
      }

      if (msg?.type === "PTS_CAPTURE") { 
          await saveCapture(msg.payload);
          sendResponse?.({ ok: true });
          return;
      }

      if (msg?.type === "GET_LAST") {
        const data = await chrome.storage.local.get([KEY_LAST, KEY_GALLERIES]);
        sendResponse?.({ ok: true, last: data[KEY_LAST] ?? null, galleries: data[KEY_GALLERIES] ?? [] });
        return;
      }

      if (msg?.type === "GET_GALLERIES") {
        const data = await chrome.storage.local.get(KEY_GALLERIES);
        sendResponse?.({ ok: true, galleries: data[KEY_GALLERIES] ?? [] });
        return;
      }

      if (msg?.type === "CLEAR_HISTORY") {
        await chrome.storage.local.remove([KEY_LAST, KEY_GALLERIES, KEY_HISTORY]);
        await chrome.storage.local.set({ [KEY_HISTORY]: [] });
        sendResponse?.({ ok: true });
        return;
      }

      if (msg?.type === "OPEN_URL") {
        const url = msg.url;
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (activeTab?.id) {
          await chrome.tabs.update(activeTab.id, { url });
          sendResponse?.({ ok: true, tabId: activeTab.id });
        } else {
          const tab = await chrome.tabs.create({ url });
          sendResponse?.({ ok: true, tabId: tab.id });
        }
        return;
      }

      sendResponse?.({ ok: false, error: "unknown_message" });
    } catch (err) {
      console.error("[bg] handler error:", err);
      sendResponse?.({ ok: false, error: String(err) });
    }
  })();
  return true;
});