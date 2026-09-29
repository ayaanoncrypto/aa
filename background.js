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
const FAST_WAIT_MS = 250;
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

// ---------- state ----------

const tabs = new Map(); // tabId -> persisted state
const players = new Map(); // tabId -> playback controller (not persisted)
const readyWaiters = new Map(); // tabId -> Set of resolvers
const navPending = new Map(); // tabId -> true while a cross-document load is in flight
const netErrors = new Map(); // tabId -> net::ERR_* while the tab shows Chrome's error page
const replays = new Map(); // tabId -> the wait before a stuck playback is played again

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
function log(text) {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  logLines.push(`${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}  ${String(text).slice(0, 600)}`);
  if (logLines.length > LOG_MAX) logLines = logLines.slice(-LOG_MAX);
  clearTimeout(logTimer);
  logTimer = setTimeout(() => chrome.storage.local.set({ log: logLines }).catch(() => {}), 400);
}
self.addEventListener("error", (e) => log(`TinyTab error: ${e.message || e.error} (${e.filename || ""}:${e.lineno || ""})`));
self.addEventListener("unhandledrejection", (e) => log(`TinyTab error: ${(e.reason && (e.reason.stack || e.reason.message)) || e.reason}`));

const ready = (async () => {
  const [local, session] = await Promise.all([
    chrome.storage.local.get(["defaults", "lastTape", "log"]),
    chrome.storage.session.get(null),
  ]);
  defaults = { ...DEFAULTS, ...(local.defaults || {}) };
  lastTape = local.lastTape || null;
  logLines = [...(local.log || []), ...logLines].slice(-LOG_MAX);
  const open = new Set((await chrome.tabs.query({})).map((t) => t.id));
  for (const [key, value] of Object.entries(session)) {
    if (!key.startsWith("t:")) continue;
    const id = Number(key.slice(2));
    if (open.has(id)) {
      value.settings = { ...DEFAULTS, ...value.settings }; // settings added since it was saved
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
    if (t) chrome.storage.session.set({ ["t:" + tabId]: t }).catch(() => {});
  };
  if (now) write();
  else saveTimers.set(tabId, setTimeout(write, 250));
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
  try {
    const pong = await sendWithTimeout(tabId, { type: "ping" }, 1500);
    if (pong && pong.ok) return true;
  } catch (_) {}
  try {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ["content/clipboard-main.js"], world: "MAIN" }).catch(() => {});
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: CONTENT_FILES });
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
    if (on) {
      await ensureContent(tabId);
      if (t.mode === "idle") await joinRecording(tabId);
    }
    notify(tabId);
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
  if (command === "toggle-record") toggleRecord(tab.id);
  if (command === "toggle-play") togglePlay(tab.id);
});

// ---------- recording ----------

async function toggleRecord(tabId) {
  cancelReplay(tabId);
  const t = getTab(tabId);
  if (t.mode === "recording") return stopRecording(tabId);
  if (t.mode === "playing") stopPlayback(tabId);
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  t.tape = emptyTape(tab ? tab.url : "");
  t.mode = "recording";
  t.error = "";
  t.lastAt = Date.now();
  t.play = { index: 0, run: 1 };
  t.group = [tabId];
  delete t.link;
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
    rememberTape(t.tape);
  }
  for (const id of members) {
    const m = tabs.get(id);
    if (m && t.tape.steps.length) m.tape = structuredClone(t.tape);
    releaseMember(id);
  }
  persist(tabId, true);
  notify(tabId);
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
    if (!awakeTabs.has(tabId)) {
      await chrome.debugger.attach({ tabId }, "1.3");
      awakeTabs.add(tabId);
    }
    await chrome.debugger.sendCommand({ tabId }, "Emulation.setFocusEmulationEnabled", { enabled: true });
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
  return chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ["content/clipboard-main.js"], world: "MAIN" }).catch(() => {});
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
  await new Promise((r) => setTimeout(r, 400)); // the site spreads the paste
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
    if (navPending.get(tabId)) {
      const ok = await waitReady(tabId, READY_TIMEOUT, ctl);
      if (!ok && !ctl.cancelled) return { ok: false, error: "The page did not finish loading" };
      if (ctl.cancelled) return { ok: true };
    }
    if (netErrors.has(tabId)) return offline(tabId);
    ctl.acted = -1;
    try {
      const res = await sendWithTimeout(tabId, msg, performTimeout(msg));
      if (res) return res;
    } catch (e) {
      if (ctl.acted === msg.i) return { ok: true, x: null };
      if (String(e && e.message) === "timeout") return { ok: false, error: "The page stopped responding" };
    }
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
const PLACE_WAIT_MS = 20000; // how long a reloaded page gets to draw the step's element
const PLACE_SETTLE_MS = 4000; // extra time for it once other steps' elements are there
const LATE_WAIT_MS = 60000; // on the right page, how much longer to wait for late content (an email)

const say = (lead, text) => {
  if (text) log(`  ${text}`);
  sendGroup(lead, { type: "status", text });
};

// Reloads a stuck page and waits for it, giving a slow connection a second
// READY_TIMEOUT. False when the page can't be brought back.
async function reloadStuck(lead, id, ctl) {
  say(lead, "The page seems stuck. Reloading it");
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
    await sleep(2000, ctl);
    if (navPending.get(id)) await waitReady(id, READY_TIMEOUT, ctl);
  }
  say(lead, "");
  return pressed;
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
    if (await here(id, k, START_WAIT_MS)) continue;
    const what = steps[k].target.text ? `"${steps[k].target.text.slice(0, 40)}"` : "its first button or field";
    sendGroup(lead, { type: "warn", text: `Tab ${s + 1} doesn't look like the start of the recording (${what} isn't there). Resetting it.` });
    // A popup in the way?
    const r0 = await sendWithTimeout(id, { type: "unblock" }, 15000).catch(() => null);
    if (r0 && r0.done && r0.done.length) {
      log(`  Closed a popup: ${r0.done.join(", ")}`);
      if (await here(id, k, 3000)) continue;
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
    tries: new Map(), // step index -> recoveries at that step in this run
  };
  players.set(tabId, ctl);

  const t = getTab(tabId);
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
        const speed = speedOf(t);
        const fastPace = t.settings.speed === "fast";
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
          step: fastPace && step.dur > 500 ? { ...step, dur: 500 } : step,
          lead,
          speed: speed === Infinity ? "max" : speed,
          patient: fastPace || speed === Infinity, // wait for elements instead of pauses
          // Right after trouble, don't wait long for an element before trying the next fix.
          wait: i <= (ctl.shakyUntil ?? -1) && (fastPace || speed === Infinity) ? 20000 : 0,
          from: ctl.last,
          clip: ctl.clip,
          settings: t.settings,
        };
        let res = await performStep(target, ctl, msg);
        if (res && res.ok && typeof res.copied === "string" && res.copied) setClip(ctl, res.copied, target);
        if (res && res.ok && (step.copies || step.type === "copy") && !ctl.cancelled) {
          // Wait for the site's Copy button to copy. A page still loading its text
          // copies nothing yet, so try the click again a few times.
          let got = await waitClip(ctl, seq0, 1200);
          for (let r = 0; !got && r < 25 && !ctl.cancelled; r++) {
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
        if (ctl.cancelled) break;
        if (res && res.x != null) last.set(target, { x: res.x, y: res.y });
        if (res && "hidden" in res) hidden.set(target, !!res.hidden);
        if (res && res.hidden && speed !== Infinity) {
          // Typing and mouse paths finish instantly when hidden; keep their real length.
          const span = step.type === "input" ? Math.min(step.dur || 0, fastPace ? 500 : 30000) : 0;
          await sleep(Math.min(span, 30000) / speed, ctl);
        }
        if (!res || !res.ok) {
          const what = `Step ${i + 1}: ${(res && res.error) || "failed"}`;
          const down = !!(res && res.down) || netErrors.has(target);
          const lost = !!(res && res.missing) && !down;
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
          replay = { why: trouble, run: t.play.run };
          break;
        }
        sendGroup(tabId, { type: "warn", text: `${trouble}. Going on from step ${k + 1}.` });
        t.play.index = k;
        persist(tabId);
        notifyGroup(tabId);
        continue;
      }
      t.restarts = 0; // a whole run went through
      ctl.tries.clear();
      t.play.index = 0;
      t.play.run += 1;
      persist(tabId);
      if (t.play.run <= runs()) await sleep(speedOf(t) === Infinity ? 50 : 400 / speedOf(t), ctl);
    }
  } catch (e) {
    error = String((e && e.message) || e);
  } finally {
    for (const id of group) send(id, { type: "clip", text: null }).catch(() => {});
    if (players.get(tabId) === ctl) {
      players.delete(tabId);
      for (const id of group) {
        letSleep(id);
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

function cancelReplay(tabId) {
  const w = replays.get(tabId);
  if (!w) return;
  replays.delete(tabId);
  w.cancelled = true;
  for (const fn of [...w.wakers]) fn();
}

// Schedules the Play; returns the note the panel shows until it starts.
function playAgainLater(tabId, group, { why, run }) {
  const t = tabs.get(tabId);
  t.restarts = (t.restarts || 0) + 1;
  const ms = t.restarts <= 3 ? 3000 : t.restarts <= 6 ? 15000 : 60000;
  const w = { cancelled: false, wakers: new Set() };
  cancelReplay(tabId);
  replays.set(tabId, w);
  (async () => {
    await sleep(ms, w); // chunked, so the worker stays awake through the wait
    if (w.cancelled || replays.get(tabId) !== w) return;
    replays.delete(tabId);
    const now = tabs.get(tabId);
    if (!now || !now.on || now.mode !== "idle" || !now.tape.steps.length) return;
    now.play = { index: 0, run };
    startPlayback(tabId, false, { group });
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
    case "cmd":
      return command(tabId, t, msg);
  }
  return { ok: false };
}

async function command(tabId, t, msg) {
  if (t.link != null && ["record", "play", "stop"].includes(msg.action)) {
    tabId = leaderOf(tabId);
    t = getTab(tabId);
  }
  switch (msg.action) {
    case "record":
      await toggleRecord(tabId);
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
      return { ok: true, lines: logLines.slice() };
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

// ---------- cleanup ----------

chrome.tabs.onRemoved.addListener((tabId) => {
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
