console.log("[popup] Ready");

let lastStableEta = ""; // persists between renders
let lastRunCollapsed = true;

// --- Element References ---
const AUTH_INPUT = document.getElementById("authTokenInput");
const SAVE_AUTH = document.getElementById("saveAuthBtn");
const AUTH_KEY = "pts_auth_token";

// --- MISSING DEFINITIONS ADDED HERE ---
const CONCURRENCY_INPUT = document.getElementById("concurrencyInput");
const CONCURRENCY_KEY = "pts_concurrency";

const TRANSFER_ETA = document.getElementById("transferEta");

const START = document.getElementById("startBtn");
const REFRESH = document.getElementById("refreshBtn");
const CLEAR = document.getElementById("clearBtn");
const STATUS = document.getElementById("status");
const GALLERIES = document.getElementById("galleries");
const SUBDOMAIN = document.getElementById("subdomainInput");

const TRANSFER_PANEL = document.getElementById("transferPanel");
const TRANSFER_PROGRESS = document.getElementById("transferProgress");
const TRANSFER_BAR = document.getElementById("transferBar");
const TRANSFER_FAILURES = document.getElementById("transferFailures");
const CLEAR_TRANSFER_BTN = document.getElementById("clearTransferBtn");

const PAUSE_RESUME_BTN = document.getElementById("pauseResumeBtn");

const SUBDOMAIN_KEY = "pts_subdomain";
const advToggle = document.getElementById("advancedToggle");
const advPanel = document.getElementById("advancedPanel");

const DELAY_INPUT = document.getElementById("delayInput");
const DELAY_KEY = "pts_delay_ms";

const LAST_RUN_CONTAINER = document.getElementById("lastRunContainer");
const LAST_RUN_TOGGLE = document.getElementById("lastRunHeader");
const LAST_RUN_BODY = document.getElementById("lastRunBody");
const LAST_RUN_CHEVRON = document.getElementById("lastRunChevron");
const LAST_RUN_TEXT = document.getElementById("lastRunText");
const LAST_RUN_FAILURES_LIST = document.getElementById("lastRunFailuresList");
const RETRY_FAILED_BTN = document.getElementById("retryFailedBtn");
const CLEAR_LAST_RUN_BTN = document.getElementById("clearLastRunBtn");

const TRANSFER_SELECTED_BTN = document.getElementById("transferSelectedBtn");
const SELECT_ALL_BOX = document.getElementById("selectAllBox");
const DOWNLOAD_LOG_BTN = document.getElementById("downloadLogBtn");

let transferAllRunning = false;

// --- ETA Helpers --------------------------------------------------------

let lastSpeedSample = null;
let lastCompleted = null;
let lastTime = null;

function estimateEta(total, completed) {
  if (!total || completed === 0) return null;
  const now = Date.now();
  if (lastSpeedSample === null) {
    lastSpeedSample = completed;
    lastCompleted = completed;
    lastTime = now;
    return null;
  }
  if (now - lastTime < 2000) return null;
  const deltaCompleted = completed - lastCompleted;
  const deltaTime = (now - lastTime) / 1000;
  if (deltaCompleted <= 0) return null;
  const speed = deltaCompleted / deltaTime;
  const remaining = total - completed;
  lastCompleted = completed;
  lastTime = now;
  return Math.round(remaining / speed);
}

function formatEta(seconds) {
  if (!seconds || seconds <= 0) return "";
  if (seconds < 60) return `${seconds}s remaining`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs}s remaining`;
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function getDelayMs() {
  if (!DELAY_INPUT) return 0;
  const raw = DELAY_INPUT.value || "";
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

// ---------- Transfer state UI ----------

async function fetchTransferState() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "GET_TRANSFER_STATE" });
    if (!res?.ok) return null;
    return res.state || null;
  } catch {
    return null;
  }
}

function applyTransferStateToButtons(state) {
  const running = !!state?.running;
  
  if (PAUSE_RESUME_BTN) {
      PAUSE_RESUME_BTN.style.display = running ? "block" : "none";
  }

  document.querySelectorAll("button").forEach((btn) => {
    if (btn.textContent === "Transfer") {
      btn.disabled = running || btn.disabled;
    }
  });
  if (TRANSFER_SELECTED_BTN) {
    if (running) {
      TRANSFER_SELECTED_BTN.disabled = true;
    } else {
      updateTransferButtonText();
    }
  }
}

function renderTransferPanel(state) {
  // 1. Basic Visibility Check
  if (!state || (!state.running && state.total === 0 && state.completed === 0)) {
    if (TRANSFER_PANEL) TRANSFER_PANEL.style.display = "none";
    return;
  }
  if (TRANSFER_PANEL) TRANSFER_PANEL.style.display = "flex"; 
  
  const { running, paused, pausedReason, albumName, total, completed, successes, failures } = state;
  const safeTotal = total || 0;
  const safeCompleted = completed || 0;
  const pct = safeTotal > 0 ? Math.round((safeCompleted / safeTotal) * 100) : 0;

  // Reset speed stats if starting new
  if (running && safeCompleted === 0) {
    lastSpeedSample = null;
    lastCompleted = null;
    lastTime = null;
    lastStableEta = "";
  }

  if (TRANSFER_BAR) TRANSFER_BAR.style.width = `${pct}%`;

  // --- MAIN LOGIC ---
  if (running) {
    
    // --- FIX (Issue 2): Hide Clear Button while running ---
    if (CLEAR_TRANSFER_BTN) CLEAR_TRANSFER_BTN.style.display = "none";

    // A. PAUSED STATE
    if (paused) {
      if (TRANSFER_BAR) TRANSFER_BAR.style.animation = "none";

      // Network Pause
      if (pausedReason === "network") {
        if (TRANSFER_BAR) TRANSFER_BAR.style.backgroundColor = "#ef4444"; 
        if (TRANSFER_PROGRESS) {
          TRANSFER_PROGRESS.className = "status-network"; 
          TRANSFER_PROGRESS.textContent = "Waiting for Internet...";
        }
        if (TRANSFER_ETA) TRANSFER_ETA.textContent = "Auto-resuming when online";
        if (PAUSE_RESUME_BTN) {
          PAUSE_RESUME_BTN.textContent = "Connecting...";
          PAUSE_RESUME_BTN.className = "btn-control waiting-style"; 
          PAUSE_RESUME_BTN.disabled = true;
        }

      // Captcha Pause
      } else if (pausedReason === "captcha") {
        if (TRANSFER_BAR) TRANSFER_BAR.style.backgroundColor = "#f59e0b";
        if (TRANSFER_PROGRESS) {
          TRANSFER_PROGRESS.className = "status-paused";
          TRANSFER_PROGRESS.textContent = "Captcha detected – solving…";
        }
        if (TRANSFER_ETA) TRANSFER_ETA.textContent = "Auto-resuming after captcha block";
        if (PAUSE_RESUME_BTN) {
          PAUSE_RESUME_BTN.textContent = "Solving…";
          PAUSE_RESUME_BTN.className = "btn-control waiting-style";
          PAUSE_RESUME_BTN.disabled = true;
          PAUSE_RESUME_BTN.onclick = null; 
        }

      // User Pause
      } else {
        if (TRANSFER_BAR) TRANSFER_BAR.style.backgroundColor = "#f59e0b"; 
        if (TRANSFER_PROGRESS) {
          TRANSFER_PROGRESS.className = "status-paused"; 
          TRANSFER_PROGRESS.textContent = "Transfer Paused";
        }
        if (TRANSFER_ETA) TRANSFER_ETA.textContent = "Paused • Waiting for user to resume";
        if (PAUSE_RESUME_BTN) {
          PAUSE_RESUME_BTN.textContent = "Resume";
          PAUSE_RESUME_BTN.className = "btn-control resume-style"; 
          PAUSE_RESUME_BTN.disabled = false;
          PAUSE_RESUME_BTN.onclick = async () => {
            PAUSE_RESUME_BTN.textContent = "Starting...";
            await chrome.runtime.sendMessage({ type: "RESUME_TRANSFER" });
          };
        }
      }

    // B. ACTIVE RUNNING STATE
    } else {
      if (TRANSFER_BAR) {
        TRANSFER_BAR.style.backgroundColor = "";
        TRANSFER_BAR.style.animation = ""; 
      }

      if (TRANSFER_PROGRESS) {
        TRANSFER_PROGRESS.className = "";
        TRANSFER_PROGRESS.textContent = `Transferring "${albumName || "Unknown"}"`;
      }

      const etaSeconds = estimateEta(safeTotal, safeCompleted);
      if (etaSeconds && etaSeconds > 0) {
        lastStableEta = formatEta(etaSeconds);
      }

      if (TRANSFER_ETA) {
        TRANSFER_ETA.textContent = `${pct}% completed • ${lastStableEta || "Calculating..."}`;
      }

      if (PAUSE_RESUME_BTN) {
        PAUSE_RESUME_BTN.textContent = "Pause";
        PAUSE_RESUME_BTN.className = "btn-control pause-style";
        PAUSE_RESUME_BTN.disabled = false;
        PAUSE_RESUME_BTN.onclick = async () => {
          PAUSE_RESUME_BTN.textContent = "Pausing...";
          await chrome.runtime.sendMessage({ type: "PAUSE_TRANSFER" });
        };
      }
    }

  // --- FINISHED STATE ---
  } else {
    // --- FIX (Issue 2): Show Clear Button when finished ---
    if (CLEAR_TRANSFER_BTN) CLEAR_TRANSFER_BTN.style.display = "block";

    if (TRANSFER_PROGRESS) {
      TRANSFER_PROGRESS.className = "";
      TRANSFER_PROGRESS.textContent = "Transfer Complete";
    }

    if (TRANSFER_ETA) {
      TRANSFER_ETA.textContent = `${safeTotal} images processed`;
    }

    if (PAUSE_RESUME_BTN) {
      PAUSE_RESUME_BTN.style.display = "none";
    }
  }

  // Update Failures List
  if (failures && failures.length) {
    const firstFive = failures.slice(0, 5);
    const more = failures.length > 5 ? ` (+${failures.length - 5} more)` : "";
    if (TRANSFER_FAILURES) {
      TRANSFER_FAILURES.textContent = 
        "Failed: " + firstFive.map(f => f.filename).join(", ") + more;
    }
  } else {
    if (TRANSFER_FAILURES) TRANSFER_FAILURES.textContent = "";
  }

  applyTransferStateToButtons(state);
}


function renderLastRunSummary(state) {
  if (!LAST_RUN_CONTAINER) return;
  LAST_RUN_CONTAINER.style.display = "block";

  // Case 1: Transfer is currently running
  if (state && state.running) {
    if (LAST_RUN_TEXT) LAST_RUN_TEXT.innerHTML = `<div>Transfer in progress…</div>`;
    if (LAST_RUN_FAILURES_LIST) LAST_RUN_FAILURES_LIST.textContent = "";
    if (RETRY_FAILED_BTN) RETRY_FAILED_BTN.disabled = true;
    if (DOWNLOAD_LOG_BTN) DOWNLOAD_LOG_BTN.style.display = "none"; 
    return;
  }
  
  // Case 2: No history
  if (!state || state.total === 0) {
      if (LAST_RUN_TEXT) LAST_RUN_TEXT.innerHTML = `<div>No previous transfers recorded.</div>`;
      if (RETRY_FAILED_BTN) RETRY_FAILED_BTN.disabled = true;
      if (DOWNLOAD_LOG_BTN) DOWNLOAD_LOG_BTN.style.display = "none";
      return;
  }

  // Case 3: Display Summary
  if (DOWNLOAD_LOG_BTN) DOWNLOAD_LOG_BTN.style.display = "block"; 

  const { albumName, projectId, total, successes, failures, startedAt, updatedAt } = state;
  
  // --- FIX (Issue 1): Handle both Array (Single Run) and Number (Batch Run) ---
  const okCount = Array.isArray(successes) ? successes.length : (Number(successes) || 0);
  const failCount = failures?.length || 0;

  if (LAST_RUN_TEXT) {
    LAST_RUN_TEXT.innerHTML = `
        <div><strong>Album:</strong> ${escapeHtml(albumName || "")}</div>
        <div><strong>Project ID:</strong> <code>${escapeHtml(projectId ?? "—")}</code></div>
        <div><strong>Total images:</strong> ${total}</div>
        <div><strong>Success:</strong> ${okCount} &nbsp; <strong>Failed:</strong> ${failCount}</div>
        <div><strong>Started:</strong> ${escapeHtml(new Date(startedAt).toLocaleString())}</div>
        <div><strong>Finished:</strong> ${escapeHtml(new Date(updatedAt).toLocaleString())}</div>
    `;
  }

  if (failCount) {
    const firstFive = failures.slice(0, 5).map(f => escapeHtml(f.filename)).join(", ");
    const more = failCount > 5 ? ` (+${failCount - 5} more)` : "";
    if (LAST_RUN_FAILURES_LIST) LAST_RUN_FAILURES_LIST.textContent = `Failed files: ${firstFive}${more}`;
    if (RETRY_FAILED_BTN) RETRY_FAILED_BTN.disabled = false;
  } else {
    if (LAST_RUN_FAILURES_LIST) LAST_RUN_FAILURES_LIST.textContent = "No failed images in last run.";
    if (RETRY_FAILED_BTN) RETRY_FAILED_BTN.disabled = true;
  }
}

let transferPollHandle = null;
async function startTransferPoller() {
  if (transferPollHandle) return;
  transferPollHandle = setInterval(async () => {
    const st = await fetchTransferState();
    if (st) renderTransferPanel(st);
    const lr = (await chrome.storage.local.get("pts_last_run"))["pts_last_run"];
    renderLastRunSummary(lr);
  }, 800);
}

// ---------- Galleries Logic ----------

async function loadGalleries() {
  const { pts_galleries } = await chrome.storage.local.get("pts_galleries");
  const galleries = pts_galleries || [];

  if (GALLERIES) GALLERIES.innerHTML = "";
  if (SELECT_ALL_BOX) SELECT_ALL_BOX.checked = false;

  if (!galleries.length) {
    if (STATUS) STATUS.textContent = "No galleries captured yet.";
    if (GALLERIES) GALLERIES.innerHTML = '<div class="empty">No galleries found<span>Use “Start Capture” to load your Pic-Time dashboard.</span></div>';
    updateTransferButtonText();
    return;
  }

  if (STATUS) STATUS.textContent = `Found ${galleries.length} galler${galleries.length > 1 ? "ies" : "y"}`;

  galleries.forEach((g) => {
    const card = document.createElement("div");
    card.className = "gallery";
    card.dataset.projectId = g.projectId; 

    const head = document.createElement("div");
    head.className = "gallery-head";

    const checkWrap = document.createElement("div");
    checkWrap.className = "gallery-check-wrapper";
    
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "gallery-checkbox";
    checkbox.dataset.projectId = g.projectId;
    
    if((g.mediaCount || 0) === 0) checkbox.disabled = true;
    
    checkbox.addEventListener('change', () => updateTransferButtonText());
    checkWrap.appendChild(checkbox);

    const name = document.createElement("div");
    name.className = "gallery-name";
    name.textContent = g.name;

    const chip = document.createElement("div");
    chip.className = "meta-chip";
    chip.textContent = `${g.mediaCount || 0}`;

    head.append(checkWrap, name, chip);

    const controls = document.createElement("div");
    controls.className = "btn-row";

    const detailsBtn = document.createElement("button");
    detailsBtn.className = "btn-secondary";
    detailsBtn.textContent = "Details";
    controls.append(detailsBtn);

    const details = document.createElement("div");
    details.className = "details";

    const kvName = document.createElement("div"); kvName.className = "kv"; kvName.innerHTML = `<strong>Name:</strong> ${escapeHtml(g.name)}`;
    const kvId = document.createElement("div"); kvId.className = "kv"; kvId.innerHTML = `<strong>ID:</strong> <code>${escapeHtml(g.projectId ?? "—")}</code>`;
    const kvCount = document.createElement("div"); kvCount.className = "kv"; kvCount.innerHTML = `<strong>Media:</strong> ${escapeHtml(g.mediaCount ?? 0)}`;
    details.append(kvName, kvId, kvCount);

    if ((g.mediaCount || 0) > 0) {
      const dlWrap = document.createElement("div");
      dlWrap.className = "download";

      const maxN = Number(g.mediaCount || 0);
      const input = document.createElement("input");
      input.type = "number";
      input.min = "1";
      input.max = String(maxN);
      input.placeholder = `1 – ${maxN}`;

      const btnDownload = document.createElement("button");
      btnDownload.textContent = "Download";
      btnDownload.disabled = true;

      const btnTransfer = document.createElement("button");
      btnTransfer.textContent = "Transfer";
      btnTransfer.disabled = true;

      input.addEventListener("input", () => {
        const n = clamp(Number(input.value || 0), 1, maxN);
        const enabled = n >= 1 && n <= maxN;
        btnDownload.disabled = !enabled;
        btnTransfer.disabled = !enabled;
      });

      btnDownload.addEventListener("click", async () => {
        const sub = (SUBDOMAIN.value || "").trim();
        if (!sub) return;
        const n = clamp(Number(input.value || 0), 1, maxN);
        btnDownload.textContent = "Downloading...";
        btnDownload.disabled = true;
        await chrome.runtime.sendMessage({
          type: "DOWNLOAD_IMAGES",
          gallery: g,
          count: n,
          domain: sub
        });
        btnDownload.textContent = "Done ✔️";
        setTimeout(() => {
          btnDownload.textContent = "Download";
          btnDownload.disabled = false;
        }, 1500);
      });

      btnTransfer.addEventListener("click", async () => {
        const sub = (SUBDOMAIN.value || "").trim();
        if (!sub) return;
        const n = clamp(Number(input.value || 0), 1, maxN);
        const st = await fetchTransferState();
        if (st?.running) {
          alert("A transfer is already running.");
          return;
        }
        btnTransfer.textContent = "Starting...";
        btnTransfer.disabled = true;
        const delayMs = getDelayMs();
        await chrome.runtime.sendMessage({
          type: "TRANSFER_TO_GCP",
          gallery: g,
          count: n,
          domain: sub,
          delayMs
        });
      });

      dlWrap.append(input, btnDownload, btnTransfer);
      details.append(dlWrap);
    }

    detailsBtn.addEventListener("click", () => {
      const open = details.classList.toggle("open");
      detailsBtn.textContent = open ? "Hide details" : "Details";
    });

    card.append(head, controls, details);
    if (GALLERIES) GALLERIES.appendChild(card);
  });

  updateTransferButtonText();
  
  const st = await fetchTransferState();
  if (st) renderTransferPanel(st);
}

// ---------- Multi-Select Logic ----------

function getSelectedProjectIds() {
  const checkboxes = document.querySelectorAll('.gallery-checkbox:checked');
  return Array.from(checkboxes).map(cb => cb.dataset.projectId);
}

function updateTransferButtonText() {
  if (!TRANSFER_SELECTED_BTN) return;
  const checkboxes = document.querySelectorAll('.gallery-checkbox:checked');
  const count = checkboxes.length;
  const allCheckboxes = document.querySelectorAll('.gallery-checkbox:not(:disabled)');
  if (SELECT_ALL_BOX && allCheckboxes.length > 0) {
    SELECT_ALL_BOX.checked = (count === allCheckboxes.length);
    SELECT_ALL_BOX.indeterminate = (count > 0 && count < allCheckboxes.length);
  }
  TRANSFER_SELECTED_BTN.textContent = count > 0 ? `Transfer ${count} Selected` : "Select galleries...";
  TRANSFER_SELECTED_BTN.disabled = (count === 0);
}

if (SELECT_ALL_BOX) {
  SELECT_ALL_BOX.addEventListener('change', (e) => {
      const checked = e.target.checked;
      const checkboxes = document.querySelectorAll('.gallery-checkbox');
      checkboxes.forEach(cb => {
          if (!cb.disabled) cb.checked = checked;
      });
      updateTransferButtonText();
  });
}

async function handleTransferSelected() {
  if (transferAllRunning) return;
  const sub = (SUBDOMAIN.value || "").trim();
  if (!sub) { SUBDOMAIN.focus(); return; }
  const selectedIds = getSelectedProjectIds();
  if (selectedIds.length === 0) { alert("Please select at least one gallery."); return; }
  const delayMs = getDelayMs();

  transferAllRunning = true;
  TRANSFER_SELECTED_BTN.disabled = true;
  TRANSFER_SELECTED_BTN.textContent = "Starting Batch...";

  try {
    const resp = await chrome.runtime.sendMessage({
      type: "TRANSFER_ALL_GALLERIES",
      domain: sub,
      delayMs,
      projectIds: selectedIds
    });
    if (!resp?.ok) alert(resp.error || "Could not start batch transfer.");
  } finally {
    transferAllRunning = false;
  }
}

// ---------- Event Listeners ----------

if (START) {
    START.addEventListener("click", async () => {
    const sub = (SUBDOMAIN.value || "").trim();
    if (!sub) {
        SUBDOMAIN.focus();
        SUBDOMAIN.classList.add("shake");
        setTimeout(() => SUBDOMAIN.classList.remove("shake"), 400);
        return;
    }
    await chrome.storage.local.set({ [SUBDOMAIN_KEY]: sub });
    const DASH_URL = `https://${sub}.pic-time.com/professional#dash`;
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (activeTab?.id) {
        await chrome.tabs.update(activeTab.id, { url: DASH_URL });
    } else {
        await chrome.tabs.create({ url: DASH_URL });
    }
    STATUS.textContent = `Opening ${sub}.pic-time.com...`;
    });
}

if (REFRESH) REFRESH.addEventListener("click", loadGalleries);

if (CLEAR) {
    CLEAR.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "CLEAR_HISTORY" });
    await loadGalleries();
    });
}

if (CLEAR_TRANSFER_BTN) {
    CLEAR_TRANSFER_BTN.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "CLEAR_ACTIVE_TRANSFER_ONLY" });
    const st = await fetchTransferState();
    renderTransferPanel(st);
    });
}

if (advToggle) {
    advToggle.addEventListener("click", () => {
    const open = advPanel.style.display === "block";
    advPanel.style.display = open ? "none" : "block";
    advToggle.textContent = open ? "Advanced options ▾" : "Advanced options ▴";
    });
}

const dbgBtn = document.getElementById("debugClearStorage");
if (dbgBtn) {
    dbgBtn.addEventListener("click", async () => {
    if (!confirm("Clear ALL extension data?")) return;
    await chrome.storage.local.clear();
    alert("Cache cleared!");
    location.reload();
    });
}

if (SAVE_AUTH) {
  SAVE_AUTH.addEventListener("click", async () => {
      // 1. Prepare Auth Token
      const authVal = (AUTH_INPUT.value || "").trim();

      // 2. Prepare Concurrency
      let concVal = 6; // default
      if (CONCURRENCY_INPUT) {
          concVal = Math.floor(Number(CONCURRENCY_INPUT.value));
          // Validate limits
          if (concVal < 1) concVal = 1;
          if (concVal > 20) concVal = 20;
          // Update the input visually in case we clamped it
          CONCURRENCY_INPUT.value = String(concVal);
      }

      // 3. Save BOTH to storage
      await chrome.storage.local.set({ 
          [AUTH_KEY]: authVal,
          [CONCURRENCY_KEY]: concVal
      });

      alert("Settings saved!");
  });
}

// --- ADDED MISSING CONCURRENCY AUTO-SAVE ---
if (CONCURRENCY_INPUT) {
    CONCURRENCY_INPUT.addEventListener("change", async () => {
        let val = Math.floor(Number(CONCURRENCY_INPUT.value));
        if(val < 1) val = 1; if(val > 20) val = 20;
        CONCURRENCY_INPUT.value = val;
        await chrome.storage.local.set({ [CONCURRENCY_KEY]: val });
    });
}

if (TRANSFER_SELECTED_BTN) {
  TRANSFER_SELECTED_BTN.addEventListener("click", handleTransferSelected);
}

if (DELAY_INPUT) {
  DELAY_INPUT.addEventListener("change", async () => {
    const ms = getDelayMs();
    DELAY_INPUT.value = String(ms);
    await chrome.storage.local.set({ [DELAY_KEY]: ms });
  });
}

if (LAST_RUN_TOGGLE) {
  LAST_RUN_TOGGLE.addEventListener("click", () => {
    lastRunCollapsed = !lastRunCollapsed;
    LAST_RUN_BODY.style.display = lastRunCollapsed ? "none" : "block";
    LAST_RUN_CHEVRON.textContent = lastRunCollapsed ? "▾" : "▴";
  });
}

if (RETRY_FAILED_BTN) {
  RETRY_FAILED_BTN.addEventListener("click", async () => {
    const lastRun = (await chrome.storage.local.get("pts_last_run"))["pts_last_run"];
    if (!lastRun || !lastRun.failures || !lastRun.failures.length) {
      alert("No failed images to retry.");
      return;
    }
    const sub = (SUBDOMAIN.value || "").trim();
    if (!sub) { alert("Enter subdomain."); return; }

    const resp = await chrome.runtime.sendMessage({
      type: "RETRY_FAILED_UPLOADS",
      projectId: lastRun.projectId,
      albumName: lastRun.albumName,
      failedFilenames: lastRun.failures.map(f => f.filename).filter(Boolean),
      domain: sub,
      delayMs: getDelayMs()
    });
    if (!resp?.ok) alert(`Retry failed: ${resp.error}`);
  });
}

if (CLEAR_LAST_RUN_BTN) {
  CLEAR_LAST_RUN_BTN.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "CLEAR_LAST_RUN_ONLY" });
    renderLastRunSummary({ total: 0 });
  });
}


if (DOWNLOAD_LOG_BTN) {
  DOWNLOAD_LOG_BTN.addEventListener("click", async () => {
    const data = await chrome.storage.local.get("pts_last_run");
    const lastRun = data["pts_last_run"];

    if (!lastRun) {
      alert("No log data available.");
      return;
    }

    // Construct the clean JSON
    const report = {
      meta: {
        exportedAt: new Date().toISOString(),
        domain: lastRun.domain || "unknown",
        totalAlbumsProcessed: lastRun.sessionLogs ? lastRun.sessionLogs.length : 1
      },
      summary: {
        totalImages: lastRun.total,
        totalFailed: lastRun.totalFailed || lastRun.failures?.length || 0,
        startedAt: new Date(lastRun.startedAt).toLocaleString(),
        finishedAt: new Date(lastRun.updatedAt).toLocaleString()
      },
      // The aggregated failure list mapped to albums
      allFailures: lastRun.allFailures || lastRun.failures || [],
      // The detailed per-album metrics
      albumDetails: lastRun.sessionLogs || []
    };

    // Create and trigger download
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement("a");
    a.href = url;
    a.download = `pictime-log-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  });
}


// ---------- Init ----------

(async () => {
  const data = await chrome.storage.local.get([SUBDOMAIN_KEY, AUTH_KEY, DELAY_KEY, CONCURRENCY_KEY]);

  if (data[SUBDOMAIN_KEY] && SUBDOMAIN) SUBDOMAIN.value = data[SUBDOMAIN_KEY];
  if (data[AUTH_KEY] && AUTH_INPUT) AUTH_INPUT.placeholder = "•••••••• (saved)";

  if (DELAY_INPUT) {
    const dStored = data[DELAY_KEY];
    DELAY_INPUT.value = (typeof dStored === "number") ? String(dStored) : "0";
  }

  // --- ADDED MISSING CONCURRENCY INIT ---
  if (CONCURRENCY_INPUT) {
    const cStored = data[CONCURRENCY_KEY];
    CONCURRENCY_INPUT.value = (typeof cStored === "number") ? String(cStored) : "6";
  }

  await loadGalleries();

  const st = await fetchTransferState();
  renderTransferPanel(st);
  
  const lastRunStored = (await chrome.storage.local.get("pts_last_run"))["pts_last_run"];
  renderLastRunSummary(lastRunStored);

  startTransferPoller();
})();