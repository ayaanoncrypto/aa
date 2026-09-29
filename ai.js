// TinyTab AI check: asks a chat model what a playing tab shows.
// DeepSeek by default; any OpenAI-style chat API works (base URL, model and
// key, set on the options page). Loaded into the service worker by background.js.
//
// What leaves the computer, and only when the check is on and a step is stuck:
// the tab's address (without the query), its title, the first part of its
// visible text, the names of its buttons, links and fields (never what is
// typed in them) and the step TinyTab waits to do. A screenshot only when
// "Send a screenshot" is on.

const AI_DEFAULTS = {
  enabled: false,
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-chat",
  apiKey: "",
  every: 8, // seconds between checks while a step waits (5 to 10)
  stuckAfter: 10, // seconds on one step before the first check
  screenshot: false, // for models that read images
};
const AI_PAGES = ["expected", "start", "home", "login", "error", "blank", "loading", "other"];
const AI_TIMEOUT_MS = 25000;

let aiConfig = { ...AI_DEFAULTS };
const aiLoaded = chrome.storage.local.get("ai").then(
  (v) => {
    aiConfig = cleanAiConfig(v.ai);
  },
  () => {}
);

function cleanAiConfig(raw) {
  const c = { ...AI_DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) };
  c.enabled = !!c.enabled;
  c.baseUrl = String(c.baseUrl || "").trim().replace(/\/+$/, "");
  c.model = String(c.model || "").trim();
  c.apiKey = String(c.apiKey || "").trim();
  c.every = Math.max(5, Math.min(10, Math.round(Number(c.every)) || AI_DEFAULTS.every));
  c.stuckAfter = Math.max(5, Math.min(120, Math.round(Number(c.stuckAfter)) || AI_DEFAULTS.stuckAfter));
  c.screenshot = !!c.screenshot;
  return c;
}

const aiUsable = (c = aiConfig) => c.enabled && !!c.apiKey && /^https?:\/\/./.test(c.baseUrl) && !!c.model;
const aiLabel = () => (aiUsable() ? aiConfig.model : "");

const AI_SYSTEM = `You watch TinyTab, a browser extension that replays a recorded task in a browser tab. You get a text snapshot of the tab (sometimes a screenshot too) and the step TinyTab is waiting to do. Answer with one JSON object and nothing else:
{"page": "...", "stuck": true or false, "signedIn": true or false, "atStart": true or false, "reason": "a few words"}

page, pick one:
- "expected": the page the waiting step belongs on, loaded normally. Content still arriving there (an email, a list) counts as expected.
- "start": the page where the recording began, ready for its first step.
- "home": a signed-in home screen, dashboard, wallet or account page that is not the page the step needs.
- "login": a sign-in or sign-up form that is not the page the step needs.
- "error": an error page (404, 500, "something went wrong", access denied, too many requests, blocked).
- "blank": an empty or white page.
- "loading": a spinner, skeleton or progress bar covering the page.
- "other": any other page, such as a promotion, an anniversary or event page, or another part of the site.

stuck: true when waiting longer won't help: the page is frozen, blank, stuck loading, or shows an error.
signedIn: true when the page shows a signed-in account (account menu, avatar, balance, log out control).
atStart: true when the page is ready for the recording's first step.`;

// The model's answer as { page, stuck, signedIn, atStart, reason }.
function parseAiAnswer(text) {
  const s = String(text || "");
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error(`the AI didn't answer in JSON: ${s.slice(0, 120)}`);
  const raw = JSON.parse(s.slice(a, b + 1));
  const page = String(raw.page || "").toLowerCase().trim();
  const yes = (v) => v === true || v === "true";
  return {
    page: AI_PAGES.includes(page) ? page : "other",
    stuck: yes(raw.stuck),
    signedIn: yes(raw.signedIn),
    atStart: yes(raw.atStart),
    reason: String(raw.reason || "").replace(/\s+/g, " ").trim().slice(0, 160),
  };
}

// Asks the model about one tab. snap: what the page reported (content/sense.js);
// job: the step TinyTab waits for; shot: a data: URL or null.
async function aiAsk(snap, job, shot, cfg = aiConfig) {
  const text = JSON.stringify({ task: job, tab: snap || "the page did not answer" });
  const content = shot ? [{ type: "text", text }, { type: "image_url", image_url: { url: shot } }] : text;
  const body = {
    model: cfg.model,
    temperature: 0,
    max_tokens: 300,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: AI_SYSTEM },
      { role: "user", content },
    ],
  };
  const post = async (payload) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), AI_TIMEOUT_MS);
    try {
      return await fetch(cfg.baseUrl + "/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new Error(e && e.name === "AbortError" ? `no answer in ${AI_TIMEOUT_MS / 1000} s` : String((e && e.message) || e));
    } finally {
      clearTimeout(timer);
    }
  };
  let r = await post(body);
  if (r.status === 400) {
    // Some models don't take response_format; the prompt asks for JSON anyway.
    delete body.response_format;
    r = await post(body);
  }
  if (!r.ok) throw new Error(`${r.status} ${(await r.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 200)}`);
  const data = await r.json();
  const msg = data && data.choices && data.choices[0] && data.choices[0].message;
  return parseAiAnswer(msg && msg.content);
}

// A picture of the tab, for models that read images. Through the debugger
// connection that keeps playing tabs awake (works for tabs in the back), else
// only when the tab is the one in front.
async function aiShot(tabId, viaDebugger) {
  if (!aiConfig.screenshot) return null;
  const within = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error("timeout")), ms))]);
  try {
    if (viaDebugger) {
      const r = await within(chrome.debugger.sendCommand({ tabId }, "Page.captureScreenshot", { format: "jpeg", quality: 45 }), 8000);
      if (r && r.data) return "data:image/jpeg;base64," + r.data;
    }
    const tab = await chrome.tabs.get(tabId);
    if (tab.active) return await within(chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 45 }), 8000);
  } catch (_) {}
  return null;
}

// "Test" on the options page: one question about a made-up signed-in page.
// Only TinyTab's own pages may ask (never a web page).
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || msg.target !== "ai" || sender.id !== chrome.runtime.id) return;
  if (!String(sender.url || "").startsWith(chrome.runtime.getURL(""))) return;
  if (msg.type !== "test") return;
  const cfg = cleanAiConfig({ ...msg.config, enabled: true });
  if (!aiUsable(cfg)) {
    reply({ ok: false, error: "Fill in the address, the model and the API key first." });
    return;
  }
  const snap = {
    url: "https://example.com/dashboard",
    title: "Dashboard",
    readyState: "complete",
    quietSec: 12,
    loaders: 0,
    headings: ["Welcome back, Sam"],
    text: "Welcome back, Sam. Total balance 120.00 USDT. Deposit Withdraw Anniversary rewards Log out",
    controls: ["Deposit", "Withdraw", "Sam", "Log out"],
    fields: [],
    dialogs: [],
    signOut: true,
  };
  const job = {
    question: "The run is about to start. Is this tab at the start of the recording, or still signed in from an earlier run?",
    recordingStartedOn: "https://example.com/register",
    firstStep: 'type into the "Email" field',
    waitingFor: { step: 1, of: 12, action: 'type into the "Email" field', recordedOn: "https://example.com/register" },
  };
  aiAsk(snap, job, null, cfg).then(
    (answer) => reply({ ok: true, answer }),
    (e) => reply({ ok: false, error: String((e && e.message) || e) })
  );
  return true;
});
