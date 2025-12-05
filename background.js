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
const MAX_CAPTCHA_RETRIES = 3; 

const KEY_LAST = "pts_last";
const KEY_GALLERIES = "pts_galleries";
const KEY_HISTORY = "pts_history";
const KEY_TRANSFER = "pts_transfer_state";
const HISTORY_MAX = 20;
const KEY_LAST_RUN = "pts_last_run";
const KEY_ALL_FAILURES = "pts_all_failures";
let HARD_PAUSE = false; // prevents uploads from running during CAPTCHA recovery


const BACKEND_BASE = "https://migration-backend-223066796377.us-central1.run.app";

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
    paused: false,
    pausedReason: null, // 'user', 'network', or 'captcha'
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

// -----------------------------------------------------------------------------
// ANTI-CAPTCHA PROTOCOL
// -----------------------------------------------------------------------------

async function verifyMetadataViaIsolated(projectId) {
  const tabs = await chrome.tabs.query({ url: "*://*.pic-time.com/*" });
  const tab = tabs[0];
  if (!tab) return false;

  return await new Promise(resolve => {
    chrome.tabs.sendMessage(
      tab.id,
      { type: "VERIFY_PROJECT_METADATA", projectId },
      resp => {
        if (chrome.runtime.lastError || !resp?.ok) return resolve(false);
        resolve(resp.cleared);
      }
    );
  });
}


async function findPicTimeTab() {
  const tabs = await chrome.tabs.query({ url: "*://*.pic-time.com/*" });
  return tabs.find(t => t.active) || tabs[0];
}

async function resolveCaptchaSequence(options = {}) {
  const isZeroPhotoTrigger = !!options.zeroPhoto;
  console.warn("[BG] 🛡 CAPTCHA Recovery starting...", { isZeroPhotoTrigger });

  let st = (await chrome.storage.local.get(KEY_TRANSFER))[KEY_TRANSFER] || {};
  const projectId = st.projectId;

  await updateTransferState({
    ...st,
    paused: true,
    pausedReason: "captcha",
    running: true,
    resumeCountdown: 0
  });

  const tabs = await chrome.tabs.query({ url: "*://*.pic-time.com/*" });
  const tab = tabs[0];
  if (!tab) return false;

  for (let cycle = 1; cycle <= 3; cycle++) {
    console.warn(`[BG] CAPTCHA cycle ${cycle}/3`);

    // 1. Reload page ONCE
    try {
      await chrome.tabs.reload(tab.id);
    } catch (e) {
      console.warn("Failed reload:", e);
    }

    // 2. Hard wait 10s
    await new Promise(r => setTimeout(r, 10000));

    // 3. Run unBlockMe()
    const unblockResp = await new Promise(resolve => {
      chrome.tabs.sendMessage(tab.id, { type: "TRIGGER_CAPTCHA_FIX" }, resolve);
    });

    // 4. Hard wait another 10s for it to take effect
    await new Promise(r => setTimeout(r, 10000));

    // 5. Check metadata
    const ok = await verifyMetadataViaIsolated(projectId);
    if (ok) {
      console.warn("[BG] 🟩 Captcha solved successfully.");
      await updateTransferState({
        ...(await chrome.storage.local.get(KEY_TRANSFER))[KEY_TRANSFER],
        paused: false,
        pausedReason: null,
        resumeCountdown: 0
      });
      return true;
    }
  }

  // FAILED ALL 3 CYCLES
  console.warn("[BG] ❌ CAPTCHA could not be solved.");

  if (isZeroPhotoTrigger) {
    // Skip album
    await updateTransferState({
      ...(await chrome.storage.local.get(KEY_TRANSFER))[KEY_TRANSFER],
      paused: false,
      pausedReason: null,
      running: false
    });
    return false;
  }

  // Hard block → user must intervene
  await updateTransferState({
    ...(await chrome.storage.local.get(KEY_TRANSFER))[KEY_TRANSFER],
    paused: true,
    pausedReason: "user"
  });

  chrome.tabs.sendMessage(tab.id, { type: "SHOW_CAPTCHA_FAILED_ALERT" });
  return false;
}







async function fetchImageFromPicTime(url) {
  // If captcha recovery is currently active, do not hit Pic-Time at all.
  if (HARD_PAUSE) {
    throw new Error("HARD_PAUSE_ACTIVE");
  }

  const res = await fetch(url, { method: "GET", credentials: "include" });

  // If pause activated mid-request
  if (HARD_PAUSE) {
    throw new Error("HARD_PAUSE_ACTIVE");
  }

  // No captcha detection here anymore.
  if (!res.ok) {
    throw new Error(`Pic-Time fetch failed: ${res.status} ${res.statusText}`);
  }

  return await res.blob();
}


// -----------------------------------------------------------------------------
// NETWORK CHECKER & PAUSE BARRIER
// -----------------------------------------------------------------------------

async function checkInternetConnection() {
    if (!navigator.onLine) return false;
    try {
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

async function waitUntilResumedAndOnline() {
  let isBlocked = true;
  
  while (isBlocked) {
      const state = (await chrome.storage.local.get(KEY_TRANSFER))[KEY_TRANSFER];
      if (!state || !state.running) return; 

      const isOnline = await checkInternetConnection();

      if (state.paused) {
          if (state.pausedReason === 'user') {
              await new Promise(r => setTimeout(r, 1000));
              continue; 
          }
          if (state.pausedReason === 'captcha') {
              // Wait for resolver
              await new Promise(r => setTimeout(r, 1000));
              continue; 
          }
          if (state.pausedReason === 'network') {
              if (isOnline) {
                  console.log("[bg] Internet restored. Auto-resuming...");
                  await updateTransferState({ paused: false, pausedReason: null });
                  isBlocked = false; 
              } else {
                  await new Promise(r => setTimeout(r, 2000)); 
                  continue;
              }
          }
      } else {
          if (!isOnline) {
              console.warn("[bg] Network disruption detected. Pausing...");
              await updateTransferState({ paused: true, pausedReason: 'network' });
              await new Promise(r => setTimeout(r, 2000));
              continue;
          }
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
  const cVal = (await chrome.storage.local.get(KEY_CONCURRENCY))[KEY_CONCURRENCY];
  const activeConcurrency = Number(cVal) || DEFAULT_CONCURRENCY;

  function jitter() {
    const delay = JITTER_MIN + Math.random() * (JITTER_MAX - JITTER_MIN);
    return new Promise(resolve => setTimeout(resolve, delay));
  }

  async function uploadOne(photo, domainForPath) {
    const filename = photo.filename;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await waitUntilResumedAndOnline();

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

        // 2) Fetch Blob from Pic-Time (With Captcha Check)
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

        // NEW: Respect global HARD_PAUSE caused by CAPTCHA recovery.
        if (errString.includes("HARD_PAUSE_ACTIVE")) {
          console.warn("[BG] Worker frozen due to HARD_PAUSE, waiting for resume...");
          
          // Wait indefinitely until HARD_PAUSE is lifted
          await new Promise(resolve => {
              const timer = setInterval(() => {
                  if (!HARD_PAUSE) {
                      clearInterval(timer);
                      resolve();
                  }
              }, 500);
          });
      
          // Once resumed, restart this attempt (do not increment retries)
          attempt--;
          continue;
      }
      

        // CAPTCHA HANDLER
        if (errString.includes("CAPTCHA_DETECTED")) {
          attempt--;
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }

        // Network-ish errors → let network checker handle pause/resume
        if (
          errString.includes("Network") ||
          errString.includes("fetch failed") ||
          errString.includes("Failed to fetch")
        ) {
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
        if (msg?.type === "PAUSE_TRANSFER") {
            await updateTransferState({ paused: true, pausedReason: 'user' });
            sendResponse?.({ ok: true });
            return;
        }

        if (msg?.type === "RESUME_TRANSFER") {
            const online = await checkInternetConnection();
            if(!online) {
                sendResponse?.({ ok: false, error: "Cannot resume: No internet connection detected." });
                return;
            }
            await updateTransferState({ paused: false, pausedReason: null });
            sendResponse?.({ ok: true });
            return;
        }

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

      if (msg?.type === "CAPTCHA_OCCURRED") {
        console.warn("[BG] 🟥 CAPTCHA_OCCURRED received — PAUSING TRANSFERS IMMEDIATELY.");
      
        await updateTransferState({
          ...(await chrome.storage.local.get(KEY_TRANSFER))[KEY_TRANSFER],
          paused: true,
          pausedReason: "captcha",
          running: true  // do NOT mark finished
        });
      
        const ok = await resolveCaptchaSequence({ zeroPhoto: false });
      
        if (ok) {
          console.warn("[BG] 🟩 CAPTCHA recovery complete — resuming transfer.");
        } else {
          console.warn("[BG] ❌ CAPTCHA recovery failed. Transfer remains paused for user intervention.");
        }
        return;
      }
      if (msg?.type === "CAPTCHA_ZERO_PHOTO") {
        console.warn("[BG] ZERO-PHOTO CAPTCHA DETECTED");
      
        await updateTransferState({
          ...(await chrome.storage.local.get(KEY_TRANSFER))[KEY_TRANSFER],
          paused: true,
          pausedReason: "captcha",
          running: true
        });
      
        const ok = await resolveCaptchaSequence({ zeroPhoto: true });
      
        if (ok) {
          console.warn("[BG] ZERO-PHOTO captcha cleared, continuing transfer.");
        } else {
          console.warn("[BG] ZERO-PHOTO captcha unresolved, album will be skipped and batch will proceed.");
        }
      
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
           let globalSuccessCount = 0; // <--- FIX ISSUE 1: Track successes globally
           const sessionLogs = [];

           // 1. Get Tab
           const targetTab = await findPicTimeTab();
           let targetTabId;
           if (targetTab) {
               targetTabId = targetTab.id;
           } else {
               const newTab = await chrome.tabs.create({ url: `https://${domain}.pic-time.com/professional#dash` });
               targetTabId = newTab.id;
               await new Promise(r => setTimeout(r, 4000));
           }

           for (const g of galleries) {
               // 2. Wait if paused before starting next album
               while (true) {
                   const st = (await chrome.storage.local.get(KEY_TRANSFER))[KEY_TRANSFER] || {};
                   if (!st.running && !st.paused) break; 
                   if (st.paused) { 
                       await new Promise(r => setTimeout(r, 1000)); 
                   } else if (st.running) {
                       await new Promise(r => setTimeout(r, 1000));
                   } else {
                       break;
                   }
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
               
               let albumDone = false;
               
               // --- THE RETRY LOOP FOR SETUP PHASE ---
               while (!albumDone) {
                   
                   // A. Send the command
                   console.log(`[bg] Requesting album: ${g.name}`);
                   chrome.tabs.sendMessage(targetTabId, {
                       type: "FETCH_AND_TRANSFER",
                       projectId: g.projectId,
                       albumName: g.name,
                       count
                   });

                   // B. Wait for completion OR Captcha Pause
                   while (true) {
                       const st = (await chrome.storage.local.get(KEY_TRANSFER))[KEY_TRANSFER] || {};
                       
                       // Case 1: Captcha Hit (Paused)
                       if (st.paused && st.pausedReason === 'captcha') {
                          // ... (Existing captcha logic omitted for brevity, keep as is) ...
                          // Keep your existing Captcha loop logic here
                          while (true) {
                              const check = (await chrome.storage.local.get(KEY_TRANSFER))[KEY_TRANSFER] || {};
                              if (!check.paused) {
                                  if (!check.running) albumDone = true; 
                                  break;
                              }
                              await new Promise(r => setTimeout(r, 1000));
                          }
                          if (albumDone) break;
                          console.log("[bg] Captcha fixed. RE-TRYING ALBUM SETUP.");
                          break; 
                       }

                       // Case 2: User Pause
                       if (st.paused && st.pausedReason === 'user') {
                           await new Promise(r => setTimeout(r, 1000));
                           continue;
                       }

                       // Case 3: Finished (Running became false)
                       if (!st.running) {
                           // Log stats
                           const sCount = st.successes?.length || 0;
                           globalSuccessCount += sCount; // <--- FIX ISSUE 1: Add to global

                           sessionLogs.push({
                               albumName: st.albumName,
                               projectId: st.projectId,
                               totalPhotos: st.total,
                               successful: sCount,
                               failed: st.failures?.length || 0,
                               failures: st.failures || [] 
                           });
                           albumDone = true; // Exit retry loop
                           break;
                       }

                       // Standard wait
                       await new Promise(r => setTimeout(r, 1000));
                   }
               }
           }
           
           // Final Cleanup
           const storedFailsObj = await chrome.storage.local.get(KEY_ALL_FAILURES);
           const allFailures = storedFailsObj[KEY_ALL_FAILURES] || [];
           
           const lastRunSummary = { 
               running: false, 
               projectId: "—", 
               albumName: "Batch Complete", 
               total: globalTotal, 
               completed: globalTotal, 
               // FIX ISSUE 1: Save the count (number) instead of empty array
               successes: globalSuccessCount, 
               failures: allFailures, 
               startedAt: overallStartedAt, 
               updatedAt: Date.now(), 
               delayMs: safeDelay, 
               domain, 
               allFailures, 
               totalFailed: allFailures.length, 
               sessionLogs 
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