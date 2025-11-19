console.log("[popup] Ready");

let lastStableEta = "";  // persists between renders
let lastRunCollapsed = true;


const AUTH_INPUT = document.getElementById("authTokenInput");
const SAVE_AUTH = document.getElementById("saveAuthBtn");
const AUTH_KEY = "pts_auth_token";

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

const SUBDOMAIN_KEY = "pts_subdomain";
const advToggle = document.getElementById("advancedToggle");
const advPanel = document.getElementById("advancedPanel");

// NEW: bulk + delay
const TRANSFER_ALL_BTN = document.getElementById("transferAllBtn");
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

let transferAllRunning = false;

// --- ETA Helpers --------------------------------------------------------

let lastSpeedSample = null; 
let lastCompleted    = null;
let lastTime         = null;

function estimateEta(total, completed) {
  if (!total || completed === 0) return null;

  const now = Date.now();

  // First time sample
  if (lastSpeedSample === null) {
    lastSpeedSample = completed;
    lastCompleted    = completed;
    lastTime         = now;
    return null;
  }

  // Sample every 2 seconds
  if (now - lastTime < 2000) return null;

  const deltaCompleted = completed - lastCompleted;
  const deltaTime = (now - lastTime) / 1000; // seconds

  if (deltaCompleted <= 0) return null;

  const speed = deltaCompleted / deltaTime; // items per second
  const remaining = total - completed;
  const etaSeconds = Math.round(remaining / speed);

  // Update for next sample
  lastCompleted = completed;
  lastTime = now;

  return etaSeconds;
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

// ---------- Delay helper ----------

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
  document.querySelectorAll("button").forEach((btn) => {
    if (btn.textContent === "Transfer") {
      btn.disabled = running || btn.disabled; // keep disabled if input invalid
    }
  });
}

function renderTransferPanel(state) {
  if (!state || (!state.running && state.total === 0 && state.completed === 0)) {
    TRANSFER_PANEL.style.display = "none";
    // also hide last run if nothing ever ran
    return;
  }

  TRANSFER_PANEL.style.display = "block";

  const { running, albumName, total, completed, successes, failures } = state;

  const safeTotal = total || 0;
  const safeCompleted = completed || 0;
  const pct = safeTotal > 0 ? Math.round((safeCompleted / safeTotal) * 100) : 0;

  // NEW: reset ETA state when a new run starts (completed=0)
  if (running && safeCompleted === 0) {
    lastSpeedSample = null;
    lastCompleted = null;
    lastTime = null;
    lastStableEta = "";
  }

  TRANSFER_BAR.style.width = `${pct}%`;

  if (running) {
    TRANSFER_PROGRESS.textContent = `Transferring "${albumName || ""}" — ${pct}%`;

    const etaSeconds = estimateEta(safeTotal, safeCompleted);

    if (etaSeconds && etaSeconds > 0) {
      lastStableEta = formatEta(etaSeconds);
    }

    if (TRANSFER_ETA) TRANSFER_ETA.textContent = lastStableEta;
  } else {
    TRANSFER_PROGRESS.textContent =
      `Transfer completed — ${pct}% done (${successes?.length || 0} OK, ${failures?.length || 0} failed)`;

    lastStableEta = "";
    if (TRANSFER_ETA) TRANSFER_ETA.textContent = "";
  }

  if (failures && failures.length) {
    const firstFive = failures.slice(0, 5);
    const more = failures.length > 5 ? ` (+${failures.length - 5} more)` : "";
    TRANSFER_FAILURES.textContent =
      "Failed: " + firstFive.map((f) => f.filename).join(", ") + more;
  } else {
    TRANSFER_FAILURES.textContent = "";
  }

  applyTransferStateToButtons(state);
}

function renderLastRunSummary(state) {
  if (!LAST_RUN_CONTAINER) return;

  // Always show the container
  LAST_RUN_CONTAINER.style.display = "block";

  // No state or no previous run
  if (!state || state.total === 0) {
    LAST_RUN_TEXT.innerHTML = `<div>No previous transfers recorded.</div>`;
    LAST_RUN_FAILURES_LIST.textContent = "";
    if (RETRY_FAILED_BTN) RETRY_FAILED_BTN.disabled = true;

    // Apply collapsed/expanded state
    if (LAST_RUN_BODY && LAST_RUN_CHEVRON) {
      LAST_RUN_BODY.style.display = lastRunCollapsed ? "none" : "block";
      LAST_RUN_CHEVRON.textContent = lastRunCollapsed ? "▾" : "▴";
    }
    return;
  }

  if (state.running) {
    LAST_RUN_TEXT.innerHTML = `<div>Transfer in progress…</div>`;
    LAST_RUN_FAILURES_LIST.textContent = "";
    if (RETRY_FAILED_BTN) RETRY_FAILED_BTN.disabled = true;

    if (LAST_RUN_BODY && LAST_RUN_CHEVRON) {
      LAST_RUN_BODY.style.display = lastRunCollapsed ? "none" : "block";
      LAST_RUN_CHEVRON.textContent = lastRunCollapsed ? "▾" : "▴";
    }
    return;
  }

  // ---- NORMAL LAST-RUN RENDER ----
  const {
    albumName,
    projectId,
    total,
    successes,
    failures,
    startedAt,
    updatedAt
  } = state;

  const okCount = successes?.length || 0;
  const failCount = failures?.length || 0;

  LAST_RUN_TEXT.innerHTML = `
    <div><strong>Album:</strong> ${escapeHtml(albumName || "")}</div>
    <div><strong>Project ID:</strong> <code>${escapeHtml(projectId ?? "—")}</code></div>
    <div><strong>Total images:</strong> ${total}</div>
    <div><strong>Success:</strong> ${okCount} &nbsp; <strong>Failed:</strong> ${failCount}</div>
    <div><strong>Started:</strong> ${escapeHtml(new Date(startedAt).toLocaleString())}</div>
    <div><strong>Finished:</strong> ${escapeHtml(new Date(updatedAt).toLocaleString())}</div>
  `;

  if (failCount) {
    const firstFive = failures.slice(0, 5).map(f => escapeHtml(f.filename)).join(", ");
    const more = failCount > 5 ? ` (+${failCount - 5} more)` : "";
    LAST_RUN_FAILURES_LIST.textContent = `Failed files: ${firstFive}${more}`;
    if (RETRY_FAILED_BTN) RETRY_FAILED_BTN.disabled = false;
  } else {
    LAST_RUN_FAILURES_LIST.textContent = "No failed images in last run.";
    if (RETRY_FAILED_BTN) RETRY_FAILED_BTN.disabled = true;
  }

  // Apply collapsed/expanded state
  if (LAST_RUN_BODY && LAST_RUN_CHEVRON) {
    LAST_RUN_BODY.style.display = lastRunCollapsed ? "none" : "block";
    LAST_RUN_CHEVRON.textContent = lastRunCollapsed ? "▾" : "▴";
  }
}



// poll transfer state while popup is open
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

// ---------- Galleries ----------

async function loadGalleries() {
  const { pts_galleries } = await chrome.storage.local.get("pts_galleries");
  const galleries = pts_galleries || [];

  GALLERIES.innerHTML = "";
  if (!galleries.length) {
    STATUS.textContent = "No galleries captured yet.";
    GALLERIES.innerHTML =
      '<div class="empty">No galleries found<span>Use “Start Capture” to load your Pic-Time dashboard.</span></div>';
    return;
  }

  STATUS.textContent = `Found ${galleries.length} galler${
    galleries.length > 1 ? "ies" : "y"
  }`;

  galleries.forEach((g) => {
    const card = document.createElement("div");
    card.className = "gallery";

    const head = document.createElement("div");
    head.className = "gallery-head";

    const name = document.createElement("div");
    name.className = "gallery-name";
    name.textContent = g.name;

    const chip = document.createElement("div");
    chip.className = "meta-chip";
    chip.textContent = `${g.mediaCount || 0} items`;

    head.append(name, chip);

    const controls = document.createElement("div");
    controls.className = "btn-row";

    const detailsBtn = document.createElement("button");
    detailsBtn.className = "btn-secondary";
    detailsBtn.textContent = "Details";
    detailsBtn.setAttribute("aria-expanded", "false");

    controls.append(detailsBtn);

    const details = document.createElement("div");
    details.className = "details";

    const kvName = document.createElement("div");
    kvName.className = "kv";
    kvName.innerHTML = `<strong>Name:</strong> ${escapeHtml(g.name)}`;

    const kvId = document.createElement("div");
    kvId.className = "kv";
    kvId.innerHTML = `<strong>Project ID:</strong> <code>${escapeHtml(
      g.projectId ?? "—"
    )}</code>`;

    const kvToken = document.createElement("div");
    kvToken.className = "kv";
    kvToken.innerHTML = `<strong>Token:</strong> <code>${escapeHtml(
      g.token ?? "—"
    )}</code>`;

    const kvCount = document.createElement("div");
    kvCount.className = "kv";
    kvCount.innerHTML = `<strong>Media:</strong> ${escapeHtml(g.mediaCount ?? 0)}`;

    details.append(kvName, kvId, kvToken, kvCount);

    // --- DOWNLOAD + TRANSFER ---
    if ((g.mediaCount || 0) > 0) {
      const dlWrap = document.createElement("div");
      dlWrap.className = "download";

      const maxN = Number(g.mediaCount || 0);
      const input = document.createElement("input");
      input.type = "number";
      input.min = "1";
      input.max = String(maxN);
      input.placeholder = `1 – ${maxN}`;
      input.inputMode = "numeric";

      const btnDownload = document.createElement("button");
      btnDownload.textContent = "Download";
      btnDownload.disabled = true;

      const btnTransfer = document.createElement("button");
      btnTransfer.textContent = "Transfer";
      btnTransfer.disabled = true;

      input.addEventListener("input", () => {
        const n = clamp(Number(input.value || 0), 1, maxN);
        if (String(n) !== input.value) input.value = String(n || "");
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

        // extra guard: do not start if running
        const st = await fetchTransferState();
        if (st?.running) {
          alert("A transfer is already running. Wait for it to finish.");
          return;
        }

        btnTransfer.textContent = "Starting...";
        btnTransfer.disabled = true;

        const delayMs = getDelayMs();

        const resp = await chrome.runtime.sendMessage({
          type: "TRANSFER_TO_GCP",
          gallery: g,
          count: n,
          domain: sub,
          delayMs
        });

        if (!resp?.ok) {
          btnTransfer.textContent = "Error";
          setTimeout(() => {
            btnTransfer.textContent = "Transfer";
            btnTransfer.disabled = false;
          }, 2000);
          return;
        }

        btnTransfer.textContent = "Transferring...";
        // background will keep updating state, poller will update UI
      });

      dlWrap.append(input, btnDownload, btnTransfer);

      const note = document.createElement("div");
      note.className = "note";
      note.textContent = `Limit: up to ${maxN} images`;

      details.append(dlWrap, note);
    } else {
      const note = document.createElement("div");
      note.className = "note";
      note.textContent = "This gallery has no media items.";
      details.append(note);
    }

    detailsBtn.addEventListener("click", () => {
      const open = details.classList.toggle("open");
      detailsBtn.setAttribute("aria-expanded", String(open));
      detailsBtn.textContent = open ? "Hide details" : "Details";
    });

    card.append(head, controls, details);
    GALLERIES.appendChild(card);
  });

  // after building cards, apply current transfer state (disable transfer buttons if running)
  const st = await fetchTransferState();
  if (st) renderTransferPanel(st);
}

// ---------- Bulk transfer helpers ----------

async function waitForTransferToFinish() {
  while (true) {
    const st = await fetchTransferState();
    if (!st || !st.running) return st;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function handleTransferAll() {
  if (transferAllRunning) return;

  const sub = (SUBDOMAIN.value || "").trim();
  if (!sub) {
    SUBDOMAIN.focus();
    return;
  }

  const delayMs = getDelayMs();

  transferAllRunning = true;
  if (TRANSFER_ALL_BTN) {
    TRANSFER_ALL_BTN.disabled = true;
    TRANSFER_ALL_BTN.textContent = "Transferring all…";
  }

  try {
    const resp = await chrome.runtime.sendMessage({
      type: "TRANSFER_ALL_GALLERIES",
      domain: sub,
      delayMs
    });

    if (!resp?.ok) {
      alert(resp.error || "Could not start bulk transfer.");
    }
  } finally {
    transferAllRunning = false;
    if (TRANSFER_ALL_BTN) {
      TRANSFER_ALL_BTN.disabled = false;
      TRANSFER_ALL_BTN.textContent = "Transfer all galleries";
    }
  }
}

// ---------- Basic controls ----------

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
  const [activeTab] = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });
  if (activeTab?.id) {
    await chrome.tabs.update(activeTab.id, { url: DASH_URL });
  } else {
    await chrome.tabs.create({ url: DASH_URL });
  }

  STATUS.textContent = `Opening ${sub}.pic-time.com...`;
});

REFRESH.addEventListener("click", loadGalleries);

CLEAR.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "CLEAR_HISTORY" });
  await loadGalleries();
});

CLEAR_TRANSFER_BTN.addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "CLEAR_ACTIVE_TRANSFER_ONLY" });
  const st = await fetchTransferState();
  renderTransferPanel(st);
});


advToggle.addEventListener("click", () => {
  const open = advPanel.style.display === "block";
  advPanel.style.display = open ? "none" : "block";
  advToggle.textContent = open ? "Advanced options ▾" : "Advanced options ▴";
});

document.getElementById("debugClearStorage").addEventListener("click", async () => {
  if (!confirm("Clear ALL extension data? This will reset galleries, vPaths, history, and transfer state.")) {
    return;
  }

  await chrome.storage.local.clear();

  alert("Cache cleared! Please refresh or reopen the extension.");
  location.reload();
});

SAVE_AUTH.addEventListener("click", async () => {
  const val = (AUTH_INPUT.value || "").trim();
  await chrome.storage.local.set({ [AUTH_KEY]: val });
  alert("Backend auth key saved. Future transfers will include this key.");
});

if (TRANSFER_ALL_BTN) {
  TRANSFER_ALL_BTN.addEventListener("click", handleTransferAll);
}

if (DELAY_INPUT) {
  DELAY_INPUT.addEventListener("change", async () => {
    const ms = getDelayMs();
    DELAY_INPUT.value = String(ms);
    await chrome.storage.local.set({ [DELAY_KEY]: ms });
  });
}


// Last run toggle (collapse/expand)
if (LAST_RUN_TOGGLE) {
  LAST_RUN_TOGGLE.addEventListener("click", () => {
    lastRunCollapsed = !lastRunCollapsed;

    LAST_RUN_BODY.style.display = lastRunCollapsed ? "none" : "block";
    LAST_RUN_CHEVRON.textContent = lastRunCollapsed ? "▾" : "▴";
  });
}

// Retry failed images
if (RETRY_FAILED_BTN) {
  RETRY_FAILED_BTN.addEventListener("click", async () => {
    const lastRun = (await chrome.storage.local.get("pts_last_run"))["pts_last_run"];
    if (!lastRun) {
      alert("No previous run to retry.");
      return;
    }

    const failures = lastRun.failures || [];
    if (!failures.length) {
      alert("No failed images to retry.");
      return;
    }

    const sub = (SUBDOMAIN.value || "").trim();
    if (!sub) {
      alert("Enter your Pic-Time subdomain first.");
      SUBDOMAIN.focus();
      return;
    }

    const delayMs = getDelayMs();

    const resp = await chrome.runtime.sendMessage({
      type: "RETRY_FAILED_UPLOADS",
      projectId: lastRun.projectId,
      albumName: lastRun.albumName,
      failedFilenames: failures.map(f => f.filename).filter(Boolean),
      domain: sub,
      delayMs
    });

    if (!resp?.ok) {
      alert(`Could not start retry: ${resp.error || "unknown error"}`);
    }
  });
}


// Clear last run (reuse CLEAR_TRANSFER_LOG)
if (CLEAR_LAST_RUN_BTN) {
  CLEAR_LAST_RUN_BTN.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "CLEAR_LAST_RUN_ONLY" });
    renderLastRunSummary({ total: 0 }); // reset UI
  });
  
}
// ---------- init ----------

(async () => {
  const saved = (await chrome.storage.local.get(SUBDOMAIN_KEY))[SUBDOMAIN_KEY];
  if (saved) SUBDOMAIN.value = saved;

  // load saved auth token (don’t auto-show; just indicate it exists)
  const stored = await chrome.storage.local.get(AUTH_KEY);
  if (stored[AUTH_KEY]) {
    AUTH_INPUT.placeholder = "•••••••• (saved)";
  }

  // restore delay
  if (DELAY_INPUT) {
    const dStored = (await chrome.storage.local.get(DELAY_KEY))[DELAY_KEY];
    if (typeof dStored === "number") {
      DELAY_INPUT.value = String(dStored);
    } else {
      DELAY_INPUT.value = "0";
    }
  }

  
  await loadGalleries();

  const st = await fetchTransferState();
  renderTransferPanel(st);

// load last run snapshot
const lastRunStored = (await chrome.storage.local.get("pts_last_run"))["pts_last_run"];
renderLastRunSummary(lastRunStored);

  startTransferPoller();
})();