// The AI check's settings. Saved as "ai" in chrome.storage.local; the
// service worker (ai.js, background.js) reads them from there.
const PRESETS = self.AI_PROVIDERS; // ai-providers.js
// A private build can carry a key (ai-builtin.js): then the check starts on.
const BUILTIN = String(self.AI_BUILTIN_KEY || "").trim();
const SERVICE = PRESETS[aiProviderOf(BUILTIN)];
const DEFAULTS = { enabled: !!BUILTIN, baseUrl: SERVICE.baseUrl, model: SERVICE.model, apiKey: BUILTIN, every: 5, stuckAfter: 10, screenshot: SERVICE.screenshot, codeRule: true, codeMin: 65, goalLink: "8th Anniversary", goalButton: "Register", signedInText: "Go to Trade", pageRule: true, referralCode: "VZWLQHE", allowedPages: "the sign-up page, the send-code (verification code) page, the 8th Anniversary page" };

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
    codeRule: $("codeRule").checked,
    codeMin: Math.max(1, Math.min(300, Math.round(Number($("codeMin").value)) || DEFAULTS.codeMin)),
    goalLink: $("goalLink").value.trim(),
    goalButton: $("goalButton").value.trim(),
    signedInText: $("signedInText").value.trim(),
    pageRule: $("pageRule").checked,
    referralCode: $("referralCode").value.trim(),
    allowedPages: $("allowedPages").value.trim(),
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
  $("codeRule").checked = c.codeRule !== false;
  $("codeMin").value = c.codeMin;
  $("goalLink").value = c.goalLink;
  $("goalButton").value = c.goalButton;
  $("signedInText").value = c.signedInText == null ? DEFAULTS.signedInText : c.signedInText;
  $("pageRule").checked = c.pageRule !== false;
  $("referralCode").value = c.referralCode == null ? DEFAULTS.referralCode : c.referralCode;
  $("allowedPages").value = c.allowedPages == null ? DEFAULTS.allowedPages : c.allowedPages;
  $("preset").value = presetOf(c);
}

chrome.storage.local.get("ai").then((v) => fill({ ...DEFAULTS, ...(v.ai || {}) }));

function usePreset(k) {
  const p = PRESETS[k];
  if (!p) return;
  $("preset").value = k;
  $("baseUrl").value = p.baseUrl;
  $("model").value = p.model;
  $("screenshot").checked = p.screenshot;
}
$("preset").addEventListener("change", (e) => usePreset(e.target.value));

// A pasted key shows its service: switch to it, unless set up by hand.
$("apiKey").addEventListener("change", () => {
  const k = aiProviderOf($("apiKey").value);
  if ($("preset").value !== "custom" && $("preset").value !== k) usePreset(k);
});

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const c = read();
  if (c.enabled && (!c.apiKey || !/^https?:\/\/./.test(c.baseUrl) || !c.model)) return say("Fill in the API address, the model and the API key to turn the check on.", "bad");
  await chrome.storage.local.set({ ai: { ...c, v: 2 } });
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
