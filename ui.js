// DARK MODE TOGGLE
(function () {
    const root = document.body;
    const btn = document.getElementById("darkToggle");
  
    function updateIcon() {
      btn.textContent = root.classList.contains("dark") ? "☀️" : "🌙";
    }
  
    // Auto-detect system theme (optional)
    if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
      root.classList.add("dark");
    }
    updateIcon();
  
    btn.addEventListener("click", () => {
      root.classList.toggle("dark");
      updateIcon();
    });
  })();
  
  
  // TOAST API (called from popup.js)
  window.showToast = function (message) {
    const t = document.getElementById("toast");
    t.textContent = message;
    t.classList.add("show");
    setTimeout(() => t.classList.remove("show"), 2200);
  };
  