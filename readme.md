# Pic-Time Downloader / Sniffer  
#### *(Built for contributors, maintainers, and advanced Chrome extension developers)*

---

# ⭐️ Introduction

**Pic-Time Downloader / Sniffer** is a powerful Chrome Extension designed to automate interactions with the Pic-Time photography hosting platform.  
It provides:

- Intelligent dashboard metadata sniffing  
- Batch gallery browsing  
- High‑volume photo downloads  
- High‑speed cloud transfers using signed URLs  
- Automatic CAPTCHA detection and recovery  
- A clean pop‑up interface for controlling operations  

This README is designed to give **developers** a clear, complete, and actionable understanding of:

- How the extension works  
- How the components communicate  
- How to debug or extend features  
- How to safely modify or add new logic  

It is purposely **more descriptive and deeper** than typical READMEs while still being clean and structured.

---

# 📁 Project Structure

```
extension/
│
├── manifest.json
│   Defines permissions, content scripts, background worker, and host access.
│
├── background.js
│   The extension’s backend: downloads, transfers, queues, storage, concurrency,
│   backend communication, CAPTCHA pause/resume, and message handling.
│
├── content-main.js
│   Runs in Pic-Time’s MAIN JavaScript world. Provides:
│   • Bridge between isolated script and site JS
│   • unBlockMe() execution for CAPTCHA pages
│   • Capture forwarding (dashboard metadata)
│
├── content-isolated.js
│   Runs in the ISOLATED world. Handles:
│   • Intercepting fetch()
│   • Sniffing dashboard POST JSON
│   • Detecting Pic-Time blocks/CAPTCHAs
│   • Request forwarding to background.js
│
├── popup.html
│   UI container for the extension.
│
├── popup.js
│   Controls the UI, buttons, lists, form inputs, and messaging to background.js.
│
└── ui.js
    Theme switching, toast notifications, and common UI helpers.
```

This separation follows **Chrome Manifest V3** best practices.

---

# 🧠 Architecture Overview

The system is built around a **4‑layer architecture**, each responsible for different tasks:

---

## 1. **ISOLATED Content Script (`content-isolated.js`)**
Runs in Chrome’s isolated environment.  
Has access to the DOM but **not to page variables**.

Responsibilities:
- Intercepts Pic-Time’s internal API requests
- Monitors dashboard POST calls
- Extracts metadata payloads
- Detects CAPTCHA / “blocked user” states
- Forwards events to the MAIN world using:

```js
window.postMessage({ type: "...", payload: ... })
```

---

## 2. **MAIN Content Script (`content-main.js`)**
Injected into the actual Pic-Time JavaScript world.

Responsibilities:
- Listens for messages from isolated script
- Stores the last capture in `window.__pts_lastCapture`
- Executes **unBlockMe()** when triggered
- Provides a fallback DOM button click for unblock modals

This is necessary because **only MAIN world** has access to Pic-Time’s real JavaScript objects.

---

## 3. **Background Worker (`background.js`)**
The operational core of the extension.

Responsibilities:
- Fetch project photos from Pic-Time
- Queue downloads & transfers
- Control concurrency (1–20 threads)
- Persist all state to `chrome.storage.local`
- Detect network offline states
- Handle CAPTCHA pauses
- Communicate with your backend to generate signed URLs
- Upload photos to GCS
- Summaries, failures, and recovery

This file is the most important for performance and stability.

---

## 4. **Popup UI Layer**
**popup.html + popup.js + ui.js**

Responsibilities:
- List captured galleries
- Trigger downloads or transfers
- Display global and per-item progress
- Manage settings (API key, concurrency)
- Show toast notifications
- Allow retrying failed uploads
- Show last run summary

The popup acts as a **control panel**, not a logic engine.

---

# 🔌 Message Flow (Internal Communication)

Communication happens across three channels:

---

## 1. **Page ↔ Isolated Script**
Not allowed directly.  
Only DOM-level observation is possible.

---

## 2. **Isolated Script ↔ Main Script**
Uses:

```js
window.postMessage(...)
```

Main script validates events and exposes results.

---

## 3. **Popup / Content Scripts ↔ Background**
Uses:

```js
chrome.runtime.sendMessage()
chrome.runtime.onMessage.addListener()
```

This channel drives all functional logic (downloads, transfers, etc.).

---

# 🧩 Feature Deep-Dive (How Everything Works)

Below are the core features with detailed explanations.

---

## 📌 1. Dashboard Sniffing

### How it works
1. User opens their Pic-Time dashboard.
2. Pic-Time issues a POST request internally.
3. `content-isolated.js` intercepts the request using a monkey‑patched `fetch()`.
4. Checks if the endpoint matches the dashboard metadata endpoint.
5. Extracts:
   - User ID
   - Subdomain
   - Project list
   - Access permissions
   - Session identifiers
6. Sends it to MAIN script → background → popup.

### Why it exists
Pic-Time does not expose this data publicly via JS, so sniffing is required.

---

## 📌 2. Fetching Project Photos

Triggered when:
- User selects a project
- User clicks Download/Transfer

Background worker:
1. Calls Pic-Time’s `projectPhotos2` endpoint.
2. Uses the authenticated session from the browser.
3. Receives photo objects, image URLs, and metadata.
4. Sends list to popup for rendering.

---

## 📌 3. Downloading Photos

### How it works
1. Popup requests a list of photo URLs.
2. Background loops through:
   ```js
   chrome.downloads.download({ url })
   ```
3. Chrome saves each file automatically.

### Extension developer notes
- You can add filename templates.
- You can create per‑gallery folders.
- You can add retries & error stacks.

---

## 📌 4. Transfer to Cloud Storage

One of the most advanced features.

### Steps
1. Fetch Pic-Time image blob.
2. Request signed URL from backend:
   `/api/get-upload-url`
3. Upload via:
   ```js
   fetch(signedURL, { method: "PUT", body: blob })
   ```
4. Optionally call metadata endpoint.
5. Update progress.
6. Persist state in `chrome.storage.local`.

### Concurrency
The system uses a **promise pool**:

- Max 20 threads (clamped)
- User configurable
- Maintains speed without overwhelming Pic-Time

---

## 📌 5. CAPTCHA / Block Detection

### Signals used:
- Dashboard metadata missing fields
- Photo list unexpectedly empty
- Specific error responses
- DOM-based modal detection (MAIN world)

### Recovery options:
- Auto-run `window.unBlockMe()`
- Trigger fallback “unblock button” click
- Pause transfers until resolved
- Popup displays warning message

This is one of the trickiest areas, and the logic is clearly isolated to avoid corrupting state.

---

# 🛠 Development Guide

This is the practical "how to work on this project" section.

---

## ✔️ Installing the extension (Developer Mode)
1. Open Chrome.
2. Visit: `chrome://extensions`
3. Enable **Developer Mode**.
4. Click **Load Unpacked**.
5. Select project folder.

---

## ✔️ Editing files and reloading

| File Type | Requires Reload? | Notes |
|----------|------------------|-------|
| Content scripts | YES (Reload extension + refresh Pic-Time tab) | Needed because scripts are injected at page load |
| Background worker | YES (Reload extension) | Service worker restarts and picks up new logic |
| Popup files | No (just reopen popup) | Popup loads fresh every time |
| Manifest.json | YES (full reload) | Chrome re-processes permissions |

---

# 🐞 Debugging Guide

## 1. Debugging Content Scripts  
Open Pic-Time → DevTools → Console.

Check:

```js
window.__pts_lastCapture
```

### Look for logs:
- `[Pic-Time Sniffer ISOLATED]`
- `[Pic-Time Sniffer MAIN]`

---

## 2. Debugging Background Worker  
Go to:

```
chrome://extensions
→ “Service Worker” → Inspect
```

Useful command:

```js
chrome.storage.local.get(null, console.log)
```

---

## 3. Debugging Transfers  
Common issues:
- Expired signed URLs
- GCS CORS configuration
- Pic-Time session expired
- CAPTCHA blocks
- Network offline detection triggering pause

---

# 🔒 Security Notes for Developers

Important best practices:

- **Validate all messages** between isolated and main scripts using nonces.
- Remove unused host permissions.
- Avoid `window.postMessage("*")`.
- Avoid injecting arbitrary JS.
- Service worker must remain lightweight — avoid long synchronous tasks.


---

# 📘 Glossary

| Term | Meaning |
|------|---------|
| MAIN world | Executes inside page JS scope |
| ISOLATED world | Extension’s safe sandbox |
| MV3 | Manifest Version 3 |
| Service Worker | Background logic engine |
| Signed URL | Pre-authenticated GCS upload link |
| Sniffing | Intercepting hidden requests |
| CAPTCHA block | Pic-Time’s anti-bot lock |

---

# 🎉 End of README  