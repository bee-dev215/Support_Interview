// Chrome-wide keyboard shortcuts for the extension's commands (users change them at chrome://extensions/shortcuts).
const FALLBACK = { _execute_action: "Open the panel and start listening on this tab" };

export async function getShortcuts() {
  return (await chrome.commands.getAll()).map((c) => ({
    name: c.name,
    shortcut: c.shortcut,
    description: c.description || FALLBACK[c.name] || c.name,
  }));
}

// "Alt+Shift+S" -> key caps. macOS reports symbols without "+", which become a single cap.
export const keyCaps = (shortcut) => shortcut.split(/\+(?!$)/)
  .map((k) => `<span class="kbd">${k.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c])}</span>`)
  .join(" ");

export const openShortcutSettings = () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
