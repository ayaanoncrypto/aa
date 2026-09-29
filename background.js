// TinyTab service worker.
// Owns per-tab state, drives playback timing, and survives page navigations.
// Each tab has its own tape and its own player, so many tabs can run at once.
// One recording can also span several tabs ("linked tabs"): the tab where Rec
// was pressed leads, the others follow, and each step names its tab slot.

const DEFAULTS = {
  speed: "fast", // "fast" (skip your pauses), a number (recorded timing x N), or "max"
  repeat: 1,
  loop: false,
  startPage: true,
  shield: true,
  skipMissing: false,
  awake: true,
  recover: true, // lost connection or stuck page: reload, find the place, or start the run again
  resetSession: true, // a site that doesn't look like the recording's start: log out, else clear its data
};

const SPEEDS = ["fast", 0.5, 1, 2, 4, 8, "max"];
// Fast pace: the longest pause kept between steps. TinyTab waits for elements,
// page loads and copies itself, so your own pauses aren't needed on Play.
const FAST_WAIT_MS = 25;
// Fast pace: recorded typing shortened to at most this, and played 10x faster.
const FAST_TYPE_MS = 50;
const FAST_SPEED = 10;
const STEP_TYPES = new Set(["click", "dbl", "rclick", "input", "key", "scroll", "path", "nav", "copy", "paste", "hover"]);
const LEAD_TYPES = new Set(["click", "dbl", "rclick", "input", "key", "copy", "paste", "hover"]);
const MAX_DT = 10 * 60 * 1000;
const READY_TIMEOUT = 30000;
const PERFORM_TIMEOUT = 20000; // on top of the page's own wait for the element
// Recovery: how long a page may keep failing to load once the computer is
// online again, before TinyTab stops and plays the task again.
const RELOAD_GIVE_UP_MS = 90000;
// Chrome's error page for these ("Your connection was interrupted", "No
// internet", ...). Cancelled loads and downloads (ERR_ABORTED) are not errors.
const NET_ERROR = /^net::ERR_(INTERNET_DISCONNECTED|NETWORK_CHANGED|NETWORK_IO_SUSPENDED|NETWORK_ACCESS_DENIED|CONNECTION_[A-Z_]+|NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|ADDRESS_UNREACHABLE|TIMED_OUT|EMPTY_RESPONSE|SOCKET_NOT_CONNECTED|PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED|SSL_PROTOCOL_ERROR|HTTP2_[A-Z_]+|QUIC_PROTOCOL_ERROR)$/;

const COLORS = { rec: "#2E7A22", ink: "#23241E" };

importScripts("ai-providers.js", "ai-builtin.js", "ai.js"); // the AI check (AI settings on the options page)

// ---------- state ----------

const tabs = new Map(); // tabId -> persisted state
const players = new Map(); // tabId -> playback controller (not persisted)
const readyWaiters = new Map(); // tabId -> Set of resolvers
const navPending = new Map(); // tabId -> true while a cross-document load is in flight
const netErrors = new Map(); // tabId -> net::ERR_* while the tab shows Chrome's error page
const replays = new Map(); // tabId -> the wait before a stuck playback is played again
const alive = new Set(); // tabs whose page has TinyTab running (it said hello); no ping needed

let defaults = { ...DEFAULTS };
let lastTape = null;

// ---------- activity log ----------
// What playback did and what went wrong, newest last: plays, reloads,
// recoveries, restarts, warnings and TinyTab's own errors. Kept in local
// storage so "Save log" in the panel can write it to a file, even after Chrome
// stopped and restarted this worker.
const LOG_MAX = 400;
let logLines = [];
let logTimer = 0;
// The saved log is read when first needed, not each time the worker wakes.
let logRead = null;
const loadLog = () =>
  (logRead ||= chrome.storage.local.get("log").then(
    (v) => {
      logLines = [...(v.log || []), ...logLines].slice(-LOG_MAX);
    },
    () => {}
  ));
function log(text) {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  logLines.push(`${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}  ${String(text).slice(0, 600)}`);
  if (logLines.length > LOG_MAX) logLines = logLines.slice(-LOG_MAX);
  clearTimeout(logTimer);
  logTimer = setTimeout(() => loadLog().then(() => chrome.storage.local.set({ log: logLines })).catch(() => {}), 400);
}
self.addEventListener("error", (e) => log(`TinyTab error: ${e.message || e.error} (${e.filename || ""}:${e.lineno || ""})`));
self.addEventListener("unhandledrejection", (e) => log(`TinyTab error: ${(e.reason && (e.reason.stack || e.reason.message)) || e.reason}`));

const ready = (async () => {
  const [local, session] = await Promise.all([
    chrome.storage.local.get(["defaults", "lastTape"]),
    chrome.storage.session.get(null),
  ]);
  defaults = { ...DEFAULTS, ...(local.defaults || {}) };
  lastTape = local.lastTape || null;
  const open = new Set((await chrome.tabs.query({})).map((t) => t.id));
  for (const [key, value] of Object.entries(session)) {
    if (!key.startsWith("t:")) continue;
    const id = Number(key.slice(2));
    if (open.has(id)) {
      value.settings = { ...DEFAULTS, ...value.settings }; // settings added since it was saved
      if (value.tape && value.tape.isLast) value.tape = lastTape ? structuredClone(lastTape) : emptyTape(); // see persist
      tabs.set(id, value);
    } else chrome.storage.session.remove(key);
  }
  // Resume playback that was running when the worker was stopped.
  for (const [id, t] of tabs) {
    if (t.mode === "playing" && t.link == null) startPlayback(id, true);
    applyBadge(id);
  }
})();

function newTab() {
  return {
    on: false,
    mode: "idle", // idle | recording | playing
    tape: emptyTape(),
    settings: { ...defaults },
    play: { index: 0, run: 1 },
    error: "",
    lastAt: 0,
  };
}

function emptyTape(startUrl = "") {
  return { v: 4, name: "", startUrl, tabs: [{ startUrl }], createdAt: Date.now(), steps: [] };
}

// ---------- linked tabs ----------

// The tab that owns the recording or playback this tab takes part in.
function leaderOf(tabId) {
  const t = tabs.get(tabId);
  return t && t.link != null && tabs.has(t.link) ? t.link : tabId;
}

function groupOf(tabId) {
  const t = tabs.get(leaderOf(tabId));
  return t && t.group && t.group.length ? t.group : [tabId];
}

function tapeTabs(tape) {
  return tape.tabs && tape.tabs.length ? tape.tabs : [{ startUrl: tape.startUrl || "" }];
}

// Other tabs in the same window where TinyTab is on and free.
async function freeTabsNear(tabId) {
  const me = await chrome.tabs.get(tabId).catch(() => null);
  if (!me) return [];
  const list = await chrome.tabs.query({ windowId: me.windowId });
  return list
    .filter((x) => x.id !== tabId && tabs.get(x.id) && tabs.get(x.id).on && tabs.get(x.id).mode === "idle")
    .sort((a, b) => a.index - b.index);
}

function originOf(u) {
  try {
    return new URL(u).origin;
  } catch (_) {
    return "";
  }
}

function releaseMember(id) {
  const m = tabs.get(id);
  if (!m) return;
  delete m.link;
  m.mode = "idle";
  m.play = { index: 0, run: 1 };
  persist(id, true);
  notify(id);
}

// Whether tape is the last tape recorded or opened (lastTape), unchanged.
function isLastTape(tape) {
  return !!(lastTape && tape && tape.createdAt === lastTape.createdAt && tape.name === lastTape.name && tape.steps.length === lastTape.steps.length);
}

function getTab(tabId) {
  let t = tabs.get(tabId);
  if (!t) {
    t = newTab();
    tabs.set(tabId, t);
  }
  return t;
}

const saveTimers = new Map();
function persist(tabId, now = false) {
  clearTimeout(saveTimers.get(tabId));
  const write = () => {
    saveTimers.delete(tabId);
    const t = tabs.get(tabId);
    // A tab holding the last tape (most do) saves a note, not a copy: every
    // copy is read again each time the worker wakes, which slowed the toolbar.
    if (t) chrome.storage.session.set({ ["t:" + tabId]: isLastTape(t.tape) ? { ...t, tape: { isLast: true } } : t }).catch(() => {});
  };
  if (now) write();
  else saveTimers.set(tabId, setTimeout(write, 1000));
}

function snapshot(tabId) {
  const own = getTab(tabId);
  const lead = leaderOf(tabId);
  // A linked tab shows the leader's tape and progress.
  const t = own.link != null && lead !== tabId ? { ...tabs.get(lead), on: own.on, mode: own.mode } : own;
  const group = groupOf(tabId);
  const runs = t.settings.loop ? 0 : Math.max(1, t.settings.repeat | 0);
  return {
    on: t.on,
    mode: t.mode,
    settings: t.settings,
    ticks: t.tape.steps.map((s) => s.type),
    index: t.play.index,
    run: t.play.run,
    runs,
    error: t.error,
    name: t.tape.name,
    startUrl: t.tape.startUrl,
    linked: t.mode === "idle" ? tapeTabs(t.tape).length : group.length,
    slot: Math.max(0, group.indexOf(tabId)),
    ai: aiLabel(), // the AI check's model, "" when it's off
    aiAfter: aiConfig.stuckAfter,
  };
}

// ---------- messaging to tabs ----------

function send(tabId, msg) {
  return chrome.tabs.sendMessage(tabId, msg, { frameId: 0 });
}

function notify(tabId) {
  applyBadge(tabId);
  send(tabId, { type: "state", state: snapshot(tabId) }).catch(() => {});
}

function notifyGroup(tabId) {
  for (const id of groupOf(tabId)) notify(id);
}

function sendGroup(tabId, msg) {
  if (msg.type === "warn") log(msg.text);
  for (const id of groupOf(tabId)) send(id, msg).catch(() => {});
}

function sendWithTimeout(tabId, msg, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    send(tabId, msg).then(
      (r) => {
        clearTimeout(timer);
        resolve(r);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

// p, or a rejection after ms. For calls a frozen page can hold up for good.
function within(p, ms) {
  let timer;
  return Promise.race([p, new Promise((_, no) => (timer = setTimeout(() => no(new Error("timeout")), ms)))]).finally(() => clearTimeout(timer));
}

function markReady(tabId) {
  navPending.delete(tabId);
  const set = readyWaiters.get(tabId);
  if (!set) return;
  readyWaiters.delete(tabId);
  for (const fn of set) fn(true);
}

function waitReady(tabId, ms = READY_TIMEOUT, ctl) {
  return new Promise((resolve) => {
    let set = readyWaiters.get(tabId);
    if (!set) readyWaiters.set(tabId, (set = new Set()));
    const done = (ok) => {
      clearTimeout(timer);
      set.delete(done);
      if (ctl) ctl.wakers.delete(done);
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), ms);
    set.add(done);
    if (ctl) ctl.wakers.add(done);
  });
}

// ---------- badge and icon ----------

const iconCache = {};
function iconPaths(on) {
  const k = on ? "on" : "off";
  return (iconCache[k] ||= { 16: `icons/${k}-16.png`, 32: `icons/${k}-32.png` });
}

function applyBadge(tabId) {
  const t = tabs.get(tabId);
  const on = !!(t && t.on);
  const text = !on ? "" : t.mode === "recording" ? "REC" : t.mode === "playing" ? "RUN" : "ON";
  const title = !on
    ? "TinyTab: click to turn on"
    : t.mode === "recording"
      ? "TinyTab: recording. Click to turn off"
      : t.mode === "playing"
        ? "TinyTab: playing. Click to turn off"
        : "TinyTab: on. Click to turn off";
  chrome.action.setIcon({ tabId, path: iconPaths(on) }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: t && t.mode === "idle" ? COLORS.ink : COLORS.rec }).catch(() => {});
  chrome.action.setBadgeTextColor?.({ tabId, color: "#FFFFFF" })?.catch?.(() => {});
  chrome.action.setTitle({ tabId, title }).catch(() => {});
}

async function flashBlocked(tabId) {
  await chrome.action.setBadgeText({ tabId, text: "!" }).catch(() => {});
  await chrome.action.setBadgeBackgroundColor({ tabId, color: COLORS.ink }).catch(() => {});
  await chrome.action.setTitle({ tabId, title: "TinyTab can't run on this page" }).catch(() => {});
  setTimeout(() => applyBadge(tabId), 2500);
}

// ---------- content script injection ----------

const CONTENT_FILES = chrome.runtime.getManifest().content_scripts[0].js;

async function ensureContent(tabId) {
  if (alive.has(tabId)) return true;
  try {
    const pong = await sendWithTimeout(tabId, { type: "ping" }, 1500);
    if (pong && pong.ok) {
      alive.add(tabId);
      return true;
    }
  } catch (_) {}
  try {
    await within(chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ["content/clipboard-main.js"], world: "MAIN" }), 10000).catch(() => {});
    await within(chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: CONTENT_FILES }), 10000);
    return true;
  } catch (_) {
    return false;
  }
}

// ---------- on / off ----------

async function setOn(tabId, on) {
  await ready;
  const t = getTab(tabId);
  if (on === t.on) {
    if (on) await ensureContent(tabId);
    notify(tabId);
    if (on && t.mode === "idle") await joinRecording(tabId);
    return t.on;
  }
  if (on) {
    const ok = await ensureContent(tabId);
    if (!ok) {
      flashBlocked(tabId);
      return false;
    }
    t.on = true;
    t.error = "";
    if (!t.tape.steps.length && lastTape) t.tape = structuredClone(lastTape);
    notify(tabId); // the panel shows now; the rest can follow
    await joinRecording(tabId);
  } else {
    if (t.link != null && t.mode === "recording") {
      // Leaving a linked recording: this tab drops out, the others go on.
      const lead = tabs.get(t.link);
      if (lead && lead.group) lead.group = lead.group.filter((id) => id !== tabId);
      delete t.link;
    } else {
      if (t.mode === "playing") stopPlayback(tabId);
      if (t.mode === "recording") stopRecording(tabId);
    }
    t.on = false;
    t.mode = "idle";
  }
  persist(tabId, true);
  notify(tabId);
  return t.on;
}

chrome.action.onClicked.addListener(async (tab) => {
  await ready;
  const t = getTab(tab.id);
  setOn(tab.id, !t.on);
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  await ready;
  if (!tab) [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) return;
  const t = getTab(tab.id);
  if (!t.on && !(await setOn(tab.id, true))) return;
  if (command === "toggle-record") toggleRecord(tab.id, tab.url);
  if (command === "toggle-play") togglePlay(tab.id);
});

// ---------- recording ----------

// url: the tab's address, when the caller knows it.
async function toggleRecord(tabId, url) {
  cancelReplay(tabId);
  const t = getTab(tabId);
  if (t.mode === "recording") return stopRecording(tabId);
  if (t.mode === "playing") stopPlayback(tabId);
  // Recording from now on, before anything that waits: the page's first
  // steps count, and the panel shows it at once.
  t.tape = emptyTape(url || "");
  t.mode = "recording";
  t.error = "";
  t.lastAt = Date.now();
  t.play = { index: 0, run: 1 };
  t.group = [tabId];
  delete t.link;
  notify(tabId);
  if (!url) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab) t.tape.startUrl = t.tape.tabs[0].startUrl = tab.url;
  }
  // Every other TinyTab tab in this window joins the recording.
  for (const other of await freeTabsNear(tabId)) addMember(tabId, other.id, other.url);
  for (const id of t.group) freshHook(id);
  log(`Recording started on ${pageOf(t.tape.startUrl) || "this tab"} (${t.group.length} tab${t.group.length > 1 ? "s" : ""})`);
  persist(tabId, true);
  notifyGroup(tabId);
}

function addMember(leadId, id, url) {
  const lead = tabs.get(leadId);
  const m = tabs.get(id);
  if (!lead || !m || lead.group.includes(id)) return;
  freshHook(id);
  lead.group.push(id);
  lead.tape.tabs.push({ startUrl: url || "" });
  m.link = leadId;
  m.mode = "recording";
  m.error = "";
  persist(id, true);
}

// Switching to another tab during a recording pulls that tab in, so the task
// can move between sites without turning TinyTab on in each tab first.
chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  await ready;
  const t = tabs.get(tabId);
  if (t && t.mode !== "idle") return;
  for (const [id, lead] of tabs) {
    if (lead.mode !== "recording" || lead.link != null || id === tabId) continue;
    const info = await chrome.tabs.get(id).catch(() => null);
    if (info && info.windowId === windowId) {
      await setOn(tabId, true);
      return;
    }
  }
});

// A tab switched on during a recording in the same window joins it.
async function joinRecording(tabId) {
  const me = await chrome.tabs.get(tabId).catch(() => null);
  if (!me) return;
  for (const [id, t] of tabs) {
    if (id === tabId || t.mode !== "recording" || t.link != null) continue;
    const lead = await chrome.tabs.get(id).catch(() => null);
    if (lead && lead.windowId === me.windowId) {
      addMember(id, tabId, me.url);
      persist(id);
      notifyGroup(id);
      return;
    }
  }
}

function stopRecording(tabId) {
  tabId = leaderOf(tabId);
  const t = getTab(tabId);
  if (t.mode !== "recording") return;
  const members = (t.group || []).filter((id) => id !== tabId);
  log(`Recording stopped: ${t.tape.steps.length} steps`);
  t.mode = "idle";
  t.play = { index: 0, run: 1 };
  delete t.group;
  t.tape.createdAt = Date.now();
  // Drop tabs that never got a step, so the tape only names tabs it uses.
  const used = new Set(t.tape.steps.map((st) => st.tab || 0));
  used.add(0);
  const keep = tapeTabs(t.tape).map((_, i) => i).filter((i) => used.has(i));
  const remap = new Map(keep.map((old, i) => [old, i]));
  t.tape.tabs = keep.map((i) => t.tape.tabs[i]);
  for (const st of t.tape.steps) {
    const k = remap.get(st.tab || 0) || 0;
    if (k) st.tab = k;
    else delete st.tab;
  }
  if (t.tape.steps.length) {
    let host = "";
    try {
      host = new URL(t.tape.startUrl).hostname;
    } catch (_) {}
    const more = t.tape.tabs.length > 1 ? ` (${t.tape.tabs.length} tabs)` : "";
    t.tape.name = t.tape.name || `${host || "tape"}${more} ${new Date().toLocaleString()}`;
  }
  notify(tabId); // the panel first; saving a long tape takes a moment
  if (t.tape.steps.length) rememberTape(t.tape);
  for (const id of members) {
    const m = tabs.get(id);
    if (m && t.tape.steps.length) m.tape = structuredClone(t.tape);
    releaseMember(id);
  }
  persist(tabId, true);
}

function rememberTape(tape) {
  lastTape = structuredClone(tape);
  chrome.storage.local.set({ lastTape }).catch(() => {});
}

function targetKey(target) {
  return target ? (target.chain || []).join(" >> ") + "|" + target.tag : "";
}

// The page a step happened on, without the query (which can hold tokens).
function pageOf(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? u.origin + u.pathname : "";
  } catch (_) {
    return "";
  }
}

function appendStep(fromTab, step, at, url) {
  const from = tabs.get(fromTab);
  if (!from || from.mode !== "recording" || !STEP_TYPES.has(step.type)) return;
  // Lets playback find its place again after a reload lands somewhere else.
  const page = pageOf(url);
  if (page && step.type !== "nav") step.page = page;
  const tabId = leaderOf(fromTab);
  const t = getTab(tabId);
  if (t.mode !== "recording") return;
  const slot = Math.max(0, groupOf(tabId).indexOf(fromTab));
  if (slot) step.tab = slot;
  else delete step.tab;
  const steps = t.tape.steps;
  const last = steps[steps.length - 1];
  const sameTab = last && (last.tab || 0) === slot;

  // One refresh, told twice: by the page (F5 / Ctrl+R) and by Chrome.
  if (step.type === "nav" && step.kind === "reload" && sameTab && last.type === "nav" && last.kind === "reload" && at - t.lastAt < 5000) return;

  // Keystrokes into the same field become one "input" step with the final value.
  if (
    step.type === "input" &&
    sameTab &&
    last.type === "input" &&
    last.kind === step.kind &&
    targetKey(last.target) === targetKey(step.target)
  ) {
    last.value = step.value;
    last.checked = step.checked;
    last.dur = Math.min(at - last.t0, MAX_DT);
    t.lastAt = at;
    persist(tabId);
    return;
  }
  // Consecutive scroll updates of the same scroller collapse into one step.
  if (step.type === "scroll" && sameTab && last.type === "scroll" && targetKey(last.target) === targetKey(step.target)) {
    last.x = step.x;
    last.y = step.y;
    last.dur = Math.min(at - last.t0, 4000);
    t.lastAt = at;
    persist(tabId);
    return;
  }

  step.dt = Math.max(0, Math.min(at - t.lastAt, MAX_DT));
  if (step.type === "input" || step.type === "scroll") {
    step.t0 = at;
    step.dur = 0;
  }
  steps.push(step);
  t.lastAt = step.type === "path" && step.pts.length ? at + step.pts[step.pts.length - 1][0] : at;
  persist(tabId);
  sendGroup(tabId, { type: "tick", kind: step.type, count: steps.length });
}

// Navigations the user starts from the browser (address bar, reload, back/forward).
chrome.webNavigation.onCommitted.addListener(async (d) => {
  if (d.frameId !== 0) return;
  alive.delete(d.tabId); // a new page: TinyTab isn't running there until it says hello
  await ready;
  const t = tabs.get(d.tabId);
  if (!t) return;
  if (t.mode === "recording") {
    const q = d.transitionQualifiers || [];
    let step = null;
    if (q.includes("forward_back")) step = { type: "nav", kind: "goto", url: d.url };
    else if (d.transitionType === "reload") step = { type: "nav", kind: "reload" };
    else if (["typed", "auto_bookmark", "generated", "keyword"].includes(d.transitionType) && !q.includes("client_redirect"))
      step = { type: "nav", kind: "goto", url: d.url };
    if (step) appendStep(d.tabId, step, Date.now());
  }
  applyBadge(d.tabId);
});

chrome.webNavigation.onBeforeNavigate.addListener((d) => {
  if (d.frameId !== 0) return;
  const t = tabs.get(d.tabId);
  if (t && t.mode === "playing") navPending.set(d.tabId, true);
});

chrome.webNavigation.onErrorOccurred.addListener((d) => {
  if (d.frameId !== 0) return;
  // The connection dropped: Chrome shows its error page, where TinyTab can't run.
  if (NET_ERROR.test(d.error || "")) netErrors.set(d.tabId, d.error);
  // Downloads, 204 responses and aborted loads never produce a new page.
  if (navPending.get(d.tabId)) markReady(d.tabId);
});

// A page that loaded fully is not an error page any more.
chrome.webNavigation.onCompleted.addListener(async (d) => {
  if (d.frameId !== 0) return;
  netErrors.delete(d.tabId);
  await ready;
  // A tab opened during a recording shows Chrome's New Tab page first, where
  // TinyTab can't run, so it couldn't join. Once it shows a real page, and it
  // is the tab in front, it joins (as switching to it would have done).
  const t = tabs.get(d.tabId);
  if (t && t.mode !== "idle") return;
  const tab = await chrome.tabs.get(d.tabId).catch(() => null);
  if (!tab || !tab.active) return;
  for (const [id, lead] of tabs) {
    if (id === d.tabId || lead.mode !== "recording" || lead.link != null) continue;
    const info = await chrome.tabs.get(id).catch(() => null);
    if (info && info.windowId === tab.windowId) {
      await setOn(d.tabId, true);
      return;
    }
  }
});

// ---------- keep background tabs awake ----------
// Chrome stops drawing hidden tabs, and many sites stall without it. Focus
// emulation (through the debugger API) makes a playing tab render like the
// front tab. Chrome shows a "started debugging" bar while this is on.

const awakeTabs = new Set();

async function keepAwake(tabId) {
  try {
    // A frozen page can hold these up for good: go on without them.
    if (!awakeTabs.has(tabId)) await within(chrome.debugger.attach({ tabId }, "1.3").then(() => awakeTabs.add(tabId)), 5000);
    await within(chrome.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: true }), 5000);
  } catch (_) {
    // DevTools already open, or a page Chrome protects. Playback still runs.
  }
}

function letSleep(tabId) {
  if (!awakeTabs.has(tabId)) return;
  awakeTabs.delete(tabId);
  chrome.debugger.detach({ tabId }).catch(() => {});
}

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) awakeTabs.delete(source.tabId);
});

// ---------- playback ----------

const TAB_SWITCH_MS = 150;


// A typing step right after a paste in the same tab that only repeats (part of)
// the pasted text: code widgets report the paste as typing. Not real typing.
function strayAfterPaste(steps, i) {
  const st = steps[i];
  if (st.type !== "input" || st.kind !== "text") return false;
  const v = String(st.value || "");
  if (!v) return false;
  const slot = st.tab || 0;
  for (let k = i - 1, n = 0; k >= 0 && n < 4; k--, n++) {
    const p = steps[k];
    if ((p.tab || 0) !== slot) continue;
    if (p.type === "key") return false;
    if (p.type === "paste") return typeof p.text === "string" && p.text.includes(v);
  }
  return false;
}

// TinyTab's own clipboard for one playback. seq counts copies so a step can
// tell whether its own click copied something.
function setClip(ctl, text, fromTab) {
  ctl.clip = text;
  ctl.clipSeq++;
  // Like a real Ctrl+C: the computer's clipboard changes now, not at paste time.
  // Sites that read the clipboard as soon as a box is clicked get the fresh text.
  ctl.clipWrite = osClipWrite(text, fromTab);
  for (const id of ctl.group || []) send(id, { type: "clip", text }).catch(() => {});
  for (const fn of [...ctl.clipWaiters]) fn();
}

// ---------- the computer's clipboard ----------

let offscreenOpening = null;
async function ensureOffscreen() {
  if (!chrome.offscreen) return false;
  try {
    const open = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    if (open.length) return true;
    offscreenOpening ||= chrome.offscreen
      .createDocument({ url: "offscreen.html", reasons: ["CLIPBOARD"], justification: "Put the text TinyTab copies during playback on the clipboard." })
      .finally(() => (offscreenOpening = null));
    await offscreenOpening;
    return true;
  } catch (e) {
    return /single offscreen/i.test(String(e && e.message));
  }
}

let clipWrites = 0; // counted for the tests
// Puts text on the computer's clipboard. The hidden extension page does it
// whatever has focus; the tab itself (with a user gesture) is the backup.
async function osClipWrite(text, tabId) {
  if (await ensureOffscreen()) {
    try {
      if (await chrome.runtime.sendMessage({ target: "offscreen", type: "write", text })) {
        clipWrites++;
        return true;
      }
    } catch (_) {}
  }
  if (tabId != null && awakeTabs.has(tabId)) {
    try {
      const r = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
        expression: `navigator.clipboard.writeText(${JSON.stringify(text)}).then(() => true, () => false)`,
        userGesture: true,
        awaitPromise: true,
        returnByValue: true,
      });
      if (r && r.result && r.result.value === true) {
        clipWrites++;
        return true;
      }
    } catch (_) {}
  }
  return false;
}

// Adds the newest clipboard helper to a tab's page, replacing an older one
// left from before an extension update. Safe to repeat.
function freshHook(tabId) {
  return within(chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ["content/clipboard-main.js"], world: "MAIN" }), 5000).catch(() => {});
}

function waitClip(ctl, seq, ms) {
  if (ctl.clipSeq > seq) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      ctl.clipWaiters.delete(done);
      ctl.wakers.delete(done);
      resolve(ctl.clipSeq > seq);
    };
    const timer = setTimeout(done, ms);
    ctl.clipWaiters.add(done);
    ctl.wakers.add(done);
  });
}

function speedOf(t) {
  const s = t.settings.speed;
  return s === "max" ? Infinity : Math.max(0.1, Number(s) || 1);
}

function sleep(ms, ctl) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve) => {
    // Long waits are chunked with a cheap API call so the worker stays alive.
    let left = ms;
    let timer;
    const done = () => {
      clearTimeout(timer);
      ctl.wakers.delete(done);
      resolve();
    };
    const tick = () => {
      if (ctl.cancelled) return done();
      const chunk = Math.min(left, 20000);
      left -= chunk;
      timer = setTimeout(() => {
        if (left <= 0 || ctl.cancelled) return done();
        chrome.runtime.getPlatformInfo().catch(() => {});
        tick();
      }, chunk);
    };
    ctl.wakers.add(done);
    tick();
  });
}

function sameUrl(a, b) {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.origin === y.origin && x.pathname === y.pathname && x.search === y.search;
  } catch (_) {
    return a === b;
  }
}

async function navigate(tabId, ctl, how) {
  navPending.set(tabId, true);
  const waiting = waitReady(tabId, READY_TIMEOUT, ctl);
  if (how.kind === "reload") {
    await chrome.tabs.reload(tabId);
  } else {
    const tab = await chrome.tabs.get(tabId);
    const noHash = (u) => String(u || "").split("#")[0];
    if (noHash(tab.url) === noHash(how.url)) {
      // Same document: changing only the #hash would not reload the page.
      if (tab.url !== how.url) await chrome.tabs.update(tabId, { url: how.url });
      await chrome.tabs.reload(tabId);
    } else {
      await chrome.tabs.update(tabId, { url: how.url });
    }
  }
  return waiting;
}

// A real paste, the way a person does it: put the text on the clipboard, then
// press Ctrl+V as trusted input. Works however the site reads the paste.
// Needs the debugger connection that keeps playing tabs awake.
let nativePastes = 0; // counted for the tests
// One clipboard for the whole computer: tabs playing at once take turns, so a
// tab can't paste the text another tab just put there.
let pasteTurn = Promise.resolve();
function nativePaste(tabId, text) {
  const run = pasteTurn.then(() => nativePasteNow(tabId, text));
  pasteTurn = run.catch(() => {});
  return run;
}

async function nativePasteNow(tabId, text) {
  if (!awakeTabs.has(tabId)) return false;
  const target = { tabId };
  try {
    if (!(await osClipWrite(text, tabId))) return false;
    nativePastes++;
    const mac = (await chrome.runtime.getPlatformInfo()).os === "mac";
    const key = { key: "v", code: "KeyV", windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86, modifiers: mac ? 4 : 2 };
    await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", { type: "rawKeyDown", ...key, commands: ["paste"] });
    await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", { type: "keyUp", ...key });
    return true;
  } catch (_) {
    return false;
  }
}

// Whether a paste reached its box: the box (or its row of code boxes) now holds
// the text. Letters and digits only, since sites drop spaces or change case.
// True when it can't be told (the box is gone because the site moved on).
async function pasteLanded(tabId, target, text) {
  const squash = (s) => String(s || "").toLowerCase().replace(/[^\p{L}\p{N}@.]/gu, "");
  const want = squash(text);
  if (!want) return true;
  await new Promise((r) => setTimeout(r, 200)); // the site spreads the paste
  const r = await sendWithTimeout(tabId, { type: "fieldText", target }, 5000).catch(() => null);
  if (!r || typeof r.text !== "string") return true;
  return squash(r.text).includes(want);
}

async function performStep(tabId, ctl, msg) {
  if (msg.step.type === "paste") {
    const text = typeof msg.clip === "string" ? msg.clip : msg.step.text || "";
    const n = `Step ${msg.i + 1}`;
    if (awakeTabs.has(tabId)) {
      const res = await performStepOnce(tabId, ctl, { ...msg, native: true });
      if (!res || !res.ok || ctl.cancelled) return res;
      if (res.nativeReady && (await nativePaste(tabId, text))) {
        if (await pasteLanded(tabId, msg.step.target, text)) return res;
        log(`${n}: the real Ctrl+V didn't reach the box; pasting at page level instead`);
      } else {
        const why = res.nativeReady ? "the clipboard could not be written" : "the box didn't take the focus";
        sendGroup(tabId, { type: "warn", text: `${n}: no real Ctrl+V (${why}). Used a page paste instead.` });
      }
    } else {
      sendGroup(tabId, { type: "warn", text: `${n}: no real Ctrl+V (Chrome's debugging bar is off). Used a page paste instead.` });
    }
    const res = await performStepOnce(tabId, ctl, { ...msg, lead: 0 });
    if (res && res.ok && !ctl.cancelled && !(await pasteLanded(tabId, msg.step.target, text))) {
      // Carrying on would click a Next that stays grey; let recovery deal with it.
      return { ok: false, error: `the pasted text didn't land in ${msg.step.target && msg.step.target.attrs && msg.step.target.attrs.placeholder ? `the "${msg.step.target.attrs.placeholder}" box` : "the box"}`, missing: true };
    }
    return res;
  }
  return performStepOnce(tabId, ctl, msg);
}

// down: Chrome shows its "connection interrupted" page in this tab.
const offline = (tabId) => ({ ok: false, error: `The connection was lost (${netErrors.get(tabId)})`, down: true });

// How long the page may take over one step before it counts as not answering:
// its own wait for the element (see find in player.js), the recorded typing,
// and PERFORM_TIMEOUT on top. Shorter than that, a missing element would be
// taken for a stuck page.
function performTimeout(msg) {
  const st = msg.step;
  const find = msg.wait || (msg.patient ? 40000 : 10000);
  const typing = st.type === "input" && typeof msg.speed === "number" ? Math.min((st.dur || 0) / msg.speed, 30000) : 0;
  return find + typing + PERFORM_TIMEOUT;
}

// F5, Ctrl+R, Ctrl+Shift+R, Ctrl+F5 (Cmd on a Mac). Tapes from before 2.0.5
// hold these as key steps; a page ignores a replayed F5, so reload instead.
function isReloadKey(step) {
  const m = step.mods || {};
  if (step.type !== "key" || m.alt) return false;
  return step.key === "F5" || ((step.key === "r" || step.key === "R") && !!(m.ctrl || m.meta));
}

async function performStepOnce(tabId, ctl, msg) {
  if (msg.step.type === "nav" || isReloadKey(msg.step)) {
    const ok = await navigate(tabId, ctl, msg.step.type === "nav" ? msg.step : { kind: "reload" });
    if (netErrors.has(tabId)) return offline(tabId);
    return ok ? { ok: true } : { ok: false, error: "The page did not finish loading" };
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    if (ctl.cancelled) return { ok: true };
    if (ctl.kick) return kickedResult(ctl);
    if (navPending.get(tabId)) {
      const ok = await waitReady(tabId, READY_TIMEOUT, ctl);
      if (!ok && !ctl.cancelled) return { ok: false, error: "The page did not finish loading" };
      if (ctl.cancelled) return { ok: true };
    }
    if (netErrors.has(tabId)) return offline(tabId);
    ctl.acted = -1;
    const kicked = kickWait(ctl);
    try {
      // The AI check can give up on a step while the page still waits for it.
      const res = await Promise.race([sendWithTimeout(tabId, msg, performTimeout(msg)), kicked]);
      if (res) return res;
    } catch (e) {
      if (ctl.acted === msg.i) return { ok: true, x: null };
      if (String(e && e.message) === "timeout") return { ok: false, error: "The page stopped responding" };
    } finally {
      kicked.off();
    }
    if (ctl.kick) return kickedResult(ctl);
    // No listener: the page is still loading or was replaced. Wait for it.
    if (ctl.acted === msg.i) return { ok: true, x: null };
    if (netErrors.has(tabId)) return offline(tabId);
    const ok = await waitReady(tabId, attempt === 0 ? 4000 : 12000, ctl);
    if (netErrors.has(tabId)) return offline(tabId);
    if (!ok && attempt > 0) {
      const alive = await ensureContent(tabId);
      if (!alive) return { ok: false, error: "TinyTab can't run on this page" };
    }
  }
  return { ok: false, error: "The page did not respond" };
}

// ---------- recovery ----------
// With "recover" on, playback doesn't stop when the connection drops or a page
// gets stuck. A tab on Chrome's error page is reloaded until a real page loads.
// Then TinyTab looks at the page and goes on from the step that fits it. When
// no step fits, or a page stays stuck, the run starts again from step 1.

const PLACE_TYPES = new Set(["click", "dbl", "rclick", "input", "copy", "paste", "hover"]);
const PLACE_BACK = 5; // earlier steps it may redo, like opening a menu again
const PLACE_WAIT_MS = 12000; // how long a reloaded page gets to draw the step's element
const PLACE_SETTLE_MS = 1500; // extra time for it once other steps' elements are there
const LATE_WAIT_MS = 60000; // on the right page, how much longer to wait for late content (an email)

const say = (lead, text) => {
  if (text) log(`  ${text}`);
  sendGroup(lead, { type: "status", text });
};

// Reloads a stuck page and waits for it, giving a slow connection a second
// READY_TIMEOUT. False when the page can't be brought back.
async function reloadStuck(lead, id, ctl) {
  say(lead, "The page seems stuck. Reloading it");
  await unfreeze(id);
  await navigate(id, ctl, { kind: "reload" }).catch(() => false);
  if (!ctl.cancelled && navPending.get(id)) {
    say(lead, "Waiting for the page to load");
    await waitReady(id, READY_TIMEOUT, ctl);
  }
  if (ctl.cancelled) return false;
  if (netErrors.has(id) && !(await reloadUntilUp(lead, id, ctl))) return false;
  const ok = await ensureContent(id);
  say(lead, "");
  return ok;
}

// A page caught in an endless script can't be left: Chrome waits for it
// before loading the next page. Stops the script that runs now, through the
// debugger connection that keeps playing tabs awake. Harmless when none runs.
async function unfreeze(id) {
  if (!awakeTabs.has(id)) return;
  await Promise.race([chrome.debugger.sendCommand({ tabId: id }, "Runtime.terminateExecution").catch(() => {}), new Promise((r) => setTimeout(r, 2000))]);
}

// Reloads a tab showing Chrome's error page until a real page loads. Waits as
// long as the computer is offline; gives up after RELOAD_GIVE_UP_MS online.
async function reloadUntilUp(lead, id, ctl) {
  let onlineSince = 0;
  let pause = 2000;
  while (!ctl.cancelled) {
    if (!navigator.onLine) {
      onlineSince = 0;
      say(lead, "No internet. Waiting to reload the page");
      await sleep(2000, ctl);
      continue;
    }
    onlineSince ||= Date.now();
    say(lead, "Connection lost. Reloading the page");
    await navigate(id, ctl, { kind: "reload" }).catch(() => false);
    if (ctl.cancelled) break;
    if (!netErrors.has(id) && (await ensureContent(id))) {
      say(lead, "");
      return true;
    }
    if (Date.now() - onlineSince > RELOAD_GIVE_UP_MS) break;
    await sleep(pause, ctl);
    pause = Math.min(pause * 2, 15000);
  }
  say(lead, "");
  return false;
}

// After trouble the page may not be where the tape was: the home page instead
// of the account menu, say. Finds the step that fits the page, in this order:
//  1. near: step i, then up to PLACE_BACK earlier steps (redoing a little, like
//     opening a menu again), then the later steps of this stretch in this tab;
//  2. far: this tab's steps further on, past other tabs' work, such as the log
//     out at the end of the task. Only a clear match counts there (TT.findSure).
// Within each, a step recorded on this very page wins. -1 when nothing fits.
async function findPlace(steps, i, id, ctl, skip = []) {
  const slot = steps[i].tab || 0;
  // A click on the page itself fits every page, so it can't show where we are.
  const fits = (k) => PLACE_TYPES.has(steps[k].type) && steps[k].target && !["html", "body"].includes(steps[k].target.tag) && !skip.includes(k);
  const near = [];
  for (let k = i; k >= 0 && i - k <= PLACE_BACK && (steps[k].tab || 0) === slot; k--) near.push(k);
  let k = i + 1;
  for (; k < steps.length && (steps[k].tab || 0) === slot; k++) near.push(k);
  const far = [];
  for (; k < steps.length && far.length < 80; k++) if ((steps[k].tab || 0) === slot) far.push(k);
  // Jumping far ahead skips real work (the rest of a sign-up), so a far step
  // must have been recorded on the page the tab shows now. Tapes from before
  // 2.0.2 don't know their pages; for those it stays as it was.
  const tabNow = await chrome.tabs.get(id).catch(() => null);
  const pageNow = tabNow ? pageOf(tabNow.url) : "";
  const farHere = (n) => !steps[n].page || !pageNow || steps[n].page === pageNow;
  const nearOk = near.filter(fits);
  const usable = [...nearOk, ...far.filter((n) => fits(n) && farHere(n))];
  if (!usable.length) return -1;
  const targets = usable.map((n) => steps[n].target);
  const sure = usable.map((_, n) => n >= nearOk.length);

  // A slow page draws in parts: the header first, the form later. Wait for the
  // step's own element; once other steps' elements are there, wait a little
  // longer for it, then choose from what is there.
  let found = null;
  let otherSince = 0;
  const end = Date.now() + PLACE_WAIT_MS;
  while (!ctl.cancelled) {
    const r = await sendWithTimeout(id, { type: "probe", targets, sure }, 5000).catch(() => null);
    const f = r && Array.isArray(r.found) ? r.found : [];
    if (usable[0] === i && f[0]) return i;
    if (f.some(Boolean)) {
      otherSince ||= Date.now();
      if (Date.now() - otherSince >= PLACE_SETTLE_MS || Date.now() > end) {
        found = f;
        break;
      }
    } else if (Date.now() > end) break;
    await sleep(700, ctl);
  }
  if (!found) return -1;

  if (usable[0] === i && found[0]) return i;
  const tab = await chrome.tabs.get(id).catch(() => null);
  const here = tab ? pageOf(tab.url) : "";
  const pick = (from, to, ok) => {
    for (let n = from; n < to; n++) if (found[n] && ok(steps[usable[n]])) return usable[n];
    return -1;
  };
  // Tapes from 2.0.2 on know each step's page: prefer a step from this page.
  for (const [from, to] of [[0, nearOk.length], [nearOk.length, usable.length]]) {
    const n = here ? pick(from, to, (st) => st.page === here) : -1;
    const m = n >= 0 ? n : pick(from, to, () => true);
    if (m >= 0) return m;
  }
  return -1;
}

// Log out / sign out / disconnect buttons: a run that stopped halfway may still
// be signed in, and then the start page (a sign-up or log-in form) never shows.
// The same words, in the same languages, as SIGN_OUT in content/sense.js.
const SIGN_OUT = new RegExp(
  "^(" +
    [
      "log ?out", "log ?off", "sign ?out", "sign ?off", "disconnect( wallet)?", "exit account",
      "déconnexion", "se déconnecter", "abmelden", "ausloggen", "cerrar sesión", "salir", "sair", "terminar sessão",
      "esci", "disconnetti", "uitloggen", "afmelden", "wyloguj( się)?", "выйти", "выход", "çıkış( yap)?",
      "退出(登录)?", "登出", "注销", "ログアウト", "サインアウト", "로그아웃", "đăng xuất", "keluar", "ออกจากระบบ", "تسجيل الخروج", "लॉग आउट",
    ].join("|") +
    ")$",
  "i"
);

// Before playing again: in each tab, if the tape signs out somewhere and that
// button (or menu item, even hidden in a closed menu) is on the page, press it.
// A menu that only appears on a click (a profile icon that opens it) is opened
// first with the tape's own click that opened it: the clicks just before.
// only: just this tab slot. True when it pressed a sign-out step.
async function signOutFirst(lead, ctl, t, group, steps, only = null) {
  let pressed = false;
  const once = (id, k) =>
    performStepOnce(id, ctl, { type: "perform", i: k, step: steps[k], lead: 0, speed: "max", patient: false, from: null, clip: null, settings: t.settings });
  const probe = async (id, ks) => {
    const r = await sendWithTimeout(id, { type: "probe", targets: ks.map((k) => steps[k].target), sure: ks.map(() => true) }, 5000).catch(() => null);
    const n = r && Array.isArray(r.found) ? r.found.findIndex(Boolean) : -1;
    return n < 0 ? -1 : ks[n];
  };
  for (let s = 0; s < group.length && !ctl.cancelled; s++) {
    if (only != null && s !== only) continue;
    const ks = [];
    steps.forEach((st, k) => {
      if ((st.tab || 0) === s && PLACE_TYPES.has(st.type) && st.target && SIGN_OUT.test((st.target.text || "").trim())) ks.push(k);
    });
    if (!ks.length) continue;
    const id = group[s];
    let k = await probe(id, ks);
    if (k < 0) {
      // The clicks that opened the menu: up to 4 steps before each sign-out
      // step, in this tab, stopping at another tab's step.
      const openers = [];
      for (const out of ks) {
        for (let j = out - 1; j >= 0 && out - j <= 4 && (steps[j].tab || 0) === s; j--) {
          if ((steps[j].type === "click" || steps[j].type === "dbl") && steps[j].target && !openers.includes(j)) openers.push(j);
        }
      }
      const opener = openers.length ? await probe(id, openers) : -1;
      if (opener < 0) continue;
      say(lead, "Opening the menu to log out");
      await once(id, opener);
      await sleep(1200, ctl);
      k = await probe(id, ks);
      if (k < 0) continue;
    }
    say(lead, "Logging out before starting again");
    sendGroup(lead, { type: "warn", text: `Still signed in: pressing "${steps[k].target.text}" (step ${k + 1}) before starting again.` });
    await once(id, k);
    pressed = true;
    await sleep(1000, ctl);
    if (navPending.get(id)) await waitReady(id, READY_TIMEOUT, ctl);
  }
  say(lead, "");
  return pressed;
}

// ---------- AI check ----------
// With an AI model set up (options page) and "Recover on its own" on, a step
// that has waited aiConfig.stuckAfter seconds gets looked at every
// aiConfig.every seconds. TinyTab sends the model the page in words (see
// ai.js) and acts on the answer:
//   a signed-in home screen: log out, then play again from step 1;
//   the start page or a sign-in form in the middle of a run: play again from step 1;
//   stuck (frozen, blank, an error, endless loading) or another page (a
//   promotion, an anniversary page): reload it, go on from the step that fits;
//   the same step stuck again after that reload: play again from step 1.
// A step whose element is on the page and usable is left alone: the player is
// about to do it. A page that doesn't answer TinyTab at all counts as stuck.

const AI_SEES = {
  expected: "the page the step needs",
  start: "the start page",
  home: "a signed-in home screen",
  login: "a sign-in page",
  error: "an error page",
  blank: "a blank page",
  loading: "a page stuck loading",
  other: "a different page",
};

const aiSummary = (a) =>
  `page ${a.page}${a.stuck ? ", stuck" : ""}${a.signedIn ? ", signed in" : ""}${a.atStart ? ", at the start" : ""}${a.reason ? `: ${a.reason}` : ""}`;

// A step for the AI, in words. Never what the step types.
function stepText(st) {
  if (!st) return "";
  const t = st.target || {};
  const a = t.attrs || {};
  const name = String(t.text || a["aria-label"] || a.placeholder || a.name || a.title || "").slice(0, 60);
  const kind = { a: "link", button: "button", input: "field", textarea: "text box", select: "menu", img: "image" }[t.tag] || t.tag || "element";
  const what = name ? `the "${name}" ${kind}` : `a ${kind}`;
  switch (st.type) {
    case "click": return `click ${what}`;
    case "dbl": return `double-click ${what}`;
    case "rclick": return `right-click ${what}`;
    case "input": return `type into ${what}`;
    case "key": return `press ${st.key || "a key"}`;
    case "copy": return `copy the text of ${what}`;
    case "paste": return `paste into ${what}`;
    case "hover": return `point at ${what}`;
    case "scroll": return "scroll";
    case "nav": return st.kind === "reload" ? "reload the page" : `open ${pageOf(st.url) || "a page"}`;
  }
  return st.type;
}

// What the tab shows, in words (content/sense.js). null when the page doesn't answer.
// watch: ms to look for the page changing (a page loading or updating).
async function tabSnapshot(id, watch = 1000) {
  const r = await sendWithTimeout(id, { type: "snapshot", watch }, 5000).catch(() => null);
  return r && r.ok && r.snap ? r.snap : null;
}

// Whether a recorded element is on the page now, visible and usable.
async function probeOne(id, target) {
  const r = await sendWithTimeout(id, { type: "probe", targets: [target], sure: [false] }, 5000).catch(() => null);
  return !!(r && Array.isArray(r.found) && r.found[0]);
}

// What the AI gets to know about the task, for step i.
function aiJob(t, i, snap, question) {
  const steps = t.tape.steps;
  const st = steps[i];
  const slot = st.tab || 0;
  const first = steps.findIndex((x) => (x.tab || 0) === slot && x.type !== "path");
  const start = (tapeTabs(t.tape)[slot] || {}).startUrl || "";
  return {
    question,
    recordingStartedOn: pageOf(start) || start,
    firstStep: first >= 0 ? stepText(steps[first]) : "",
    previousStep: i > 0 ? stepText(steps[i - 1]) : "",
    waitingFor: { step: i + 1, of: steps.length, action: stepText(st), recordedOn: st.page || "" },
    tabIsOnThatPage: !!(snap && st.page && snap.url === st.page),
    goal: aiConfig.goalLink ? { name: aiConfig.goalLink, page: `the ${aiConfig.goalLink} page`, button: aiConfig.goalButton } : undefined,
    allowedPages: pageRuleOn(t, st) ? aiConfig.allowedPages : undefined,
  };
}

// The page rule applies in the tab of the goal page (not a mail tab, say).
function pageRuleOn(t, st) {
  if (!aiConfig.pageRule || !aiConfig.allowedPages || !st) return false;
  const gs = goalStep(t.tape.steps);
  return gs >= 0 && (t.tape.steps[gs].tab || 0) === (st.tab || 0);
}

// Pages the tape visits around step i in its tab, and the tab's start page:
// on one of these the tab is where it should be, with no AI needed.
function pagesNear(t, i) {
  const steps = t.tape.steps;
  const slot = steps[i].tab || 0;
  const out = new Set();
  const start = pageOf((tapeTabs(t.tape)[slot] || {}).startUrl || "");
  if (start) out.add(start);
  for (let k = Math.max(0, i - 3); k <= Math.min(steps.length - 1, i + 3); k++) {
    if ((steps[k].tab || 0) === slot && steps[k].page) out.add(steps[k].page);
  }
  return out;
}

// ---------- task rules ----------
// Checked by TinyTab itself, with or without an AI (settings on the options page).
//   The code: after the tape's Send, the button turns into a countdown ("90s")
//   when the code went. "Send" still there, or the countdown below codeMin
//   before the code is typed: the code won't come, start again (codeWatch).
//   The goal page: the task begins on the goalLink page ("8th Anniversary")
//   with its goalButton ("Register"). Off that page before the task got going:
//   click the goalLink link, else load the start page (goToGoal).

// Same words as SEND_CODE in content/sense.js.
const SEND_CODE = /^(send|send code|get code|get the code|resend|resend code|send again|get verification code|send verification code|obtain code|获取验证码|发送|发送验证码|重新发送)$/i;
const isSendStep = (st) => st.type === "click" && !!st.target && SEND_CODE.test(String(st.target.text || "").trim());

// The tape's goalButton click ("Register"), or -1.
function goalStep(steps) {
  const want = aiConfig.goalButton.toLowerCase();
  if (!aiConfig.goalLink || !want) return -1;
  return steps.findIndex((st) => PLACE_TYPES.has(st.type) && st.target && String(st.target.text || "").trim().toLowerCase() === want);
}

// Gets tab id to the goal page: clicks the goalLink link there, else loads
// url (the tape's start page) and looks for the link again.
async function goToGoal(lead, ctl, id, url) {
  const name = aiConfig.goalLink;
  say(lead, `Going to the ${name} page`);
  for (let round = 0; round < 2 && !ctl.cancelled; round++) {
    const r = await sendWithTimeout(id, { type: "clickText", text: name }, 8000).catch(() => null);
    if (r && r.done) {
      log(`  Clicked "${r.label}" to reach the ${name} page`);
      await sleep(800, ctl);
      if (navPending.get(id)) await waitReady(id, READY_TIMEOUT, ctl);
      break;
    }
    if (round || !url || !/^https?:/.test(url)) {
      log(`  Found no "${name}" link on the page`);
      break;
    }
    log(`  No "${name}" link on the page: loading ${pageOf(url) || url}`);
    await unfreeze(id);
    await navigate(id, ctl, { kind: "goto", url }).catch(() => false);
    await ensureContent(id);
    // Already there (the start page is the goal page): nothing to click.
    const gs = goalStep(ctl.steps || []);
    if (gs >= 0 && (await probeOne(id, ctl.steps[gs].target))) break;
  }
  await ensureContent(id);
  say(lead, "");
}

// The last click before step i, or -1: the step just before, or, in the
// same tab, the click a scroll or hover followed. Only a plain click on a
// button or link (not a copy button, not the page itself).
function lastClickBefore(steps, i) {
  let k = i - 1;
  const slot = steps[i].tab || 0;
  for (let j = i - 1; j >= 0 && i - j <= 3 && (steps[j].tab || 0) === slot; j--) {
    if (["scroll", "hover", "path"].includes(steps[j].type)) continue;
    k = j;
    break;
  }
  const prev = steps[k];
  if (!prev || prev.type !== "click" || prev.copies || !prev.target || ["html", "body"].includes(prev.target.tag)) return -1;
  return k;
}

// A click that didn't take: the next step has waited AGAIN_AFTER_MS, the tab
// still shows the page of the last click and its button is there and
// usable. Click it again and go on from the waiting step (no reload, no
// restart); up to AGAIN_MAX times a step, then the usual checks take over.
// Send is left to the code rule. Checked every 1.5 s, no AI needed.
const AGAIN_AFTER_MS = 4000;
const AGAIN_MAX = 3;
async function clickWatch(lead, ctl, t) {
  const steps = t.tape.steps;
  const over = () => ctl.cancelled || ctl.over;
  while (!over()) {
    await sleep(1500, ctl);
    const cur = ctl.cur;
    if (over() || !cur || ctl.kick || ctl.nextKick || t.settings.recover === false) continue;
    if (Date.now() - cur.since < AGAIN_AFTER_MS || (ctl.aiAgain.get(cur.i) || 0) >= AGAIN_MAX) continue;
    if (ctl.codeSent && ctl.codeTicking) continue; // the code is on its way
    const i = cur.i;
    const k = lastClickBefore(steps, i);
    if (k < 0 || isSendStep(steps[k]) || ctl.refSkip.has(k) || !steps[i].target) continue;
    const prevId = ctl.group[steps[k].tab || 0];
    if (prevId == null || navPending.get(prevId) || netErrors.has(prevId)) continue;
    // Still on the page of that click (tapes from 2.0.2 on know it).
    const tab = await chrome.tabs.get(prevId).catch(() => null);
    if (!tab || (steps[k].page && pageOf(tab.url) !== steps[k].page)) continue;
    // The waiting step's element isn't there, the last button is.
    if (await probeOne(cur.id, steps[i].target)) continue;
    if (!(await probeOne(prevId, steps[k].target))) continue;
    if (over() || ctl.cur !== cur) continue;
    const name = steps[k].target.text ? `"${steps[k].target.text.slice(0, 40)}"` : "the last button";
    kick(ctl, { action: "again", k, id: prevId, why: `${name} (step ${k + 1}) didn't take: the page is the same and the button is still there` });
  }
}

// ---------- the referral code ----------
// With a referral code set (options page; built in: VZWLQHE), before each
// step TinyTab has the page put it in the sign-up form's referral field,
// opening a closed "Referral code" section for it. A field that already
// holds a code is left alone. The tape's own steps for that (opening the
// section, typing the code) are skipped: they got stuck on closed sections.

// Same words as REFERRAL in content/sense.js.
const REFERRAL = /(refer|invit|promo(tion)?[\s_-]*code|推荐|邀请|招待|紹介|초대|추천|parrain|empfehl|referido|indica)/i;
const referralTarget = (tg) => !!tg && REFERRAL.test([tg.text, ...["placeholder", "aria-label", "name", "id"].map((k) => (tg.attrs || {})[k])].join(" "));
// A click on an icon or an empty box (the arrow that opens the section).
const blankClick = (st) => st.type === "click" && st.target && !String(st.target.text || "").trim() && !["input", "textarea", "select"].includes(st.target.tag);

// The tape's steps the referral fill does instead: steps on the referral
// field or its "Referral code" line, and blank clicks just before typing it.
// Also the field steps right after opening the "Referral code" line: that
// field's own name may be only "Enter code".
function referralSteps(steps) {
  const out = new Set();
  const onField = (st) => ["click", "input", "paste", "key"].includes(st.type) && st.target && ["input", "textarea"].includes(st.target.tag);
  steps.forEach((st, k) => {
    if (!["click", "input", "paste", "key"].includes(st.type) || !referralTarget(st.target)) return;
    out.add(k);
    if (st.type === "click" && !onField(st)) {
      // The opener: the next steps on one field are the code going in.
      let field = null;
      for (let j = k + 1; j < steps.length && j - k <= 4 && (steps[j].tab || 0) === (st.tab || 0) && onField(steps[j]); j++) {
        const key = targetKey(steps[j].target);
        if (field && key !== field) break;
        field = key;
        out.add(j);
      }
    }
    if (st.type !== "input" && st.type !== "paste") return;
    for (let j = k - 1; j >= 0 && k - j <= 2 && (steps[j].tab || 0) === (st.tab || 0); j--) if (blankClick(steps[j])) out.add(j);
  });
  return out;
}

// Before a step in tab id: fill the referral field on this page. Asks the
// page again on a new address, or while a sign-up form shows without the
// field (it may draw later), a few times.
async function ensureReferral(ctl, id) {
  const code = aiConfig.referralCode;
  if (!code) return;
  const tab = await chrome.tabs.get(id).catch(() => null);
  if (!tab) return;
  const url = pageOf(tab.url) || tab.url;
  const was = ctl.refs.get(id);
  const same = was && was.url === url;
  if (same && (was.state !== "none" || was.tries >= 6)) return;
  const r = await sendWithTimeout(id, { type: "referral", code }, 3000).catch(() => null);
  if (!r || !r.ok) return;
  ctl.refs.set(id, { url, state: r.state, form: !!r.form, tries: same ? was.tries + 1 : 1 });
  if (r.state === "done") log(`  Referral code ${code} filled in${r.opened ? ` (opened "${r.opened}")` : ""}`);
  else if (r.state === "filled" && !same) log(`  Referral field already holds "${r.value}": left as it is`);
}

// Runs beside one playback until it ends: the code rule, every 2 s.
async function codeWatch(lead, ctl, t) {
  await aiLoaded;
  const over = () => ctl.cancelled || ctl.over;
  while (!over()) {
    await sleep(2000, ctl);
    const w = ctl.codeSent;
    if (over() || !w || ctl.kick || ctl.nextKick || !aiConfig.codeRule || t.settings.recover === false) continue;
    const r = await sendWithTimeout(w.id, { type: "codeTimer" }, 4000).catch(() => null);
    if (!r || !r.ok || ctl.codeSent !== w || over()) continue;
    let why = "";
    if (r.seconds != null) {
      ctl.codeTicking = r.seconds >= aiConfig.codeMin;
      // Every reading in the log, 10 s apart: shows what TinyTab took for the timer.
      if (!w.loggedAt || Date.now() - w.loggedAt >= 10000) {
        log(`  Code timer: ${r.seconds} s ("${r.text}")`);
        w.loggedAt = Date.now();
      }
      w.seen = true;
      if (!ctl.codeTicking) why = `the code timer is at ${r.seconds} s ("${r.text}"), below ${aiConfig.codeMin} s, and the code hasn't come`;
    } else if (r.send && Date.now() - w.at >= 3000) {
      ctl.codeTicking = false;
      why = w.seen ? `the code timer ran out ("${r.send}" is back)` : `"${r.send}" is still on the page: the code wasn't sent`;
    }
    if (!why) continue;
    ctl.codeSent = null;
    const verdict = { action: "restart", why };
    if (ctl.cur) kick(ctl, verdict);
    else ctl.nextKick = verdict;
  }
}

// A result for a step the AI check gave up on.
function kickedResult(ctl) {
  return { ok: false, kicked: true, error: (ctl.kick && ctl.kick.why) || "stopped by the AI check" };
}

// Resolves when the AI check gives up on the current step. off() forgets it.
function kickWait(ctl) {
  let fn = null;
  const p = new Promise((resolve) => {
    fn = () => resolve(kickedResult(ctl));
    if (ctl.kick) fn();
    else ctl.kickers.add(fn);
  });
  p.off = () => ctl.kickers.delete(fn);
  return p;
}

function kick(ctl, verdict) {
  ctl.kick = verdict;
  for (const fn of [...ctl.kickers]) fn();
  // Waits for a page load or a copy end now, so playback sees the verdict.
  for (const fn of [...ctl.wakers]) fn(false);
}

// The verdict on step i, waiting in tab id for ms: null to leave it be, or
// { action: "logout" | "restart" | "refresh", why }.
async function aiJudge(lead, ctl, t, i, id, ms, stuck = true) {
  const steps = t.tape.steps;
  const st = steps[i];
  const secs = Math.round(ms / 1000);
  const rule = pageRuleOn(t, st);
  const refresh = (why) => (ctl.aiReloads.get(i) ? { action: "restart", why: `${why}, again after a reload` } : { action: "refresh", why });
  // Chrome's error page: the usual recovery reloads it once the connection is back.
  if (netErrors.has(id)) return null;
  // A new page still loading gets READY_TIMEOUT, as usual. Until it shows, the
  // old page would answer for it.
  if (navPending.get(id) && ms < READY_TIMEOUT) return null;
  // The code is on its way (the countdown runs): the code rule watches this wait.
  if (ctl.codeSent && ctl.codeTicking) return null;
  // The element is there and usable: the player is about to do the step.
  if (stuck && st.target && (await probeOne(id, st.target))) {
    if (!rule) return null;
    stuck = false;
  }
  const snap = await tabSnapshot(id, stuck ? 1000 : 0);
  if (ctl.cancelled) return null;
  // The page rule: on a page the tape doesn't visit here, ask the AI.
  const off = rule && !!snap && !pagesNear(t, i).has(snap.url);
  if (!stuck && !off) return null;
  const shot = await aiShot(id, awakeTabs.has(id));
  if (!snap && !shot) {
    // No answer from the page: frozen, or its load never ended.
    log(`  AI check, step ${i + 1}: the page hasn't answered for ${secs} s`);
    return refresh(`the page hasn't answered for ${secs} s`);
  }
  if (stuck) say(lead, "Asking the AI what the page shows");
  const question = stuck ? `TinyTab has waited ${secs} s to do step ${i + 1}. Which page is this, and is it stuck?` : `TinyTab is doing step ${i + 1}. Which page is this?`;
  const a = await aiAsk(snap, aiJob(t, i, snap, question), shot).finally(() => stuck && say(lead, ""));
  log(`  AI on step ${i + 1}${stuck ? ` after ${secs} s` : ` (${snap.url})`}: ${aiSummary(a)}`);
  if (off && !a.allowed && a.page !== "loading" && a.page !== "blank") {
    // Still there now? The run may have gone on while the AI thought.
    const tab = await chrome.tabs.get(id).catch(() => null);
    if (tab && pageOf(tab.url) === snap.url) return { action: "logout", why: `the tab is on ${snap.url}, none of ${aiConfig.allowedPages}${a.reason ? ` (${a.reason})` : ""}`, pageRule: true };
  }
  if (!stuck) return null;
  if (a.page === "expected" && !a.stuck) return null;
  const why = `the AI sees ${AI_SEES[a.page]}${a.stuck && a.page === "expected" ? ", stuck" : ""}${a.reason ? ` (${a.reason})` : ""}`;
  if (a.page === "home" && a.signedIn) return { action: "logout", why };
  // Before the task got going (up to a few steps past Register): off the
  // goal page, go there; on it but signed in, log out. Once per step.
  const gs = goalStep(steps);
  if (gs >= 0 && (steps[gs].tab || 0) === (st.tab || 0) && i <= gs + PLACE_BACK && !ctl.aiGoal.get(i)) {
    const name = aiConfig.goalLink;
    if (!a.onGoal) return { action: "goal", why: `${why}, not the ${name} page` };
    if (a.signedIn) return { action: "logout", why: `${why}, signed in on the ${name} page` };
  }
  if ((a.page === "start" || a.page === "login") && !a.stuck) {
    // Back where the tab began, in the middle of the run: start over. Still
    // on this tab's first step: that's where it should be.
    const first = steps.findIndex((x) => (x.tab || 0) === (st.tab || 0) && x.type !== "path");
    return i > first ? { action: "restart", why } : null;
  }
  return refresh(why);
}

// Runs beside one playback until it ends: looks at the step that waits too long.
async function aiWatch(lead, ctl, t) {
  await aiLoaded;
  const over = () => ctl.cancelled || ctl.over;
  while (!over()) {
    await sleep(aiConfig.every * 1000, ctl);
    const cur = ctl.cur;
    if (over() || !cur || ctl.kick || ctl.nextKick || !aiUsable() || t.settings.recover === false) continue;
    const ms = Date.now() - cur.since;
    const stuck = ms >= aiConfig.stuckAfter * 1000;
    if (!stuck && !pageRuleOn(t, t.tape.steps[cur.i])) continue;
    let verdict = null;
    try {
      verdict = await aiJudge(lead, ctl, t, cur.i, cur.id, ms, stuck);
    } catch (e) {
      const text = `AI check failed: ${(e && e.message) || e}`;
      if (ctl.aiWarned) log(`  ${text}`);
      else sendGroup(lead, { type: "warn", text }); // once per Play; the log gets the rest
      ctl.aiWarned = true;
    }
    if (!verdict || over()) continue;
    // A verdict on a stuck step: only while that step still waits.
    if (ctl.cur === cur) kick(ctl, verdict);
    // The page rule is about the tab, not the step: act on it at once.
    else if (verdict.pageRule) {
      if (ctl.cur) kick(ctl, verdict);
      else ctl.nextKick = verdict;
    }
  }
}

// At the start of a run, when the tab's first step is on the page: whether
// the AI sees the tab still signed in from an earlier run all the same.
async function aiSignedInAtStart(ctl, t, s, k, id) {
  if (!aiUsable()) return false;
  try {
    const snap = await tabSnapshot(id, 0); // at once: the run is already going
    if (!snap || ctl.cancelled) return false;
    const question = "The run is about to start. Is this tab at the start of the recording, or still signed in from an earlier run?";
    const a = await aiAsk(snap, aiJob(t, k, snap, question), await aiShot(id, awakeTabs.has(id)));
    log(`  AI at the start of tab ${s + 1}: ${aiSummary(a)}`);
    return a.signedIn && !a.atStart && a.page !== "start" && a.page !== "expected";
  } catch (e) {
    log(`  AI check failed: ${(e && e.message) || e}`);
    return false;
  }
}

// The start check runs beside the run, so Play starts at once. When the AI
// sees the tab still signed in, the run stops at the step it is on, logs out
// in that tab and starts again (onKick in startPlayback).
async function aiStartCheck(ctl, t, s, k, id) {
  const run = t.play.run;
  if (!(await aiSignedInAtStart(ctl, t, s, k, id))) return;
  if (ctl.cancelled || ctl.over || t.play.run !== run) return;
  const verdict = { action: "logout", why: `the AI sees tab ${s + 1} still signed in, not at the start of the recording`, id, slot: s };
  if (ctl.cur) kick(ctl, verdict);
  else ctl.nextKick = verdict; // taken up before the next step
}

// ---------- the start of each run ----------
// Every run should begin where the recording began. For each tab, if the
// first thing the tape does there isn't on its start page (still signed in,
// so the sign-in form never shows; a wallet still connected), reset the site:
//   1. the tape's own log out step, then any log out / sign out / disconnect
//      control TinyTab can find on the page (opening account menus for it);
//   2. if that isn't enough, clear the site's cookies and storage.
// A tab that already looks right is left alone, so tasks that are meant to
// run signed in keep their session.
const START_WAIT_MS = 15000;

async function ensureStartState(lead, ctl, t, group, slots, steps) {
  const fits = (k) => PLACE_TYPES.has(steps[k].type) && steps[k].target && !["html", "body"].includes(steps[k].target.tag);
  const here = async (id, k, ms) => {
    for (const end = Date.now() + ms; !ctl.cancelled; ) {
      const r = await sendWithTimeout(id, { type: "probe", targets: [steps[k].target], sure: [false] }, 5000).catch(() => null);
      if (r && Array.isArray(r.found) && r.found[0]) return true;
      if (Date.now() > end) return false;
      await sleep(800, ctl);
    }
    return false;
  };
  const home = async (s) => {
    const url = slots[s].startUrl;
    const web = url && !/^(chrome|about|edge|chrome-extension):/.test(url);
    await navigate(group[s], ctl, web ? { kind: "goto", url } : { kind: "reload" }).catch(() => false);
  };
  for (let s = 0; s < slots.length && !ctl.cancelled; s++) {
    // The tab's first step, unless a page load comes before it.
    let k = -1;
    for (let j = 0; j < steps.length; j++) {
      if ((steps[j].tab || 0) !== s) continue;
      if (steps[j].type === "nav") break;
      if (fits(j)) {
        k = j;
        break;
      }
    }
    if (k < 0) continue;
    const id = group[s];
    // With a goal page set for this tab, don't wait long: going there is quick.
    const gs = goalStep(steps);
    const toGoal = gs >= 0 && (steps[gs].tab || 0) === s;
    const forced = ctl.resetSlots.delete(s);
    if (!forced && (await here(id, k, toGoal ? 3000 : START_WAIT_MS))) {
      // The first step's element can show on a signed-in home page too: the
      // AI looks, while the run goes on.
      if (aiUsable()) aiStartCheck(ctl, t, s, k, id).catch(() => {});
      continue;
    }
    const what = steps[k].target.text ? `"${steps[k].target.text.slice(0, 40)}"` : "its first button or field";
    sendGroup(lead, { type: "warn", text: forced ? `Tab ${s + 1}: still signed in after the last run. Resetting it.` : `Tab ${s + 1} doesn't look like the start of the recording (${what} isn't there). Resetting it.` });
    // A popup in the way?
    const r0 = await sendWithTimeout(id, { type: "unblock" }, 15000).catch(() => null);
    if (r0 && r0.done && r0.done.length) {
      log(`  Closed a popup: ${r0.done.join(", ")}`);
      if (!forced && (await here(id, k, 3000))) continue;
    }
    // The goal page (8th Anniversary): click its link, or load the start page.
    if (toGoal) {
      await goToGoal(lead, ctl, id, slots[s].startUrl);
      if (await here(id, k, 5000)) {
        log(`  Tab ${s + 1} is at the start (the ${aiConfig.goalLink} page)`);
        continue;
      }
    }
    // 1. Log out, the tape's way first, then any way the page offers.
    say(lead, "Logging out before starting");
    let out = await signOutFirst(lead, ctl, t, group, steps, s);
    if (!out) {
      const r = await sendWithTimeout(id, { type: "signout" }, 20000).catch(() => null);
      if (r && r.done) {
        out = true;
        log(`  Pressed "${r.label}"${r.opened ? ` (in the "${r.opened}" menu)` : ""}`);
        await sleep(2500, ctl);
        if (navPending.get(id)) await waitReady(id, READY_TIMEOUT, ctl);
      } else log("  Found no log out button on the page");
    }
    if (out) {
      await home(s);
      if (await here(id, k, START_WAIT_MS)) {
        log(`  Tab ${s + 1} is back at the start`);
        continue;
      }
    }
    // 2. Clear the site's cookies and storage: signs out of any site and
    // disconnects a dapp's wallet session. Only the sites this tab visits.
    if (!chrome.browsingData) continue;
    const origins = [...new Set([slots[s].startUrl, ...steps.filter((st) => (st.tab || 0) === s).map((st) => st.page || st.url)].map(originOf).filter((o) => /^https?:/.test(o)))];
    if (!origins.length) continue;
    say(lead, "Clearing the site's sign-in data");
    await sendWithTimeout(id, { type: "clearSession" }, 3000).catch(() => null);
    try {
      await chrome.browsingData.remove({ origins }, { cookies: true, localStorage: true, indexedDB: true, cacheStorage: true, serviceWorkers: true, fileSystems: true });
      log(`  Cleared cookies and storage for ${origins.map((o) => o.replace(/^https?:\/\//, "")).join(", ")}`);
    } catch (e) {
      log(`  Couldn't clear site data: ${(e && e.message) || e}`);
    }
    await home(s);
    log((await here(id, k, START_WAIT_MS)) ? `  Tab ${s + 1} is back at the start` : `  Tab ${s + 1} still doesn't look like the start; going on anyway`);
  }
  say(lead, "");
}

async function togglePlay(tabId) {
  const t = getTab(tabId);
  if (t.mode === "playing") return stopPlayback(tabId);
  if (t.mode === "recording") stopRecording(tabId);
  if (t.link != null) return;
  if (!t.tape.steps.length) {
    t.error = "Nothing to play yet. Press Rec and do your task once.";
    notify(tabId);
    return;
  }
  t.play = { index: 0, run: 1 };
  startPlayback(tabId, false);
}

function stopPlayback(tabId) {
  tabId = leaderOf(tabId);
  cancelReplay(tabId);
  if (players.has(tabId)) log("Stopped (Stop pressed, tab closed or TinyTab turned off)");
  const members = groupOf(tabId).filter((id) => id !== tabId);
  const ctl = players.get(tabId);
  if (ctl) {
    ctl.cancelled = true;
    for (const fn of [...ctl.wakers]) fn(false);
    players.delete(tabId);
  }
  letSleep(tabId);
  for (const id of members) {
    letSleep(id);
    releaseMember(id);
  }
  const t = tabs.get(tabId);
  if (t) delete t.group;
  if (t && t.mode === "playing") {
    t.mode = "idle";
    t.play = { index: 0, run: 1 };
    persist(tabId, true);
    notify(tabId);
  }
}

// Picks a tab for each slot of the tape: this tab first, then TinyTab tabs in
// the same window on the matching site, then any free one, else a new tab.
async function assignTabs(tabId, tape) {
  const slots = tapeTabs(tape);
  const group = new Array(slots.length).fill(null);
  const me = await chrome.tabs.get(tabId);
  const pool = await freeTabsNear(tabId);
  const mine = slots.findIndex((sl) => originOf(sl.startUrl) && originOf(sl.startUrl) === originOf(me.url));
  group[mine >= 0 ? mine : 0] = tabId;
  for (let i = 0; i < slots.length; i++) {
    if (group[i] != null) continue;
    const k = pool.findIndex((x) => originOf(x.url) === originOf(slots[i].startUrl));
    if (k >= 0) group[i] = pool.splice(k, 1)[0].id;
  }
  for (let i = 0; i < slots.length; i++) {
    if (group[i] != null) continue;
    if (pool.length) {
      group[i] = pool.shift().id;
    } else {
      const created = await chrome.tabs.create({ windowId: me.windowId, url: slots[i].startUrl || "about:blank", active: false });
      getTab(created.id).on = true;
      group[i] = created.id;
      navPending.set(created.id, true);
    }
  }
  return group;
}

// again: { group } when this Play is the "Play" half of a Stop-and-Play-again.
async function startPlayback(tabId, resumed, again = null) {
  const old = players.get(tabId);
  if (old) old.cancelled = true;
  cancelReplay(tabId);
  // clip is TinyTab's own clipboard: what the last copy took, ready for the next paste.
  const ctl = {
    cancelled: false, acted: -1, actAt: 0, wakers: new Set(), last: null, hidden: false,
    clip: null, clipSeq: 0, clipWaiters: new Set(), clipWrite: null, group: [tabId],
    again: !!again, // load the start pages afresh before step 1
    resetSlots: new Set((again && again.reset) || []), // tab slots to reset before step 1, signed in or not
    tries: new Map(), // step index -> recoveries at that step in this run
    // The AI check (see aiWatch): the step being done, the check's verdict on it.
    cur: null, // { i, id, since }
    kick: null, // { action, why }
    kickers: new Set(),
    nextKick: null, // a verdict (start check, code rule) for the next step
    codeSent: null, // { s, id, at, seen }: the tape's Send was pressed, the code not typed yet
    codeTicking: false, // the countdown runs at codeMin or more
    aiGoal: new Map(), // step index -> went to the goal page for it
    aiAgain: new Map(), // step index -> clicks of the step before it, again (clickWatch)
    refs: new Map(), // tabId -> { url, state, form, tries }: the referral fill on that page
    refSkip: new Set(), // the tape's referral steps (the fill does them)
    steps: null, // the tape's steps, for goToGoal
    aiReloads: new Map(), // step index -> reloads the AI check asked for in this run
    over: false, // playback ended
  };
  players.set(tabId, ctl);

  const t = getTab(tabId);
  ctl.steps = t.tape.steps;
  if (aiConfig.referralCode) ctl.refSkip = referralSteps(t.tape.steps);
  aiWatch(tabId, ctl, t).catch((e) => log(`AI check stopped: ${(e && e.message) || e}`));
  clickWatch(tabId, ctl, t).catch((e) => log(`Click check stopped: ${(e && e.message) || e}`));
  if (t.tape.steps.some(isSendStep)) codeWatch(tabId, ctl, t).catch((e) => log(`Code rule stopped: ${(e && e.message) || e}`));
  t.mode = "playing";
  t.error = "";
  let error = "";
  let group = [tabId];
  let replay = null; // { why, run } when the page got stuck: Stop, then Play again
  const s0 = t.settings;
  log(`${resumed ? "Resumed" : again ? "Playing again" : "Play"}: "${t.tape.name}" (${t.tape.steps.length} steps), from step ${t.play.index + 1}, run ${t.play.run}, speed ${s0.speed}${s0.loop ? ", loop" : ""}`);
  try {
    const slots = tapeTabs(t.tape);
    const alive = (g) => g && g.length === slots.length && g.every((id) => tabs.has(id));
    // Playing again uses the same tabs as before, each in its own slot.
    group = resumed && alive(t.group) ? t.group : again && alive(again.group) ? again.group : await assignTabs(tabId, t.tape);
    t.group = group;
    ctl.group = group;
    for (const id of group) {
      if (id === tabId) continue;
      const m = getTab(id);
      m.link = tabId;
      m.mode = "playing";
      m.error = "";
      persist(id, true);
    }
    persist(tabId, true);
    notifyGroup(tabId);
    for (const id of group) {
      chrome.tabs.update(id, { autoDiscardable: false }).catch(() => {});
      if (t.settings.awake) await keepAwake(id);
      await freshHook(id);
    }
    ensureOffscreen();

    if (resumed) await waitReady(tabId, 5000, ctl);
    const steps = t.tape.steps;
    const runs = () => (t.settings.loop ? Infinity : Math.max(1, t.settings.repeat | 0));
    const last = new Map(); // tabId -> cursor position
    const hidden = new Map(); // tabId -> last known hidden state

    // Steps that copy: a paste after one of these must use a fresh copy, never old text.
    const copyAt = steps.findIndex((st) => st.type === "copy" || st.copies);

    // Where to go on from after trouble: a step index, or -1 to Stop and Play again.
    let goTo = null;
    let trouble = "";
    const recoverOn = () => t.settings.recover !== false;
    // Whether the tab shows the page step k was recorded on (tapes from 2.0.2 on).
    const onRightPage = async (id, k) => {
      const tab = await chrome.tabs.get(id).catch(() => null);
      return !!(tab && steps[k].page && pageOf(tab.url) === steps[k].page);
    };
    // Whether this step's element is on its page now (visible, usable).
    const onPage = async (id, k) => {
      const r = await sendWithTimeout(id, { type: "probe", targets: [steps[k].target], sure: [false] }, 5000).catch(() => null);
      return !!(r && Array.isArray(r.found) && r.found[0]);
    };
    // A click that did nothing, like a Next whose request got lost on a slow
    // connection: press it once more, the way a person would, and wait for step
    // i's element. Before a reload, which would throw a half-done form away.
    let pressedAgain = -1; // the step pressAgain pressed for the current trouble
    // The previous step can be in the other tab: Bitrue's Next (step 8) sends
    // the email that the mail tab waits for (step 9). If that Next is still
    // there and usable, its request got lost; pressing it again sends the email.
    const pressAgain = async (i, id, what) => {
      // The last click before step i: the step just before, or, in the same
      // tab, the click a scroll or hover followed (Confirm, then scrolling the
      // new page: Confirm is the one whose request got lost).
      let k = i - 1;
      const slot = steps[i].tab || 0;
      for (let j = i - 1; j >= 0 && i - j <= 3 && (steps[j].tab || 0) === slot; j--) {
        if (["scroll", "hover", "path"].includes(steps[j].type)) continue;
        k = j;
        break;
      }
      const prev = steps[k];
      if (!prev || !steps[i].target) return false;
      if (prev.type !== "click" || prev.copies || !prev.target || ["html", "body"].includes(prev.target.tag)) return false;
      const otherTab = (prev.tab || 0) !== (steps[i].tab || 0);
      const prevId = otherTab ? group[prev.tab || 0] : id;
      if (prevId == null || !(await onPage(prevId, k))) return false; // gone, or disabled: pressing it can't help
      pressedAgain = k;
      sendGroup(tabId, { type: "warn", text: `${what}. Pressing ${prev.target.text ? `"${prev.target.text}"` : "the last button"} (step ${k + 1}${otherTab ? ", in the other tab" : ""}) again.` });
      const res = await performStep(prevId, ctl, { type: "perform", i: k, step: prev, lead: 0, speed: "max", patient: false, from: ctl.last, clip: ctl.clip, settings: t.settings });
      if (!res || !res.ok || ctl.cancelled) return false;
      say(tabId, otherTab ? "Waiting for it to arrive" : "Waiting for the page to answer");
      // An email takes longer than a page answering.
      for (const end = Date.now() + (otherTab ? 60000 : 20000); Date.now() < end && !ctl.cancelled; ) {
        if (await onPage(id, i)) {
          say(tabId, "");
          return true;
        }
        await sleep(1000, ctl);
      }
      say(tabId, "");
      return false;
    };
    // Decides goTo for step i. down: the tab shows Chrome's error page.
    // lost: the page is fine but the step's element isn't on it.
    const recover = async (i, id, what, down, lost) => {
      trouble = what;
      pressedAgain = -1;
      // A popup or cookie banner that wasn't there when recording, covering the page.
      if (!down && !ctl.cancelled) {
        const r = await sendWithTimeout(id, { type: "unblock" }, 15000).catch(() => null);
        if (r && Array.isArray(r.done) && r.done.length) {
          log(`  Closed a popup in the way: ${r.done.join(", ")}`);
          if (steps[i].target && (await onPage(id, i))) return (goTo = i);
        }
      }
      const n = (ctl.tries.get(i) || 0) + 1;
      ctl.tries.set(i, n);
      // Until playback gets past this step, waits are short: it failed once already.
      ctl.shakyUntil = Math.max(ctl.shakyUntil || -1, i);
      if (down) {
        sendGroup(tabId, { type: "warn", text: `${what}. Reloading when the connection is back.` });
        if (!(await reloadUntilUp(tabId, id, ctl))) return (goTo = -1);
        lost = true; // the reload may have landed somewhere else
      } else if (n <= 1 && !ctl.cancelled && (await pressAgain(i, id, what))) {
        return (goTo = i);
      } else if (n <= 1 && !ctl.cancelled) {
        // Slow internet leaves a page half loaded (a spinner, a missing button)
        // or not answering. Reload it, the way a person presses F5, then go on
        // with the step it was about to do (findPlace prefers that step).
        sendGroup(tabId, { type: "warn", text: `${what}. Reloading the page and carrying on.` });
        if (!(await reloadStuck(tabId, id, ctl))) return (goTo = -1);
        lost = true;
      }
      // The same step fails again after a reload: Stop and Play again.
      if (!lost || n > 1 || ctl.cancelled) return (goTo = -1);
      say(tabId, "Finding the place in the recording");
      // A button already pressed again without effect is not a place to go
      // back to: that loops (Register Now, the popup's X never shows). Later
      // steps that are on the page win instead, which skips the missing one.
      goTo = await findPlace(steps, i, id, ctl, pressedAgain >= 0 ? [pressedAgain] : []);
      say(tabId, "");
      // Only for a step waiting on another tab's work (the mail tab waiting for
      // Bitrue's email). A form in this tab that a reload emptied won't fill itself.
      const waitsOnOtherTab = i > 0 && (steps[i - 1].tab || 0) !== (steps[i].tab || 0);
      if (goTo < 0 && !ctl.cancelled && waitsOnOtherTab && steps[i].target && (await onRightPage(id, i))) {
        // The right page, just not ready: an email that hasn't arrived yet, a
        // list still loading on a slow connection. Wait longer before starting over.
        say(tabId, `Waiting longer for ${steps[i].target.text ? `"${steps[i].target.text.slice(0, 40)}"` : "the page"}`);
        for (const end = Date.now() + LATE_WAIT_MS; Date.now() < end && !ctl.cancelled; ) {
          if (await onPage(id, i)) {
            goTo = i;
            break;
          }
          await sleep(2000, ctl);
        }
        say(tabId, "");
      }
      return goTo;
    };
    // Acts on the AI check's verdict on step i (see aiJudge). Decides goTo, as recover does.
    const onKick = async (i, id) => {
      const k = ctl.kick;
      ctl.kick = null;
      send(id, { type: "abort" }).catch(() => {}); // the page stops waiting for the step
      const slot = k.slot != null ? k.slot : steps[i].tab || 0;
      if (k.id != null) id = k.id; // the start check names its tab
      trouble = `Step ${i + 1}: ${k.why}`;
      const next = { logout: "Logging out, then starting again.", restart: "Starting again from step 1.", refresh: "Reloading the page.", goal: `Going to the ${aiConfig.goalLink} page.`, again: "Clicking it again." }[k.action];
      sendGroup(tabId, { type: "warn", text: `${trouble}. ${next}` });
      if (k.action === "restart") return (goTo = -1);
      if (k.action === "again") {
        ctl.aiAgain.set(i, (ctl.aiAgain.get(i) || 0) + 1);
        const res = await performStep(id, ctl, { type: "perform", i: k.k, step: steps[k.k], lead: 0, speed: "max", patient: false, from: ctl.last, clip: ctl.clip, settings: t.settings });
        if (res && res.x != null) ctl.last = { x: res.x, y: res.y };
        return (goTo = i); // and on with the step that waited
      }
      if (k.action === "logout") {
        say(tabId, "Logging out");
        // A click of the step may have started a page change: let it land
        // first, or it cancels the log out.
        await sleep(300, ctl);
        if (navPending.get(id)) await waitReady(id, READY_TIMEOUT, ctl);
        await ensureContent(id);
        // The tape's own log out first, then any the page offers.
        if (!(await signOutFirst(tabId, ctl, t, group, steps, slot)) && !ctl.cancelled) {
          const r = await sendWithTimeout(id, { type: "signout" }, 20000).catch(() => null);
          if (r && r.done) {
            log(`  Pressed "${r.label}"${r.opened ? ` (in the "${r.opened}" menu)` : ""}`);
            await sleep(1000, ctl);
            if (navPending.get(id)) await waitReady(id, READY_TIMEOUT, ctl);
          } else {
            // Not here (the run went on to a page without one): the next run
            // starts with the full reset in this tab (log out on the start
            // page, else clear the site's sign-in data).
            log("  Found no log out button on the page: resetting the tab before the next run");
            ctl.resetSlots.add(slot);
          }
        }
        say(tabId, "");
        return (goTo = -1);
      }
      if (k.action === "goal") {
        ctl.aiGoal.set(i, true);
        await goToGoal(tabId, ctl, id, (slots[slot] || {}).startUrl);
        say(tabId, "Finding the place in the recording");
        goTo = await findPlace(steps, i, id, ctl);
        say(tabId, "");
        return goTo;
      }
      // refresh
      ctl.aiReloads.set(i, (ctl.aiReloads.get(i) || 0) + 1);
      ctl.shakyUntil = Math.max(ctl.shakyUntil || -1, i);
      if (!(await reloadStuck(tabId, id, ctl))) return (goTo = -1);
      say(tabId, "Finding the place in the recording");
      goTo = await findPlace(steps, i, id, ctl);
      say(tabId, "");
      return goTo;
    };

    while (!ctl.cancelled && t.play.run <= runs()) {
      if (t.play.index === 0) {
        ctl.clip = null; // each run copies afresh
        const resetting = recoverOn() && t.settings.resetSession !== false;
        // Played again after trouble: log out first if the last run didn't get to.
        // (With the start check on, that check does it, for any site.)
        if (ctl.again && !resetting) await signOutFirst(tabId, ctl, t, group, steps);
        for (let s = 0; s < slots.length && !ctl.cancelled; s++) {
          const id = group[s];
          const url = slots[s].startUrl;
          const web = url && !/^(chrome|about|edge|chrome-extension):/.test(url);
          if (navPending.get(id)) await waitReady(id, READY_TIMEOUT, ctl);
          if (ctl.again) {
            // Played again after a stuck page: load every start page afresh.
            await unfreeze(id);
            await navigate(id, ctl, web ? { kind: "goto", url } : { kind: "reload" }).catch(() => false);
            continue;
          }
          if (!t.settings.startPage || !web) continue;
          const tab = await chrome.tabs.get(id);
          if (!sameUrl(tab.url, url) || t.play.run > 1) {
            const ok = await navigate(id, ctl, { kind: "goto", url });
            // With recover on, the first step notices the trouble and deals with it.
            if (!ok && !ctl.cancelled && !recoverOn()) throw new Error("The start page did not finish loading");
          }
        }
        ctl.again = false;
        if (resetting && !ctl.cancelled) await ensureStartState(tabId, ctl, t, group, slots, steps);
      }
      for (let i = t.play.index; i < steps.length && !ctl.cancelled; i++) {
        const step = steps[i];
        const target = group[step.tab || 0] || tabId;
        if (ctl.refSkip.has(i) && aiConfig.referralCode) {
          // The referral fill does this step (see ensureReferral).
          await ensureReferral(ctl, target);
          log(`  Step ${i + 1} skipped: the referral code is filled in by TinyTab`);
          t.play.index = i + 1;
          sendGroup(tabId, { type: "done", index: i, run: t.play.run });
          continue;
        }
        if (step.type === "path" || strayAfterPaste(steps, i)) {
          // Mouse wiggles (path steps in older tapes) are not replayed. Tapes from
          // before 1.1.1 can hold a paste again as typing, which would type the
          // old code over the fresh paste. Skip both.
          t.play.index = i + 1;
          sendGroup(tabId, { type: "done", index: i, run: t.play.run });
          continue;
        }
        // The last step's click led to Chrome's error page: deal with it first.
        if (recoverOn() && netErrors.has(target)) {
          await recover(i, target, `Step ${i + 1}: the connection was lost (${netErrors.get(target)})`, true, false);
          break;
        }
        ctl.hidden = !!hidden.get(target);
        ctl.last = last.get(target) || null;
        const fastPace = t.settings.speed === "fast";
        const speed = fastPace ? FAST_SPEED : speedOf(t);
        let delay = speed === Infinity ? 0 : (i === 0 ? Math.min(step.dt, 600) : step.dt) / speed;
        if (fastPace) delay = Math.min(delay, FAST_WAIT_MS);
        // Switching tabs: the recorded pause was you reaching for the tab bar.
        // The virtual mouse is already there, so go on at once.
        if (i > 0 && (step.tab || 0) !== (steps[i - 1].tab || 0)) delay = Math.min(delay, TAB_SWITCH_MS);
        // A hidden tab can't animate the cursor, so the worker keeps the full wait.
        const lead = LEAD_TYPES.has(step.type) && speed !== Infinity && !ctl.hidden ? Math.min(delay, 520) : 0;

        sendGroup(tabId, { type: "progress", index: i, run: t.play.run, eta: delay });
        await sleep(delay - lead, ctl);
        if (ctl.cancelled) break;

        if (step.type === "paste" && ctl.clip == null && copyAt >= 0 && copyAt < i) {
          const what = `Step ${i + 1}: nothing was copied before this paste`;
          if (recoverOn()) {
            // The copy was lost (a reload or a jump); only a fresh run copies again.
            trouble = what;
            goTo = -1;
            break;
          }
          if (!t.settings.skipMissing) throw new Error(what);
          sendGroup(tabId, { type: "warn", text: what + " (skipped)" });
          t.play.index = i + 1;
          continue;
        }
        const seq0 = ctl.clipSeq;
        const msg = {
          type: "perform",
          i,
          // Fast pace also shortens recorded typing to at most half a second.
          step: fastPace && step.dur > FAST_TYPE_MS ? { ...step, dur: FAST_TYPE_MS } : step,
          lead,
          speed: speed === Infinity ? "max" : speed,
          patient: fastPace || speed === Infinity, // wait for elements instead of pauses
          // Right after trouble, don't wait long for an element before trying the next fix.
          wait: i <= (ctl.shakyUntil ?? -1) && (fastPace || speed === Infinity) ? 20000 : 0,
          from: ctl.last,
          clip: ctl.clip,
          settings: t.settings,
        };
        if (ctl.nextKick) {
          ctl.kick = ctl.nextKick;
          ctl.nextKick = null;
          await onKick(i, target);
          break;
        }
        await ensureReferral(ctl, target);
        ctl.kick = null; // a verdict on an earlier step
        ctl.cur = { i, id: target, since: Date.now() };
        let res = await performStep(target, ctl, msg);
        if (res && res.ok && typeof res.copied === "string" && res.copied) setClip(ctl, res.copied, target);
        if (res && res.ok && (step.copies || step.type === "copy") && !ctl.cancelled && !ctl.kick) {
          // Wait for the site's Copy button to copy. A page still loading its text
          // copies nothing yet, so try the click again a few times.
          let got = await waitClip(ctl, seq0, 1200);
          for (let r = 0; !got && r < 25 && !ctl.cancelled && !ctl.kick; r++) {
            await sleep(500, ctl);
            res = await performStep(target, ctl, { ...msg, lead: 0 });
            if (!res || !res.ok) break;
            if (typeof res.copied === "string" && res.copied) setClip(ctl, res.copied, target);
            got = await waitClip(ctl, seq0, 1000);
          }
          if (!got && !ctl.cancelled && res && res.ok) res = { ok: false, error: step.type === "copy" ? "there was no text to copy" : "the Copy button didn't copy anything" };
          // The next step may click a box that reads the clipboard at once.
          if (got && ctl.clipWrite) await ctl.clipWrite;
        }
        ctl.cur = null;
        if (ctl.cancelled) break;
        if (ctl.kick) {
          await onKick(i, target);
          break;
        }
        if (res && res.x != null) last.set(target, { x: res.x, y: res.y });
        if (res && "hidden" in res) hidden.set(target, !!res.hidden);
        if (res && res.hidden && speed !== Infinity) {
          // Typing and mouse paths finish instantly when hidden; keep their real length.
          const span = step.type === "input" ? Math.min(step.dur || 0, fastPace ? FAST_TYPE_MS : 30000) : 0;
          await sleep(Math.min(span, 30000) / speed, ctl);
        }
        if (!res || !res.ok) {
          const what = `Step ${i + 1}: ${(res && res.error) || "failed"}`;
          const down = !!(res && res.down) || netErrors.has(target);
          const lost = !!(res && res.missing) && !down;
          if (recoverOn() && !down && ctl.codeSent && ctl.codeTicking) {
            // The code is on its way (its timer runs at codeMin or more): only
            // the code rule may start over (codeWatch). A reload would throw
            // the form and its timer away. Try the step again; a mail tab gets
            // a reload first, so a new email shows.
            const sendSlot = steps[ctl.codeSent.s].tab || 0;
            log(`  ${what}. The code timer is still running: trying the step again`);
            if ((step.tab || 0) !== sendSlot) await reloadStuck(tabId, target, ctl);
            else await sleep(500, ctl);
            trouble = `${what} (waiting for the code)`;
            goTo = i;
            break;
          }
          // Recovery comes first: skipping a missing step blindly skipped a
          // whole e-mail form (steps 5-8), which can't work. Recovery already
          // skips a step that really is optional (a popup that didn't show).
          // "Skip steps it can't find" is for playback without recovery.
          if (recoverOn()) {
            await recover(i, target, what, down, lost);
            break;
          }
          if (!t.settings.skipMissing) throw new Error(what);
          sendGroup(tabId, { type: "warn", text: what + " (skipped)" });
        }
        if (i >= (ctl.shakyUntil ?? -1)) ctl.shakyUntil = -1; // past the trouble
        // The code rule: from Send pressed until the code is typed or pasted in its tab.
        if (isSendStep(step)) {
          ctl.codeSent = { s: i, id: target, at: Date.now(), seen: false };
          ctl.codeTicking = false;
        } else if (ctl.codeSent && i > ctl.codeSent.s && (step.type === "input" || step.type === "paste") && (step.tab || 0) === (steps[ctl.codeSent.s].tab || 0)) {
          ctl.codeSent = null;
          ctl.codeTicking = false;
        }
        t.play.index = i + 1;
        persist(tabId);
        sendGroup(tabId, { type: "done", index: i, run: t.play.run });
      }
      if (ctl.cancelled) break;
      if (goTo != null) {
        const k = goTo;
        goTo = null;
        if (k < 0) {
          // Stuck: leave the loop, Stop, and Play again (see finally).
          replay = { why: trouble, run: t.play.run, reset: [...ctl.resetSlots] };
          break;
        }
        if (ctl.codeSent && k <= ctl.codeSent.s) ctl.codeSent = null; // Send gets pressed again
        sendGroup(tabId, { type: "warn", text: `${trouble}. Going on from step ${k + 1}.` });
        t.play.index = k;
        persist(tabId);
        notifyGroup(tabId);
        continue;
      }
      t.restarts = 0; // a whole run went through
      ctl.tries.clear();
      ctl.aiReloads.clear();
      ctl.aiGoal.clear();
      ctl.aiAgain.clear();
      ctl.codeSent = null;
      t.play.index = 0;
      t.play.run += 1;
      persist(tabId);
      if (t.play.run <= runs()) await sleep(speedOf(t) === Infinity ? 50 : 400 / speedOf(t), ctl);
    }
  } catch (e) {
    error = String((e && e.message) || e);
  } finally {
    ctl.over = true; // ends aiWatch
    for (const fn of [...ctl.wakers]) fn(false);
    for (const id of group) send(id, { type: "clip", text: null }).catch(() => {});
    if (players.get(tabId) === ctl) {
      players.delete(tabId);
      // Playing again soon: the tabs stay connected. A frozen page can't be
      // connected to again, and the connection is what unfreezes it.
      const again = !!replay && !error && !ctl.cancelled;
      for (const id of group) {
        if (!again) letSleep(id);
        chrome.tabs.update(id, { autoDiscardable: true }).catch(() => {});
        if (id !== tabId && !ctl.cancelled) releaseMember(id);
      }
      delete t.group;
      if (!ctl.cancelled && tabs.has(tabId)) {
        t.mode = "idle";
        t.play = { index: 0, run: 1 };
        t.error = replay && !error ? playAgainLater(tabId, group, replay) : error;
        log(t.error ? `Stopped: ${t.error}` : "Finished");
        persist(tabId, true);
        notify(tabId);
      }
    }
  }
}

// ---------- stop and play again ----------
// A stuck page is handled the way a person would: press Stop, wait a moment,
// press Play. The same tabs load their start pages and the run begins again
// at step 1 (the run count carries on). No limit; the wait grows when it
// keeps happening, and resets once a whole run goes through.

function cancelReplay(tabId, sleepTabs = true) {
  const w = replays.get(tabId);
  if (!w) return;
  replays.delete(tabId);
  w.cancelled = true;
  for (const fn of [...w.wakers]) fn();
  // The tabs stayed awake for a Play that isn't coming now.
  if (sleepTabs) for (const id of w.group) if (!players.has(leaderOf(id))) letSleep(id);
}

// Schedules the Play; returns the note the panel shows until it starts.
function playAgainLater(tabId, group, { why, run, reset }) {
  const t = tabs.get(tabId);
  t.restarts = (t.restarts || 0) + 1;
  const ms = t.restarts <= 3 ? 1000 : t.restarts <= 6 ? 5000 : 20000;
  const w = { cancelled: false, wakers: new Set(), group };
  cancelReplay(tabId, false);
  replays.set(tabId, w);
  (async () => {
    await sleep(ms, w); // chunked, so the worker stays awake through the wait
    if (w.cancelled || replays.get(tabId) !== w) return;
    replays.delete(tabId);
    const now = tabs.get(tabId);
    if (!now || !now.on || now.mode !== "idle" || !now.tape.steps.length) {
      for (const id of group) letSleep(id);
      return;
    }
    now.play = { index: 0, run };
    startPlayback(tabId, false, { group, reset });
  })();
  return `${why}. Stopped. Playing again in ${ms / 1000} s (restart ${t.restarts}). Close this note to cancel.`;
}

// ---------- tape files and settings ----------

function cleanTape(raw) {
  if (!raw || ![1, 2, 3, 4].includes(raw.v) || !Array.isArray(raw.steps)) throw new Error("This is not a TinyTab tape.");
  const startUrl = typeof raw.startUrl === "string" ? raw.startUrl : "";
  // v1 tapes had one tab; v2 adds a list of tabs and a slot on each step.
  // v3 added copy and paste steps, v4 right-clicks; nothing to migrate.
  const list = raw.v >= 2 && Array.isArray(raw.tabs) && raw.tabs.length ? raw.tabs : [{ startUrl }];
  const tabsOut = list.slice(0, 8).map((x) => ({ startUrl: x && typeof x.startUrl === "string" ? x.startUrl : "" }));
  const steps = raw.steps.filter((s) => s && STEP_TYPES.has(s.type));
  for (const s of steps) {
    s.dt = Math.max(0, Math.min(Number(s.dt) || 0, MAX_DT));
    if (s.type === "path" && !Array.isArray(s.pts)) s.pts = [];
    const k = s.tab | 0;
    if (k > 0 && k < tabsOut.length) s.tab = k;
    else delete s.tab;
  }
  return {
    v: 4,
    name: String(raw.name || "Loaded tape").slice(0, 120),
    startUrl: tabsOut[0].startUrl,
    tabs: tabsOut,
    createdAt: Number(raw.createdAt) || Date.now(),
    steps,
  };
}

function applySettings(t, patch) {
  const s = { ...t.settings };
  if ("speed" in patch && SPEEDS.includes(patch.speed)) s.speed = patch.speed;
  if ("repeat" in patch) s.repeat = Math.max(1, Math.min(9999, patch.repeat | 0 || 1));
  for (const k of ["loop", "startPage", "shield", "skipMissing", "awake", "recover", "resetSession"]) if (k in patch) s[k] = !!patch[k];
  t.settings = s;
  defaults = { ...s };
  chrome.storage.local.set({ defaults }).catch(() => {});
}

// ---------- message router ----------

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg && msg.target) return; // for the offscreen page or the AI check (ai.js)
  const tabId = sender.tab && sender.tab.id;
  if (tabId == null || sender.frameId !== 0) return;
  handle(tabId, msg, sender.tab.url).then(reply, (e) => reply({ ok: false, error: String((e && e.message) || e) }));
  return true;
});

async function handle(tabId, msg, url) {
  await ready;
  const t = getTab(tabId);
  switch (msg.type) {
    case "hello":
      alive.add(tabId);
      if (t.mode === "recording") getTab(leaderOf(tabId)).lastAt = Date.now();
      if (t.mode === "playing" && awakeTabs.has(tabId)) keepAwake(tabId);
      netErrors.delete(tabId); // TinyTab runs here, so this is a real page
      markReady(tabId);
      applyBadge(tabId);
      return snapshot(tabId);
    case "rec": {
      appendStep(tabId, msg.step, msg.at || Date.now(), url);
      return { ok: true };
    }
    case "status": {
      // What the player is waiting for; shown in every linked tab's panel.
      const lead = leaderOf(tabId);
      if (players.has(lead)) sendGroup(lead, { type: "status", text: String(msg.text || "").slice(0, 120) });
      return { ok: true };
    }
    case "log":
      // An error inside TinyTab's scripts on a page.
      log(`TinyTab error on ${pageOf(url) || "a page"}: ${String(msg.text || "").slice(0, 500)}`);
      return { ok: true };
    case "acted": {
      const ctl = players.get(leaderOf(tabId));
      if (ctl) {
        ctl.acted = msg.i;
        ctl.actAt = Date.now();
      }
      return { ok: true };
    }
    case "copied": {
      if (typeof msg.text !== "string" || !msg.text) return { ok: true };
      const leadId = leaderOf(tabId);
      const lead = tabs.get(leadId);
      if (lead && lead.mode === "recording") {
        // Mark the click (or key) that made the site copy, so playback waits for it.
        const slot = Math.max(0, groupOf(leadId).indexOf(tabId));
        const steps = lead.tape.steps;
        for (let i = steps.length - 1; i >= 0 && i >= steps.length - 4; i--) {
          const st = steps[i];
          if ((st.tab || 0) !== slot) continue;
          if (st.type === "copy") break; // Ctrl+C or menu copy: already its own step
          if (st.type === "click" || st.type === "dbl" || st.type === "key") {
            st.copies = true;
            persist(leadId);
            break;
          }
        }
        return { ok: true };
      }
      // A site's Copy button ran during playback. Only trust it right after
      // TinyTab acted in one of its own tabs, so other pages can't plant text.
      const ctl = players.get(leadId);
      if (ctl && Date.now() - ctl.actAt < 5000) setClip(ctl, msg.text, tabId);
      return { ok: true };
    }
    case "keepalive":
      return { ok: true }; // a panel is showing: stay awake (content/deck.js)
    case "cmd":
      return command(tabId, t, { ...msg, url });
  }
  return { ok: false };
}

async function command(tabId, t, msg) {
  if (t.link != null && ["record", "play", "stop"].includes(msg.action)) {
    msg = { ...msg, url: undefined }; // the leader's page, not this one
    tabId = leaderOf(tabId);
    t = getTab(tabId);
  }
  switch (msg.action) {
    case "record":
      await toggleRecord(tabId, msg.url);
      break;
    case "play":
      await togglePlay(tabId);
      break;
    case "stop":
      cancelReplay(tabId);
      if (t.mode === "playing") stopPlayback(tabId);
      if (t.mode === "recording") stopRecording(tabId);
      break;
    case "off":
      cancelReplay(tabId);
      await setOn(tabId, false);
      break;
    case "clear":
      if (t.mode !== "idle") return { ok: false };
      cancelReplay(tabId);
      t.tape = emptyTape();
      t.error = "";
      persist(tabId, true);
      notify(tabId);
      break;
    case "settings":
      applySettings(t, msg.patch || {});
      persist(tabId);
      notifyGroup(tabId);
      break;
    case "load": {
      if (t.mode !== "idle") return { ok: false, error: "Stop first, then open a tape." };
      cancelReplay(tabId);
      t.tape = cleanTape(msg.tape);
      t.error = "";
      t.play = { index: 0, run: 1 };
      rememberTape(t.tape);
      persist(tabId, true);
      notify(tabId);
      break;
    }
    case "getLog":
      await loadLog();
      return { ok: true, lines: logLines.slice() };
    case "aiSettings":
      await chrome.runtime.openOptionsPage();
      break;
    case "getTape": {
      const tape = structuredClone(t.tape);
      for (const s of tape.steps) delete s.t0;
      return { ok: true, tape };
    }
    case "dismiss":
      cancelReplay(tabId); // closing "Playing again in ..." cancels that Play
      t.error = "";
      persist(tabId);
      break;
  }
  return { ok: true };
}

// The AI check was set up or switched: the panels show it.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local" || !changes.ai) return;
  aiConfig = cleanAiConfig(changes.ai.newValue);
  await ready;
  for (const [id, t] of tabs) if (t.on) notify(id);
});

// ---------- cleanup ----------

chrome.tabs.onRemoved.addListener((tabId) => {
  alive.delete(tabId);
  stopPlayback(tabId);
  players.delete(tabId);
  tabs.delete(tabId);
  navPending.delete(tabId);
  netErrors.delete(tabId);
  readyWaiters.delete(tabId);
  chrome.storage.session.remove("t:" + tabId).catch(() => {});
});

chrome.tabs.onReplaced.addListener((added, removed) => {
  const t = tabs.get(removed);
  if (!t) return;
  tabs.delete(removed);
  chrome.storage.session.remove("t:" + removed).catch(() => {});
  tabs.set(added, t);
  persist(added, true);
});

// Test hook: lets automated tests toggle a tab without a toolbar click.
self.__tinytab = { clipWrites: () => clipWrites, nativePastes: () => nativePastes, setOn, toggleRecord, togglePlay, stopPlayback, getTab, snapshot, ready, leaderOf };
