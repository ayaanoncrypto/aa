// Records real user input on the page and streams each step to the service worker.
// Only trusted events count, so TinyTab's own playback never records itself.
(() => {
  if (globalThis.__tinytabBooted) return;
  const TT = globalThis.TinyTab;

  const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "NumLock", "ScrollLock", "Fn", "AltGraph", "OS", "Dead", "Process", "Unidentified"]);
  const SCROLL_IDLE = 160;

  let active = false;
  let settings = {};
  let pending = null; // pointerdown waiting for its click
  let lastUserInput = 0;
  let lastCopyKeyAt = 0; // Ctrl+C / Ctrl+X, or a right-click menu

  const pasted = new WeakMap(); // field -> its value right after a paste
  // The fields a paste landed in. Code widgets (one box per digit) spread a paste
  // over several boxes and move focus mid-paste, so boxes fire input and change
  // events that are the paste, not typing. { root, at, typed }
  let pasteZone = null;

  // The paste's field plus its neighbours: the nearest ancestor holding 2+ fields.
  function zoneOf(el) {
    let n = el.parentElement;
    for (let d = 0; n && d < 4; d++, n = n.parentElement) {
      if (n.querySelectorAll('input, textarea, [contenteditable=""], [contenteditable="true"]').length >= 2) return n;
    }
    return el;
  }

  // True for input/change events a paste caused rather than real typing.
  function fromPaste(e, el) {
    if (!pasteZone || !el || !TT.isTextField(el) || !pasteZone.root.contains(el)) return false;
    if (pasteZone.typed.has(el)) return false;
    if (e.type === "change") return true; // a pasted value committed on blur
    return Date.now() - pasteZone.at < 1000; // the site spreading the paste
  }
  const scrolls = new Map(); // scroller -> { at, timer }

  // ----- hovers that open menus -----
  // Some menus are only put on the page while the mouse is over something
  // ("Account"). A replayed click on "Log Out" would find nothing, so when a
  // click lands on something that appeared just after the mouse went over
  // another element, that hover is recorded first. Other hovers are not.
  const HOVER_REVEAL_MS = 2500;
  let hovers = []; // { el, at }, newest last
  let added = new WeakMap(); // element -> when it was put on the page
  let lastClickAt = 0;
  let lastHoverEmitted = null;
  const watcher = new MutationObserver((list) => {
    const now = Date.now();
    for (const m of list) for (const n of m.addedNodes) if (n.nodeType === 1) added.set(n, now);
  });

  function onMouseOver(e) {
    if (!ok(e)) return;
    const el = TT.clickTarget(TT.realTarget(e));
    if (!el || (hovers.length && hovers[hovers.length - 1].el === el)) return;
    hovers.push({ el, at: Date.now() });
    if (hovers.length > 12) hovers = hovers.slice(-12);
  }

  // The hover that made `el` appear, or null.
  function revealingHover(el) {
    let shown = 0;
    let box = null;
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      if (added.has(n)) {
        shown = added.get(n);
        box = n;
        break;
      }
    }
    if (!shown || Date.now() - shown > 15000) return null;
    for (let i = hovers.length - 1; i >= 0; i--) {
      const h = hovers[i];
      if (h.at > shown || box.contains(h.el) || !h.el.isConnected) continue;
      if (shown - h.at > HOVER_REVEAL_MS) return null;
      // A click in between made it appear; that click is on the tape already.
      if (lastClickAt > h.at && lastClickAt <= shown) return null;
      return h.el;
    }
    return null;
  }

  function noteHoverFor(el) {
    const h = revealingHover(el);
    if (!h || h === lastHoverEmitted) return;
    lastHoverEmitted = h;
    const r = h.getBoundingClientRect();
    emit({ type: "hover", target: TT.describe(h), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
  }

  const mods = (e) => {
    const m = {};
    if (e.ctrlKey) m.ctrl = 1;
    if (e.shiftKey) m.shift = 1;
    if (e.altKey) m.alt = 1;
    if (e.metaKey) m.meta = 1;
    return m;
  };

  function post(step, at) {
    TT.send({ type: "rec", step, at }).catch(() => {});
  }


  function flushScrolls() {
    for (const [target, s] of scrolls) {
      clearTimeout(s.timer);
      emitScroll(target, s.at);
    }
    scrolls.clear();
  }

  function emit(step, at = Date.now()) {
    flushScrolls();
    post(step, at);
  }

  function relPoint(el, x, y) {
    const r = el.getBoundingClientRect();
    return {
      rx: r.width ? TT.clamp((x - r.left) / r.width, 0, 1) : 0.5,
      ry: r.height ? TT.clamp((y - r.top) / r.height, 0, 1) : 0.5,
    };
  }

  const ok = (e) => active && e.isTrusted && !TT.isOwnEvent(e);

  // ----- mouse -----

  function onPointerDown(e) {
    if (!ok(e)) return;
    lastUserInput = Date.now();
    if (e.button !== 0 || e.pointerType === "touch") return;
    const el = TT.clickTarget(TT.realTarget(e));
    if (!el) return;
    noteHoverFor(el);
    lastClickAt = Date.now();
    pending = { el, target: TT.describe(el), x: e.clientX, y: e.clientY, ...relPoint(el, e.clientX, e.clientY), m: mods(e), done: false };
  }

  function onPointerUp(e) {
    if (!ok(e) || !pending) return;
    const p = pending;
    // Some menus act on mousedown and remove the element, so no click ever fires.
    setTimeout(() => {
      if (p.done || pending !== p) return;
      pending = null;
      emit({ type: "click", target: p.target, rx: p.rx, ry: p.ry, x: p.x, y: p.y, detail: 1, mods: p.m });
    }, 80);
  }

  function onClick(e) {
    if (!ok(e) || e.button !== 0) return;
    // detail 0 means keyboard activation or a label forwarding its click; the key step covers it.
    if (e.detail === 0) return;
    const el = TT.clickTarget(TT.realTarget(e));
    if (!el) return;
    const p = pending;
    let target;
    let rel;
    if (p && !p.done && (p.el === el || p.el.contains(el) || el.contains(p.el))) {
      target = p.target;
      rel = { rx: p.rx, ry: p.ry };
    } else {
      target = TT.describe(el);
      rel = relPoint(el, e.clientX, e.clientY);
    }
    if (p) p.done = true;
    pending = null;
    emit({ type: "click", target, ...rel, x: e.clientX, y: e.clientY, detail: e.detail || 1, mods: mods(e) });
  }

  function onDblClick(e) {
    if (!ok(e)) return;
    const el = TT.clickTarget(TT.realTarget(e));
    if (!el) return;
    const step = { type: "dbl", target: TT.describe(el), ...relPoint(el, e.clientX, e.clientY), x: e.clientX, y: e.clientY };
    // A double-click in a field selects a word; remember where, to select it again.
    if ((el.localName === "input" || el.localName === "textarea") && typeof el.selectionStart === "number") {
      try {
        step.sel = [el.selectionStart, el.selectionEnd];
      } catch (_) {}
    }
    emit(step);
  }


  // ----- typing and form controls -----

  function valueStep(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.isContentEditable) {
      const root = TT.editableRoot(el);
      return { type: "input", kind: "rich", target: TT.describe(root), value: root.innerText };
    }
    const tag = el.localName;
    if (tag === "select") return { type: "input", kind: "select", target: TT.describe(el), value: el.value, label: el.selectedOptions[0] ? el.selectedOptions[0].text : "" };
    if (tag === "textarea") return { type: "input", kind: "text", target: TT.describe(el), value: el.value };
    if (tag !== "input") return null;
    const t = (el.type || "text").toLowerCase();
    if (t === "file" || t === "hidden") return null;
    if (t === "checkbox" || t === "radio") return { type: "input", kind: "check", target: TT.describe(el), checked: el.checked };
    if (TT.isTextField(el)) return { type: "input", kind: "text", target: TT.describe(el), value: el.value };
    return { type: "input", kind: "value", target: TT.describe(el), value: el.value };
  }

  function onInput(e) {
    if (!ok(e)) return;
    lastUserInput = Date.now();
    const el = TT.realTarget(e);
    // A paste is recorded as a paste step, so its text must not become typing.
    if (e.inputType === "insertFromPaste") return;
    if (el && pasted.has(el) && pasted.get(el) === fieldValue(el)) return;
    if (fromPaste(e, el)) return;
    const step = valueStep(el);
    if (step) emit(step);
  }

  function onKeyDown(e) {
    if (!ok(e) || e.isComposing || MODIFIERS.has(e.key)) return;
    lastUserInput = Date.now();
    const el = TT.realTarget(e);
    if (pasteZone && el && !e.ctrlKey && !e.metaKey && (e.key.length === 1 || e.key === "Backspace" || e.key === "Delete") && pasteZone.root.contains(el)) {
      pasteZone.typed.add(el);
    }
    const editable = TT.isTextField(el) || (el && el.localName === "select");
    const printable = e.key.length === 1;
    const combo = e.ctrlKey || e.metaKey;
    // F5 / Ctrl+R (/ Cmd+R) reload the page: a reload step, not a key a page
    // could ignore. Chrome may report the reload too; the worker keeps one.
    if (TT.isReloadKey(e.key, mods(e))) {
      emit({ type: "nav", kind: "reload" });
      return;
    }
    // Copy, cut and paste shortcuts become copy and paste steps instead.
    if (combo && !e.altKey && ["c", "v", "x", "insert"].includes(e.key.toLowerCase())) {
      if (e.key.toLowerCase() !== "v") lastCopyKeyAt = Date.now();
      return;
    }
    if (e.shiftKey && (e.key === "Insert" || e.key === "Delete")) return;
    if (editable && !combo && (printable || e.key === "Backspace" || e.key === "Delete")) return;
    const onBody = !el || el === document.body || el === document.documentElement;
    emit({
      type: "key",
      key: e.key,
      code: e.code,
      keyCode: e.keyCode,
      mods: mods(e),
      target: onBody ? null : TT.describe(TT.editableRoot(el)),
    });
  }

  // ----- copy and paste -----

  function fieldValue(el) {
    if (!el) return "";
    if (el.isContentEditable) return TT.editableRoot(el).innerText;
    return "value" in el ? String(el.value) : "";
  }

  // What was copied, and where from, so playback can copy the fresh text.
  function copySource() {
    const active = document.activeElement;
    if (active && (active.localName === "input" || active.localName === "textarea") && typeof active.selectionStart === "number") {
      const v = active.value || "";
      const a = active.selectionStart;
      const b = active.selectionEnd;
      return { target: TT.describe(active), whole: a === 0 && b === v.length, start: a, end: b, text: v.slice(a, b) };
    }
    const sel = getSelection();
    const text = sel ? sel.toString() : "";
    if (!sel || !sel.rangeCount || !text) return null;
    const range = sel.getRangeAt(0);
    let node = range.commonAncestorContainer;
    if (node.nodeType !== 1) node = node.parentElement;
    if (!node) return null;
    const full = node.textContent || "";
    // Where the selection starts in the element's text, to find the same spot later.
    let off = null;
    try {
      const pre = document.createRange();
      pre.selectNodeContents(node);
      pre.setEnd(range.startContainer, range.startOffset);
      off = pre.toString().length;
    } catch (_) {}
    return { target: TT.describe(node), whole: full.trim() === text.trim(), text, off };
  }

  function onContextMenu(e) {
    if (!ok(e)) return;
    lastCopyKeyAt = Date.now(); // a copy from this menu is a real copy step
    const el = TT.clickTarget(TT.realTarget(e));
    if (!el) return;
    emit({ type: "rclick", target: TT.describe(el), ...relPoint(el, e.clientX, e.clientY), x: e.clientX, y: e.clientY });
  }

  function onCopy(e) {
    if (!ok(e)) return;
    // Without Ctrl+C or a right-click menu, a site's own Copy button did this.
    // Its click is on the tape already, and playback copies again from it.
    if (Date.now() - lastCopyKeyAt > 15000) return;
    lastCopyKeyAt = 0;
    const src = copySource();
    if (src) emit({ type: "copy", ...src });
  }

  function onPaste(e) {
    if (!ok(e)) return;
    lastUserInput = Date.now();
    let el = TT.realTarget(e);
    if (!el) return;
    if (el.isContentEditable) el = TT.editableRoot(el);
    else if (!TT.isTextField(el)) return;
    const text = e.clipboardData ? e.clipboardData.getData("text/plain") : "";
    // Set before anything else: the site may react inside this same event.
    pasteZone = { root: zoneOf(el), at: Date.now(), typed: new WeakSet() };
    emit({ type: "paste", target: TT.describe(el), text });
    setTimeout(() => pasted.set(el, fieldValue(el)), 0);
  }

  // ----- scrolling -----

  function emitScroll(target, at) {
    if (!active) return;
    const isWin = target === document || target === document.documentElement || target === document.scrollingElement;
    const x = isWin ? scrollX : target.scrollLeft;
    const y = isWin ? scrollY : target.scrollTop;
    post({ type: "scroll", target: isWin ? null : TT.describe(target), x: Math.round(x), y: Math.round(y) }, at);
  }

  function onScroll(e) {
    if (!active || TT.isOwnEvent(e)) return;
    // Only scrolling the user caused; auto-scrolling widgets are ignored.
    if (Date.now() - lastUserInput > 1500) return;
    const target = e.target;
    if (!target || (target.nodeType !== 1 && target !== document)) return;
    const now = Date.now();
    let s = scrolls.get(target);
    if (!s) {
      s = { at: now, timer: 0 };
      scrolls.set(target, s);
    }
    s.at = now;
    clearTimeout(s.timer);
    s.timer = setTimeout(() => {
      scrolls.delete(target);
      emitScroll(target, s.at);
    }, SCROLL_IDLE);
  }

  function onWheel(e) {
    if (e.isTrusted) lastUserInput = Date.now();
  }

  function onPageHide() {
    if (!active) return;
    flushScrolls();
  }

  const opts = { capture: true, passive: true };
  const bindings = [
    [window, "mouseover", onMouseOver],
    [window, "pointerdown", onPointerDown],
    [window, "pointerup", onPointerUp],
    [window, "click", onClick],
    [window, "dblclick", onDblClick],
    [window, "input", onInput],
    [window, "change", onInput],
    [window, "keydown", onKeyDown],
    [window, "copy", onCopy],
    [window, "cut", onCopy],
    [window, "paste", onPaste],
    [window, "contextmenu", onContextMenu],
    [window, "wheel", onWheel],
    [window, "touchmove", onWheel],
    [document, "scroll", onScroll],
    [window, "pagehide", onPageHide],
  ];

  TT.recorder = {
    get active() {
      return active;
    },
    start(s) {
      settings = s || {};
      if (active) return;
      active = true;
      pending = null;
      lastUserInput = 0;
      hovers = [];
      added = new WeakMap();
      lastClickAt = 0;
      lastHoverEmitted = null;
      watcher.observe(document.documentElement, { childList: true, subtree: true });
      for (const [t, type, fn] of bindings) t.addEventListener(type, fn, opts);
    },
    flush() {
      if (active) flushScrolls();
    },
    stop() {
      if (!active) return;
      flushScrolls();
      active = false;
      watcher.disconnect();
      hovers = [];
      for (const [t, type, fn] of bindings) t.removeEventListener(type, fn, opts);
    },
  };
})();
