// The in-page control panel: a small glass card in Google's Material 3 style.
// Lives in a closed shadow root so the page's CSS and scripts can't reach it.
(() => {
  if (globalThis.__tinytabBooted) return;
  const TT = globalThis.TinyTab;

  const Z = 2147483646;
  const SPEEDS = [
    ["fast", "Fast"],
    [1, "1x"],
    [2, "2x"],
    ["max", "Max"],
  ];

  const I = {
    rec: '<circle cx="12" cy="12" r="6" fill="currentColor"/>',
    play: '<path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/>',
    stop: '<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor"/>',
    open: '<path d="M4 7.5A1.5 1.5 0 0 1 5.5 6H10l2 2h6.5A1.5 1.5 0 0 1 20 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
    save: '<path d="M12 4v10m0 0-4-4m4 4 4-4M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
    log: '<path d="M7 4h7l4 4v11a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z M14 4v4h4 M9 12h6 M9 15.5h6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" stroke-linecap="round"/>',
    gear: '<path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M19.4 13.5a7.7 7.7 0 0 0 0-3l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.5A7.6 7.6 0 0 0 7 6.5l-2.4-1-2 3.4 2 1.6a7.7 7.7 0 0 0 0 3l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a7.6 7.6 0 0 0 2.6-1.5l2.4 1 2-3.4z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
    min: '<path d="M6 12h12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
    close: '<path d="m7 7 10 10M17 7 7 17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  };
  const icon = (n, s = 20) => `<svg viewBox="0 0 24 24" width="${s}" height="${s}" aria-hidden="true">${I[n]}</svg>`;

  const CSS = `
  :host { all: initial; position: fixed; z-index: ${Z}; left: 0; top: 0; }
  * { box-sizing: border-box; }
  .card {
    --primary: #0B57D0; --on-primary: #fff; --tonal: rgba(11, 87, 208, .1); --on-tonal: #0842A0;
    --text: #1F1F1F; --soft: #444746; --faint: rgba(31, 31, 31, .08); --rec: #D93025; --on-rec: #fff;
    --glass: rgba(255, 255, 255, .74); --edge: rgba(255, 255, 255, .7); --track: rgba(11, 87, 208, .14);
    position: fixed; width: 312px; padding: 12px; border-radius: 24px; color: var(--text);
    background: var(--glass); border: 1px solid var(--edge);
    -webkit-backdrop-filter: blur(24px) saturate(180%); backdrop-filter: blur(24px) saturate(180%);
    box-shadow: 0 8px 32px rgba(0, 0, 0, .16), 0 1px 3px rgba(0, 0, 0, .1);
    font: 400 14px/1.4 "TinyTab Roboto", Roboto, "Google Sans", "Segoe UI", system-ui, sans-serif;
    user-select: none; -webkit-user-select: none; touch-action: none;
  }
  @media (prefers-color-scheme: dark) {
    .card { --primary: #A8C7FA; --on-primary: #062E6F; --tonal: rgba(168, 199, 250, .16); --on-tonal: #D3E3FD;
      --text: #E3E3E3; --soft: #C4C7C5; --faint: rgba(227, 227, 227, .1); --rec: #F2B8B5; --on-rec: #601410;
      --glass: rgba(32, 33, 36, .72); --edge: rgba(255, 255, 255, .12); --track: rgba(168, 199, 250, .2); }
  }
  button, input { font: inherit; color: inherit; }
  button { cursor: pointer; border: 0; background: none; }
  :focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }

  .top { display: flex; align-items: center; gap: 8px; height: 32px; padding-left: 6px; cursor: grab; }
  .top:active { cursor: grabbing; }
  .dot { flex: none; width: 10px; height: 10px; border-radius: 50%; background: var(--faint); box-shadow: inset 0 0 0 1.5px var(--soft); }
  .card[data-mode="recording"] .dot { background: var(--rec); box-shadow: none; }
  .card[data-mode="playing"] .dot { background: var(--primary); box-shadow: none; }
  .name { font-weight: 500; font-size: 15px; }
  .status { flex: 1; min-width: 0; color: var(--soft); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ib { flex: none; width: 32px; height: 32px; display: grid; place-items: center; border-radius: 50%; color: var(--soft); transition: background-color .15s; }
  .ib:hover { background: var(--faint); color: var(--text); }
  .ib:disabled { opacity: .38; cursor: default; background: none; }

  .main { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 10px; }
  .btn { height: 44px; display: flex; align-items: center; justify-content: center; gap: 8px; border-radius: 22px;
    font-weight: 500; font-size: 14px; letter-spacing: .01em; transition: background-color .15s, box-shadow .15s, transform .08s; }
  .btn:active:not(:disabled) { transform: scale(.98); }
  .btn:disabled { opacity: .38; cursor: default; }
  .rec { background: var(--tonal); color: var(--on-tonal); }
  .rec svg { color: var(--rec); }
  .rec:hover:not(:disabled) { box-shadow: 0 1px 3px rgba(0, 0, 0, .15); }
  .rec[aria-pressed="true"] { background: var(--rec); color: var(--on-rec); }
  .rec[aria-pressed="true"] svg { color: var(--on-rec); }
  .play { background: var(--primary); color: var(--on-primary); }
  .play:hover:not(:disabled) { box-shadow: 0 1px 3px rgba(0, 0, 0, .25); }

  .row { display: flex; align-items: center; gap: 4px; margin-top: 10px; }
  .row .grow { flex: 1; }
  .bar { height: 4px; border-radius: 2px; background: var(--track); overflow: hidden; margin: 12px 4px 0; }
  .fill { height: 100%; width: 0; border-radius: 2px; background: var(--primary); transition: width .25s ease; }
  .card[data-mode="recording"] .fill { background: var(--rec); }
  .info { display: flex; justify-content: space-between; margin: 6px 4px 0; color: var(--soft); font-size: 12px; font-variant-numeric: tabular-nums; }

  .msg { margin-top: 10px; display: flex; gap: 8px; align-items: flex-start; padding: 10px 8px 10px 12px; border-radius: 14px;
    background: #303030; color: #F2F2F2; font-size: 13px; }
  .msg.warn { background: var(--tonal); color: var(--text); }
  .msg p { margin: 0; flex: 1; }
  .msg .ib { width: 24px; height: 24px; color: inherit; }

  .panel { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--faint); display: grid; gap: 14px; }
  .lbl { font-size: 12px; font-weight: 500; color: var(--soft); margin-bottom: 6px; }
  .seg { display: grid; grid-template-columns: repeat(4, 1fr); border: 1px solid rgba(116, 119, 117, .5); border-radius: 18px; overflow: hidden; }
  .seg button { height: 34px; font-size: 13px; font-weight: 500; border-left: 1px solid rgba(116, 119, 117, .5); }
  .seg button:first-child { border-left: 0; }
  .seg button[aria-pressed="true"] { background: var(--tonal); color: var(--on-tonal); }
  .hint { margin-top: 6px; font-size: 12px; color: var(--soft); }
  .rep { display: flex; align-items: center; gap: 12px; }
  .step { display: flex; align-items: center; border: 1px solid rgba(116, 119, 117, .5); border-radius: 18px; height: 34px; }
  .step button { width: 34px; height: 32px; font-size: 18px; border-radius: 16px; }
  .step button:hover { background: var(--faint); }
  .step input { width: 44px; border: 0; background: transparent; text-align: center; font-variant-numeric: tabular-nums; -moz-appearance: textfield; user-select: text; }
  .step input::-webkit-inner-spin-button, .step input::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
  .step input:disabled { opacity: .5; }
  .sw { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 13px; cursor: pointer; }
  .sw input { position: absolute; opacity: 0; width: 1px; height: 1px; }
  .track { flex: none; position: relative; width: 44px; height: 24px; border-radius: 12px; background: var(--faint); box-shadow: inset 0 0 0 2px #747775; transition: background-color .15s; }
  .track::after { content: ""; position: absolute; top: 6px; left: 6px; width: 12px; height: 12px; border-radius: 50%; background: #747775; transition: transform .15s, width .15s, height .15s, top .15s; }
  .sw input:checked + .track { background: var(--primary); box-shadow: none; }
  .sw input:checked + .track::after { top: 4px; width: 16px; height: 16px; transform: translateX(20px); background: var(--on-primary); }
  .sw input:focus-visible + .track { outline: 2px solid var(--primary); outline-offset: 2px; }
  .foot { display: flex; align-items: center; justify-content: space-between; }
  .text-btn { height: 32px; padding: 0 12px; border-radius: 16px; color: var(--primary); font-weight: 500; font-size: 13px; }
  .text-btn:hover:not(:disabled) { background: var(--tonal); }
  .text-btn:disabled { opacity: .38; cursor: default; }
  .keys { font-size: 11px; color: var(--soft); line-height: 1.5; }

  .card.min { width: auto; padding: 6px 6px 6px 12px; border-radius: 22px; }
  .card.min .top { height: 32px; }
  .card.min .body { display: none; }
  .mini { display: none; font-size: 13px; font-weight: 500; font-variant-numeric: tabular-nums; }
  .card.min .mini { display: inline; }
  .card.min .status { display: none; }
  [hidden] { display: none !important; }
  @media (prefers-reduced-motion: reduce) { .fill, .track, .track::after { transition: none; } }
  `;

  const HTML = `
  <div class="card" data-mode="idle" role="region" aria-label="TinyTab">
    <div class="top">
      <i class="dot"></i><span class="name">TinyTab</span>
      <span class="status">Ready</span><span class="mini"></span>
      <button class="ib" data-act="min" title="Minimize" aria-label="Minimize">${icon("min")}</button>
      <button class="ib" data-act="off" title="Turn off in this tab" aria-label="Turn off in this tab">${icon("close")}</button>
    </div>
    <div class="body">
      <div class="main">
        <button class="btn rec" data-act="record" aria-pressed="false" title="Record (Alt+Shift+R)">${icon("rec")}<span>Record</span></button>
        <button class="btn play" data-act="play" aria-pressed="false" title="Play (Alt+Shift+P)">${icon("play")}<span>Play</span></button>
      </div>
      <div class="bar"><div class="fill"></div></div>
      <div class="info"><span class="left">No recording yet</span><span class="right"></span></div>
      <div class="row">
        <button class="ib" data-act="open" title="Open a saved recording" aria-label="Open a saved recording">${icon("open")}</button>
        <button class="ib" data-act="save" title="Save this recording" aria-label="Save this recording">${icon("save")}</button>
        <button class="ib" data-act="savelog" title="Save the log (what playback did and what went wrong)" aria-label="Save the log">${icon("log")}</button>
        <span class="grow"></span>
        <button class="ib" data-act="prefs" title="Settings" aria-label="Settings" aria-expanded="false">${icon("gear")}</button>
      </div>
      <div class="msg" hidden role="status"><p></p><button class="ib" data-act="dismiss" aria-label="Dismiss">${icon("close", 16)}</button></div>
      <div class="panel" hidden>
        <div>
          <div class="lbl">Speed</div>
          <div class="seg" role="group" aria-label="Speed">
            ${SPEEDS.map(([v, l]) => `<button data-speed="${v}" aria-pressed="false">${l}</button>`).join("")}
          </div>
          <div class="hint">Fast skips your pauses and waits only for what the page needs.</div>
        </div>
        <div class="rep">
          <div>
            <div class="lbl">Repeat</div>
            <div class="step">
              <button data-act="rep-" aria-label="Fewer runs">&minus;</button>
              <input type="number" min="1" max="9999" value="1" aria-label="Number of runs">
              <button data-act="rep+" aria-label="More runs">+</button>
            </div>
          </div>
          <label class="sw" style="flex:1;align-self:end;height:34px">Loop forever<input type="checkbox" data-set="loop"><span class="track"></span></label>
        </div>
        <label class="sw">Start each run on the first page<input type="checkbox" data-set="startPage"><span class="track"></span></label>
        <div>
          <label class="sw">Skip steps it can't find<input type="checkbox" data-set="skipMissing"><span class="track"></span></label>
          <div class="hint">Only while "Recover on its own" is off. Recovery skips steps that really are optional by itself.</div>
        </div>
        <div>
          <label class="sw">Recover on its own<input type="checkbox" data-set="recover"><span class="track"></span></label>
          <div class="hint">Connection lost or page stuck: reloads and goes on from the step the page is at. Nothing fits: logs out, stops, then plays again.</div>
        </div>
        <div>
          <label class="sw">Start each run like the recording<input type="checkbox" data-set="resetSession"><span class="track"></span></label>
          <div class="hint">If a site doesn't look like it did when you recorded (still signed in, say), log out or disconnect first. No button for it: clear that site's cookies and storage.</div>
        </div>
        <div>
          <div class="sw" style="cursor:default">AI check<button class="text-btn" data-act="ai">Set up</button></div>
          <div class="hint ai-hint"></div>
        </div>
        <div class="foot">
          <div class="keys">Alt+Shift+R record, Alt+Shift+P play<br>Alt+Shift+T on and off</div>
          <button class="text-btn" data-act="clear">Clear</button>
        </div>
      </div>
      <input type="file" accept=".json,application/json" hidden>
    </div>
  </div>`;

  // ---------- font ----------

  let fontsLoaded = false;
  function loadFonts() {
    if (fontsLoaded) return;
    fontsLoaded = true;
    for (const [file, weight] of [
      ["roboto-latin-400-normal.woff2", "400"],
      ["roboto-latin-500-normal.woff2", "500"],
    ]) {
      fetch(chrome.runtime.getURL("fonts/" + file))
        .then((r) => r.arrayBuffer())
        .then((buf) => new FontFace("TinyTab Roboto", buf, { weight }).load())
        .then((f) => document.fonts.add(f))
        .catch(() => {}); // system fonts stand in
    }
  }

  // ---------- panel ----------

  let host = null;
  let root = null;
  let $ = null;
  let state = null;
  let count = 0; // steps on the tape
  let prefsOpen = false;
  let minimized = false;
  let pos = null;
  let keeper = null;
  let msgTimer = 0;
  let waiting = "";

  function build() {
    loadFonts();
    host = document.createElement("tinytab-deck");
    root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>${CSS}</style>${HTML}`;
    $ = (s) => root.querySelector(s);
    // Keep typing inside the panel away from page shortcuts.
    for (const t of ["keydown", "keyup", "keypress", "input", "change"]) root.addEventListener(t, (e) => e.stopPropagation());
    // Buttons must not steal focus from the page (a recording may be typing into a field).
    root.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) e.preventDefault();
    });
    root.addEventListener("click", onClick);
    root.addEventListener("change", onChange, true);
    $(".step input").addEventListener("change", (e) => setSetting({ repeat: Math.max(1, Math.min(9999, parseInt(e.target.value, 10) || 1)) }));
    $("input[type=file]").addEventListener("change", onFile);
    setupDrag();
    window.addEventListener("resize", () => place(pos), { passive: true });
    chrome.storage.local.get(["deckPos", "deckMin"]).then((v) => {
      if (v.deckPos) place(v.deckPos);
      if (v.deckMin) setMin(true, false);
    }, () => {});
  }

  function mount() {
    if (host && host.isConnected) return;
    if (!host) build();
    document.documentElement.appendChild(host);
    if (!pos) place(null);
    if (!keeper) {
      // Some pages rebuild <html>; put the panel back if it gets removed.
      keeper = new MutationObserver(() => {
        if (host && !host.isConnected && state && state.on) document.documentElement.appendChild(host);
      });
      keeper.observe(document.documentElement, { childList: true });
    }
  }

  function unmount() {
    if (keeper) keeper.disconnect();
    keeper = null;
    if (host) host.remove();
  }

  function place(p) {
    if (!host) return;
    const card = $(".card");
    const w = card.offsetWidth || 312;
    const h = card.offsetHeight || 180;
    const left = p ? p.left : innerWidth - w - 24;
    const top = p ? p.top : innerHeight - h - 24;
    pos = { left: TT.clamp(left, 8, Math.max(8, innerWidth - w - 8)), top: TT.clamp(top, 8, Math.max(8, innerHeight - h - 8)) };
    card.style.left = pos.left + "px";
    card.style.top = pos.top + "px";
  }

  function setupDrag() {
    const top = $(".top");
    let start = null;
    top.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || e.target.closest("button")) return;
      start = { x: e.clientX, y: e.clientY, left: pos.left, top: pos.top };
      top.setPointerCapture(e.pointerId);
    });
    top.addEventListener("pointermove", (e) => {
      if (start) place({ left: start.left + e.clientX - start.x, top: start.top + e.clientY - start.y });
    });
    const end = () => {
      if (!start) return;
      start = null;
      chrome.storage.local.set({ deckPos: pos }).catch(() => {});
    };
    top.addEventListener("pointerup", end);
    top.addEventListener("pointercancel", end);
  }

  function setMin(v, save = true) {
    const card = $(".card");
    const right = pos ? pos.left + card.offsetWidth : null;
    minimized = v;
    card.classList.toggle("min", v);
    const b = $('[data-act="min"]');
    b.title = v ? "Expand" : "Minimize";
    b.setAttribute("aria-label", b.title);
    if (save) chrome.storage.local.set({ deckMin: v }).catch(() => {});
    // Keep the right edge still, so the button stays under the pointer.
    if (right != null && card.offsetWidth) place({ left: right - card.offsetWidth, top: pos.top });
  }

  // ---------- actions ----------

  async function command(action, extra = {}) {
    if (action === "record" || action === "play" || action === "off") TT.recorder.flush();
    try {
      const res = await TT.send({ type: "cmd", action, ...extra });
      if (res && res.ok === false && res.error) message(res.error, "error");
      return res;
    } catch (_) {
      TT.orphaned && TT.orphaned();
      return null;
    }
  }

  const setSetting = (patch) => command("settings", { patch });

  function onClick(e) {
    const b = e.target.closest("button");
    if (!b) return;
    const speed = b.getAttribute("data-speed");
    if (speed) return setSetting({ speed: speed === "fast" || speed === "max" ? speed : Number(speed) });
    const act = b.getAttribute("data-act");
    switch (act) {
      case "record":
      case "play":
      case "off":
      case "clear":
        return command(act);
      case "min":
        return setMin(!minimized);
      case "prefs":
        prefsOpen = !prefsOpen;
        render();
        requestAnimationFrame(() => place(pos));
        return;
      case "open":
        $("input[type=file]").value = "";
        return $("input[type=file]").click();
      case "save":
        return save();
      case "savelog":
        return saveLog();
      case "ai":
        return command("aiSettings");
      case "dismiss":
        hideMessage();
        return command("dismiss");
      case "rep-":
      case "rep+": {
        const cur = (state && state.settings.repeat) || 1;
        return setSetting({ repeat: Math.max(1, Math.min(9999, cur + (act === "rep+" ? 1 : -1))) });
      }
    }
  }

  function onChange(e) {
    const key = e.target.getAttribute && e.target.getAttribute("data-set");
    if (key) setSetting({ [key]: e.target.checked });
  }

  async function onFile(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    try {
      const res = await command("load", { tape: JSON.parse(await file.text()) });
      if (res && res.ok) message(`Opened "${file.name}".`, "warn", 3000);
    } catch (_) {
      message("That file is not a TinyTab recording.", "error");
    }
  }

  const stamp = () => {
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}`;
  };

  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    root.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  async function save() {
    const res = await command("getTape");
    if (!res || !res.tape || !res.tape.steps.length) return message("Nothing to save yet.", "warn", 3000);
    let site = "recording";
    try {
      site = new URL(res.tape.startUrl).hostname.replace(/^www\./, "") || site;
    } catch (_) {}
    download(`tinytab-${site.replace(/[^\w.-]+/g, "-")}-${stamp()}.json`, JSON.stringify(res.tape), "application/json");
  }

  // The activity log, as a text file in Downloads.
  async function saveLog() {
    const res = await command("getLog");
    const lines = (res && res.lines) || [];
    if (!lines.length) return message("The log is empty so far.", "warn", 3000);
    const head = `TinyTab ${chrome.runtime.getManifest().version} log, saved ${new Date().toString()}\n\n`;
    download(`tinytab-log-${stamp()}.txt`, head + lines.join("\n") + "\n", "text/plain");
  }

  // ---------- messages ----------

  function message(text, kind = "error", ms = 0) {
    if (!root) return;
    clearTimeout(msgTimer);
    const box = $(".msg");
    box.className = "msg" + (kind === "warn" ? " warn" : "");
    box.querySelector("p").textContent = text;
    box.hidden = false;
    if (ms) msgTimer = setTimeout(hideMessage, ms);
    requestAnimationFrame(() => place(pos));
  }

  function hideMessage() {
    if (root) $(".msg").hidden = true;
  }

  // ---------- render ----------

  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

  function statusText(s) {
    const where = (s.linked || 1) > 1 ? ` in ${s.linked} tabs` : "";
    if (s.mode === "recording") return `Recording${where}`;
    if (s.mode === "playing") return waiting || `Playing${where}`;
    return count ? "Ready to play" : "Ready";
  }

  function paintProgress() {
    const s = state;
    const fill = $(".fill");
    const left = $(".left");
    const right = $(".right");
    if (s.mode === "recording") {
      fill.style.width = "100%";
      left.textContent = `${plural(count, "step")} recorded`;
      right.textContent = "";
    } else if (s.mode === "playing") {
      fill.style.width = count ? `${(Math.min(s.index, count) / count) * 100}%` : "0";
      left.textContent = `Step ${Math.min(s.index + 1, count)} of ${count}`;
      right.textContent = s.settings.loop ? `Run ${s.run}, looping` : `Run ${Math.min(s.run, s.runs)} of ${s.runs}`;
    } else {
      fill.style.width = "0";
      left.textContent = count ? `${plural(count, "step")}${(s.linked || 1) > 1 ? `, ${s.linked} tabs` : ""}` : "No recording yet";
      right.textContent = "";
    }
    $(".mini").textContent = s.mode === "idle" ? "" : s.mode === "recording" ? String(count) : `${Math.min(s.index, count)} / ${count}`;
  }

  function render() {
    const s = state;
    if (!root || !s) return;
    count = s.ticks.length;
    const card = $(".card");
    card.setAttribute("data-mode", s.mode);
    $(".status").textContent = statusText(s);

    const rec = $('[data-act="record"]');
    const play = $('[data-act="play"]');
    rec.setAttribute("aria-pressed", String(s.mode === "recording"));
    rec.innerHTML = s.mode === "recording" ? `${icon("stop")}<span>Stop</span>` : `${icon("rec")}<span>Record</span>`;
    play.setAttribute("aria-pressed", String(s.mode === "playing"));
    play.innerHTML = s.mode === "playing" ? `${icon("stop")}<span>Stop</span>` : `${icon("play")}<span>Play</span>`;
    play.disabled = s.mode === "idle" && !count;
    $('[data-act="open"]').disabled = s.mode !== "idle";
    $('[data-act="save"]').disabled = s.mode !== "idle" || !count;
    $('[data-act="clear"]').disabled = s.mode !== "idle" || !count;
    $('[data-act="prefs"]').setAttribute("aria-expanded", String(prefsOpen));
    $(".panel").hidden = !prefsOpen;

    const st = s.settings;
    root.querySelectorAll("[data-speed]").forEach((b) => b.setAttribute("aria-pressed", String(String(st.speed) === b.getAttribute("data-speed"))));
    const rep = $(".step input");
    if (root.activeElement !== rep) rep.value = st.repeat;
    rep.disabled = !!st.loop;
    root.querySelectorAll("[data-set]").forEach((c) => (c.checked = !!st[c.getAttribute("data-set")]));
    $('[data-act="ai"]').textContent = s.ai ? "Settings" : "Set up";
    $(".ai-hint").textContent = s.ai
      ? `On, with ${s.ai}. A step stuck over ${s.aiAfter} s: asks it what the page shows, then logs out, reloads or starts again. Needs "Recover on its own".`
      : "Off. An AI model (DeepSeek) looks at a stuck page and tells TinyTab to log out, reload or start again.";

    paintProgress();
    if (s.error) message(s.error, "error");
    else if ($(".msg").className === "msg" && !$(".msg").hidden) hideMessage();
  }

  TT.deck = {
    show(s) {
      state = s;
      if (s.mode !== "playing") waiting = "";
      mount();
      render();
    },
    hide() {
      state = null;
      unmount();
    },
    tick() {
      if (!root || !state || state.mode !== "recording") return;
      count++;
      state.ticks.push("");
      paintProgress();
    },
    progress(i, _eta, run) {
      if (!root || !state || state.mode !== "playing") return;
      state.index = i;
      if (run !== state.run) state.run = run;
      paintProgress();
    },
    done(i) {
      if (!root || !state || state.mode !== "playing") return;
      state.index = i + 1;
      paintProgress();
    },
    // What playback is waiting for right now ("" when nothing).
    status(text) {
      waiting = text || "";
      if (root && state) $(".status").textContent = statusText(state);
    },
    message,
    get mounted() {
      return !!(host && host.isConnected);
    },
  };
})();
