// The AI check's settings. Saved as "ai" in chrome.storage.local; the
// service worker (ai.js, background.js) reads them from there.
const PRESETS = {
  deepseek: { baseUrl: "https://api.deepseek.com", model: "deepseek-chat" },
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
};
// A private build can carry a key (ai-builtin.js): then the check starts on.
const BUILTIN = String(self.AI_BUILTIN_KEY || "").trim();
const DEFAULTS = { enabled: !!BUILTIN, baseUrl: PRESETS.deepseek.baseUrl, model: PRESETS.deepseek.model, apiKey: BUILTIN, every: 8, stuckAfter: 10, screenshot: false };

const $ = (id) => document.getElementById(id);
const out = $("out");

function say(text, kind = "") {
  out.textContent = text;
  out.className = kind;
}

function presetOf(c) {
  for (const [k, p] of Object.entries(PRESETS)) if (c.baseUrl.replace(/\/+$/, "") === p.baseUrl) return k;
  return "custom";
}

function read() {
  return {
    enabled: $("enabled").checked,
    baseUrl: $("baseUrl").value.trim().replace(/\/+$/, ""),
    model: $("model").value.trim(),
    apiKey: $("apiKey").value.trim(),
    every: Math.max(5, Math.min(10, Math.round(Number($("every").value)) || DEFAULTS.every)),
    stuckAfter: Math.max(5, Math.min(120, Math.round(Number($("stuckAfter").value)) || DEFAULTS.stuckAfter)),
    screenshot: $("screenshot").checked,
  };
}

function fill(c) {
  $("enabled").checked = c.enabled;
  $("baseUrl").value = c.baseUrl;
  $("model").value = c.model;
  $("apiKey").value = c.apiKey || BUILTIN;
  $("every").value = c.every;
  $("stuckAfter").value = c.stuckAfter;
  $("screenshot").checked = c.screenshot;
  $("preset").value = presetOf(c);
}

chrome.storage.local.get("ai").then((v) => fill({ ...DEFAULTS, ...(v.ai || {}) }));

$("preset").addEventListener("change", (e) => {
  const p = PRESETS[e.target.value];
  if (!p) return;
  $("baseUrl").value = p.baseUrl;
  $("model").value = p.model;
});

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const c = read();
  if (c.enabled && (!c.apiKey || !/^https?:\/\/./.test(c.baseUrl) || !c.model)) return say("Fill in the API address, the model and the API key to turn the check on.", "bad");
  await chrome.storage.local.set({ ai: c });
  fill(c);
  say(c.enabled ? "Saved. The AI check is on." : "Saved. The AI check is off.", "ok");
});

$("test").addEventListener("click", async () => {
  say("Asking the AI about a sample signed-in page...");
  try {
    const r = await chrome.runtime.sendMessage({ target: "ai", type: "test", config: read() });
    if (!r) return say("No answer from TinyTab. Reload the extension and try again.", "bad");
    if (!r.ok) return say(`It didn't work: ${r.error}`, "bad");
    const a = r.answer;
    const right = a.page === "home" && a.signedIn;
    say(`It works. The AI says: page "${a.page}", ${a.signedIn ? "signed in" : "not signed in"}${a.reason ? `, "${a.reason}"` : ""}.${right ? "" : " (Expected a signed-in home page; a stronger model may do better.)"}`, "ok");
  } catch (e) {
    say(`It didn't work: ${(e && e.message) || e}`, "bad");
  }
});
