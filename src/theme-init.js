// Applies the Appearance setting (system / light / dark) before first paint and keeps open pages in sync.
// Classic script loaded in <head>: extension pages share localStorage, which is read synchronously;
// chrome.storage.local stays the source of truth.
(() => {
  const root = document.documentElement;
  const apply = (theme) => {
    if (theme === "light" || theme === "dark") root.dataset.theme = theme;
    else delete root.dataset.theme;
    try { localStorage.setItem("theme", theme ?? "system"); } catch {}
  };
  try { apply(localStorage.getItem("theme")); } catch {}
  chrome.storage.local.get("theme").then(({ theme }) => apply(theme));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.theme) apply(changes.theme.newValue);
  });
})();
