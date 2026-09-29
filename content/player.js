// Plays steps back with TinyTab's own virtual mouse.
// Input is dispatched straight to page elements, so the real mouse and keyboard stay free.
(() => {
  if (globalThis.__tinytabBooted) return;
  const TT = globalThis.TinyTab;

  const Z = 2147483647;
  const FOCUSABLE =
    'a[href], area[href], button, input:not([type="hidden"]), select, textarea, summary, iframe, [tabindex], [contenteditable=""], [contenteditable="true"]';

  // ---------- virtual cursor ----------

  const CURSOR_CSS = `
    :host { all: initial; position: fixed; left: 0; top: 0; z-index: ${Z}; pointer-events: none; contain: layout style; }
    .c { position: fixed; left: 0; top: 0; will-change: transform; pointer-events: none; }
    svg { display: block; filter: drop-shadow(0 1px 2px rgba(0, 0, 0, .35)); }
    .tag { position: absolute; left: 18px; top: 20px; padding: 3px 8px; border-radius: 8px;
      background: #0B57D0; color: #fff; font: 500 11px/1.3 "TinyTab Roboto", Roboto, "Segoe UI", system-ui, sans-serif;
      letter-spacing: .01em; white-space: nowrap; box-shadow: 0 1px 3px rgba(0, 0, 0, .25); }
    .key { position: absolute; left: 18px; top: 42px; padding: 3px 8px; border-radius: 8px; opacity: 0;
      background: rgba(31, 31, 31, .88); color: #fff; font: 500 11px/1.3 "TinyTab Roboto", Roboto, "Segoe UI", system-ui, sans-serif; white-space: nowrap; }
    .ring { position: fixed; left: 0; top: 0; width: 30px; height: 30px; margin: -15px 0 0 -15px; border-radius: 50%;
      background: rgba(11, 87, 208, .22); box-sizing: border-box; opacity: 0; pointer-events: none; }
  `;

  const cursor = {
    host: null,
    box: null,
    keyEl: null,
    root: null,
    x: -1,
    y: -1,
    visible: false,
    mount() {
      if (this.host && this.host.isConnected) return;
      this.host = document.createElement("tinytab-cursor");
      this.root = this.host.attachShadow({ mode: "closed" });
      this.root.innerHTML = `<style>${CURSOR_CSS}</style>
        <div class="c" style="display:none">
          <svg width="22" height="26" viewBox="0 0 22 26" aria-hidden="true">
            <path d="M2.5 1.5 L2.5 19.5 L7.2 15.1 L10.3 22.2 L13.6 20.8 L10.6 13.8 L17 13.6 Z"
              fill="#1F1F1F" stroke="#FFFFFF" stroke-width="1.5" stroke-linejoin="round"/>
          </svg>
          <div class="tag">TinyTab</div>
          <div class="key"></div>
        </div>`;
      this.box = this.root.querySelector(".c");
      this.keyEl = this.root.querySelector(".key");
      document.documentElement.appendChild(this.host);
    },
    show(from) {
      this.mount();
      if (this.x < 0) {
        const p = from || { x: innerWidth * 0.6, y: innerHeight * 0.55 };
        this.set(TT.clamp(p.x, 0, innerWidth - 4), TT.clamp(p.y, 0, innerHeight - 4));
      }
      this.box.style.display = "block";
      this.visible = true;
    },
    hide() {
      if (this.box) this.box.style.display = "none";
      this.visible = false;
    },
    set(x, y) {
      this.x = x;
      this.y = y;
      if (this.box) this.box.style.transform = `translate3d(${x - 2}px, ${y - 1}px, 0)`;
    },
    ripple() {
      if (!this.root || TT.hidden()) return;
      const ring = document.createElement("div");
      ring.className = "ring";
      ring.style.transform = `translate3d(${this.x}px, ${this.y}px, 0)`;
      this.root.appendChild(ring);
      const a = ring.animate(
        [
          { opacity: 0.95, transform: `translate3d(${this.x}px, ${this.y}px, 0) scale(.35)` },
          { opacity: 0, transform: `translate3d(${this.x}px, ${this.y}px, 0) scale(1.25)` },
        ],
        { duration: 420, easing: "cubic-bezier(.2,.7,.3,1)" }
      );
      a.onfinish = () => ring.remove();
    },
    showKey(text) {
      if (!this.keyEl || TT.hidden()) return;
      this.keyEl.textContent = text;
      this.keyEl.animate([{ opacity: 1 }, { opacity: 1, offset: 0.7 }, { opacity: 0 }], { duration: 800 });
    },
    unmount() {
      if (this.host) this.host.remove();
      this.host = this.box = this.root = this.keyEl = null;
      this.x = this.y = -1;
    },
  };

  // ---------- shield: keeps a stray real mouse from disturbing playback ----------

  const shield = {
    host: null,
    mount() {
      if (this.host && this.host.isConnected) return;
      this.host = document.createElement("tinytab-shield");
      const root = this.host.attachShadow({ mode: "closed" });
      root.innerHTML = `<style>
        :host { all: initial; position: fixed; inset: 0; z-index: ${Z - 2}; cursor: default; }
        div { position: absolute; inset: 0; box-shadow: inset 0 0 0 2px rgba(11, 87, 208, .55); pointer-events: none; }
      </style><div></div>`;
      const stop = (e) => {
        e.stopPropagation();
        if (e.cancelable && e.type !== "wheel") e.preventDefault();
      };
      for (const t of ["pointerdown", "pointerup", "mousedown", "mouseup", "click", "dblclick", "contextmenu"]) this.host.addEventListener(t, stop, true);
      document.documentElement.appendChild(this.host);
    },
    unmount() {
      if (this.host) this.host.remove();
      this.host = null;
    },
  };
  TT.shieldEl = () => shield.host;

  // ---------- event helpers ----------

  const NON_BUBBLING = new Set(["mouseenter", "mouseleave", "pointerenter", "pointerleave"]);

  function fireMouse(type, el, x, y, extra = {}) {
    const Ctor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
    const bubbles = !NON_BUBBLING.has(type);
    const down = type === "pointerdown" || type === "mousedown";
    const init = {
      bubbles,
      cancelable: bubbles,
      composed: bubbles,
      view: window,
      clientX: x,
      clientY: y,
      screenX: Math.round(x + (window.screenX || 0)),
      screenY: Math.round(y + (window.screenY || 0) + (outerHeight - innerHeight)),
      button: extra.button || 0,
      buttons: down ? (extra.button === 2 ? 2 : 1) : 0,
      detail: extra.detail || (type.includes("click") ? 1 : 0),
      ctrlKey: !!(extra.mods && extra.mods.ctrl),
      shiftKey: !!(extra.mods && extra.mods.shift),
      altKey: !!(extra.mods && extra.mods.alt),
      metaKey: !!(extra.mods && extra.mods.meta),
      relatedTarget: extra.related || null,
    };
    if (Ctor === PointerEvent) Object.assign(init, { pointerId: 1, pointerType: "mouse", isPrimary: true, width: 1, height: 1, pressure: down ? 0.5 : 0 });
    return el.dispatchEvent(new Ctor(type, init));
  }

  // An element and everything around it, innermost first, through shadow roots.
  function ancestry(el) {
    const out = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement || (n.getRootNode && n.getRootNode().host) || null) out.push(n);
    return out;
  }

  let hoverEl = null;
  function hover(x, y, forced) {
    const el = forced || TT.elementAt(x, y);
    if (!el) return;
    if (el !== hoverEl) {
      // Like a real pointer: out/over bubble and name the other element;
      // leave/enter reach each element the pointer left or entered, so a menu
      // that opens when the pointer enters its box (not just the icon) opens.
      const old = hoverEl && hoverEl.isConnected ? hoverEl : null;
      const was = old ? ancestry(old) : [];
      const now = ancestry(el);
      const left = was.filter((n) => !now.includes(n)); // innermost first
      const entered = now.filter((n) => !was.includes(n)).reverse(); // outermost first
      if (old) {
        fireMouse("pointerout", old, x, y, { related: el });
        for (const n of left) fireMouse("pointerleave", n, x, y, { related: el });
        fireMouse("mouseout", old, x, y, { related: el });
        for (const n of left) fireMouse("mouseleave", n, x, y, { related: el });
      }
      fireMouse("pointerover", el, x, y, { related: old });
      for (const n of entered) fireMouse("pointerenter", n, x, y, { related: old });
      fireMouse("mouseover", el, x, y, { related: old });
      for (const n of entered) fireMouse("mouseenter", n, x, y, { related: old });
      hoverEl = el;
    }
    fireMouse("pointermove", el, x, y);
    fireMouse("mousemove", el, x, y);
  }

  function focusFor(el) {
    const f = el.closest ? el.closest(FOCUSABLE) : null;
    if (f && typeof f.focus === "function") {
      if (document.activeElement !== f) f.focus({ preventScroll: true });
    } else if (document.activeElement && document.activeElement !== document.body && document.activeElement.blur) {
      document.activeElement.blur();
    }
  }

  function clickSequence(el, x, y, detail = 1, mods) {
    hover(x, y, el);
    const extra = { detail, mods };
    const pd = fireMouse("pointerdown", el, x, y, extra);
    const md = pd ? fireMouse("mousedown", el, x, y, extra) : false;
    if (md && el.isConnected) focusFor(el);
    const target = el.isConnected ? el : TT.elementAt(x, y) || document.body;
    fireMouse("pointerup", target, x, y, extra);
    if (pd) fireMouse("mouseup", target, x, y, extra);
    fireMouse("click", target, x, y, extra);
  }

  function inView(el) {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) {
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    }
  }

  function pointIn(el, rx, ry) {
    const r = el.getBoundingClientRect();
    const px = r.left + r.width * (rx == null ? 0.5 : rx);
    const py = r.top + r.height * (ry == null ? 0.5 : ry);
    return {
      x: TT.clamp(px, r.left + Math.min(2, r.width / 2), r.right - Math.min(2, r.width / 2)),
      y: TT.clamp(py, r.top + Math.min(2, r.height / 2), r.bottom - Math.min(2, r.height / 2)),
    };
  }

  // Glides the cursor to (x, y) on a soft arc. It doesn't hover what it passes
  // over: a menu that closes when the mouse leaves it would close on the way to
  // its own item. The step at the end hovers its element.
  async function glide(x, y, ms, cancelled) {
    const sx = cursor.x;
    const sy = cursor.y;
    const dist = Math.hypot(x - sx, y - sy);
    if (sx < 0 || dist < 2 || ms < 40) {
      cursor.set(x, y);
      return;
    }
    const bend = Math.min(60, dist * 0.12);
    const nx = -(y - sy) / dist;
    const ny = (x - sx) / dist;
    const cx = (sx + x) / 2 + nx * bend;
    const cy = (sy + y) / 2 + ny * bend;
    await TT.animate(
      ms,
      (p) => {
        const e = TT.easeInOut(p);
        const a = (1 - e) * (1 - e);
        const b = 2 * (1 - e) * e;
        const c = e * e;
        cursor.set(a * sx + b * cx + c * x, a * sy + b * cy + c * y);
      },
      cancelled
    );
  }

  // Waits for a control to become usable. False if it is still disabled: a
  // "Next" that stays grey means the form before it isn't filled in, and a
  // click would do nothing while the tape carries on as if it had worked.
  async function waitEnabled(el, ms) {
    const end = performance.now() + ms;
    while (TT.isDisabled(el) && performance.now() < end && el.isConnected) {
      await new Promise((r) => setTimeout(r, 100));
    }
    return !el.isConnected || !TT.isDisabled(el);
  }

  // ---------- typing ----------

  const nativeSetter = (el) => {
    const proto = el.localName === "textarea" ? HTMLTextAreaElement.prototype : el.localName === "select" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    return Object.getOwnPropertyDescriptor(proto, "value").set;
  };

  function setValue(el, v) {
    nativeSetter(el).call(el, v);
  }

  function fireInput(el, inputType, data) {
    el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType, data: data == null ? null : data }));
  }

  function fireKey(type, el, key, code, keyCode, mods = {}) {
    return el.dispatchEvent(
      new KeyboardEvent(type, {
        key,
        code: code || "",
        keyCode: keyCode || 0,
        which: keyCode || 0,
        charCode: type === "keypress" && key.length === 1 ? key.charCodeAt(0) : 0,
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        ctrlKey: !!mods.ctrl,
        shiftKey: !!mods.shift,
        altKey: !!mods.alt,
        metaKey: !!mods.meta,
      })
    );
  }

  const charCode = (ch) => {
    if (/^[a-z]$/i.test(ch)) return ["Key" + ch.toUpperCase(), ch.toUpperCase().charCodeAt(0)];
    if (/^[0-9]$/.test(ch)) return ["Digit" + ch, ch.charCodeAt(0)];
    if (ch === " ") return ["Space", 32];
    return ["", 0];
  };

  function typingPlan(len, ms) {
    if (!(ms > 30) || len === 0 || len > 600 || TT.hidden()) return { chunk: len || 1, gap: 0 };
    const per = ms / len;
    const chunk = Math.max(1, Math.ceil(24 / per));
    return { chunk, gap: per * chunk };
  }

  async function typeText(el, value, ms, cancelled) {
    const cur = el.value;
    if (cur === value) return;
    let base = cur;
    if (!value.startsWith(cur)) {
      base = "";
      setValue(el, "");
      fireInput(el, "deleteContentBackward", null);
    }
    const rest = value.slice(base.length);
    const plan = typingPlan(rest.length, ms);
    for (let i = 0; i < rest.length; i += plan.chunk) {
      if (cancelled()) return;
      const part = rest.slice(i, i + plan.chunk);
      const [code, kc] = charCode(part[0]);
      fireKey("keydown", el, part[0], code, kc);
      fireKey("keypress", el, part[0], code, kc);
      setValue(el, base + rest.slice(0, i + part.length));
      fireInput(el, "insertText", part);
      fireKey("keyup", el, part[0], code, kc);
      if (plan.gap) await TT.sleep(plan.gap);
    }
    if (el.value !== value) {
      setValue(el, value);
      fireInput(el, "insertText", null);
    }
  }

  async function typeRich(el, value, ms, cancelled) {
    const current = el.innerText;
    if (current === value) return;
    el.focus({ preventScroll: true });
    const sel = getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    let rest = value;
    if (value.startsWith(current) && current.length) {
      range.collapse(false);
      rest = value.slice(current.length);
    }
    sel.removeAllRanges();
    sel.addRange(range);
    if (!range.collapsed) document.execCommand("delete", false);
    const plan = typingPlan(rest.length, ms);
    for (let i = 0; i < rest.length; i += plan.chunk) {
      if (cancelled()) return;
      const part = rest.slice(i, i + plan.chunk);
      if (!document.execCommand("insertText", false, part)) {
        el.innerText = value;
        fireInput(el, "insertText", value);
        return;
      }
      if (plan.gap) await TT.sleep(plan.gap);
    }
  }

  async function fillInput(el, step, ms, cancelled) {
    const kind = step.kind;
    if (kind === "check") {
      if (el.checked !== !!step.checked) {
        const p = pointIn(el, 0.5, 0.5);
        clickSequence(el, p.x, p.y);
        if (el.checked !== !!step.checked) {
          el.checked = !!step.checked;
          fireInput(el, null, null);
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
      }
      return;
    }
    if (el.localName !== "select" && document.activeElement !== el) el.focus({ preventScroll: true });
    if (kind === "rich") return typeRich(el, step.value || "", ms, cancelled);
    if (kind === "select") {
      if (el.value !== step.value) {
        setValue(el, step.value);
        if (el.value !== step.value && step.label) {
          const opt = Array.from(el.options).find((o) => o.text === step.label);
          if (opt) el.selectedIndex = opt.index;
        }
        fireInput(el, null, null);
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return;
    }
    if (kind === "value") {
      setValue(el, step.value);
      fireInput(el, "insertReplacementText", null);
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    await typeText(el, step.value || "", ms, cancelled);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // ---------- copy and paste ----------

  // The text a recorded copy would take from this element now.
  // The run of non-space text around `pos` (an email, a code, a word).
  function tokenAt(text, pos) {
    let a = Math.max(0, Math.min(pos, text.length));
    let b = a;
    while (a > 0 && !/\s/.test(text[a - 1])) a--;
    while (b < text.length && !/\s/.test(text[b])) b++;
    return [a, b];
  }

  // Word boundaries the way a double-click finds them.
  function wordAt(text, pos) {
    try {
      const seg = new Intl.Segmenter(undefined, { granularity: "word" });
      for (const s of seg.segment(text)) {
        if (pos >= s.index && pos < s.index + s.segment.length && s.isWordLike) return [s.index, s.index + s.segment.length];
      }
    } catch (_) {}
    return tokenAt(text, pos);
  }

  // A replayed double-click doesn't select text in Chrome; select the word here.
  function selectWordAt(el, x, y, step) {
    if (el.localName === "input" || el.localName === "textarea") {
      const v = String(el.value || "");
      const [a, b] = wordAt(v, step.sel ? step.sel[0] : Math.floor(v.length / 2));
      try {
        el.focus({ preventScroll: true });
        el.setSelectionRange(a, b);
      } catch (_) {}
      return;
    }
    const shield = TT.shieldEl && TT.shieldEl();
    if (shield) shield.style.pointerEvents = "none";
    const r = document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
    if (shield) shield.style.pointerEvents = "";
    if (!r || !el.contains(r.startContainer)) return;
    const node = r.startContainer;
    if (node.nodeType !== 3) return;
    const [a, b] = wordAt(node.data, r.startOffset);
    if (a === b) return;
    const range = document.createRange();
    range.setStart(node, a);
    range.setEnd(node, b);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // What a real Ctrl+C would copy right now: the selected part of a focused
  // field, else the text highlighted on the page.
  function liveSelection() {
    const a = document.activeElement;
    if (a && (a.localName === "input" || a.localName === "textarea")) {
      try {
        return a.value.slice(a.selectionStart, a.selectionEnd);
      } catch (_) {
        return "";
      }
    }
    const sel = getSelection();
    const text = sel ? sel.toString() : "";
    return text.trim() ? text : "";
  }

  // The text a recorded copy would take now. What is selected wins, like a real copy.
  function copyFrom(el, step) {
    if (el.localName === "input" || el.localName === "textarea") {
      const v = String(el.value || "");
      try {
        if (el.selectionStart !== el.selectionEnd) return v.slice(el.selectionStart, el.selectionEnd);
      } catch (_) {}
      if (step.whole || step.start == null) return v;
      return v.slice(...tokenAt(v, step.start));
    }
    const sel = getSelection();
    const live = sel && sel.rangeCount ? sel.toString() : "";
    if (live.trim() && (el.contains(sel.anchorNode) || el.contains(sel.focusNode))) return live;
    const full = el.textContent || "";
    if (step.whole || !step.text) return full.trim();
    // Part of the text: take the same spot in today's text, not the old words.
    if (step.off != null) {
      if (!/\s/.test(step.text.trim())) return full.slice(...tokenAt(full, step.off + (step.text.length - step.text.trimStart().length)));
      return full.substr(step.off, step.text.length);
    }
    return full.trim();
  }

  function pasteInto(el, text) {
    if (document.activeElement !== el && typeof el.focus === "function") el.focus({ preventScroll: true });
    // Sites that read the clipboard on paste get this text (see clipboard-main.js).
    document.dispatchEvent(new CustomEvent("tinytab:clip", { detail: text }));
    let data = null;
    try {
      data = new DataTransfer();
      data.setData("text/plain", text);
    } catch (_) {}
    // Sites that handle paste themselves (code boxes, formatted fields) get the event first.
    const ev = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true, composed: true });
    if (!el.dispatchEvent(ev)) return;
    if (el.isContentEditable) {
      if (!document.execCommand("insertText", false, text)) {
        el.innerText += text;
        fireInput(el, "insertFromPaste", null);
      }
      return;
    }
    const v = String(el.value || "");
    let a = v.length;
    let b = v.length;
    try {
      if (typeof el.selectionStart === "number") {
        a = el.selectionStart;
        b = el.selectionEnd;
      }
    } catch (_) {}
    setValue(el, v.slice(0, a) + text + v.slice(b));
    try {
      el.setSelectionRange(a + text.length, a + text.length);
    } catch (_) {}
    fireInput(el, "insertFromPaste", null);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // ---------- keys ----------

  const KEY_NAMES = { Enter: "Enter", Tab: "Tab", Escape: "Esc", " ": "Space", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right", Backspace: "Backspace", Delete: "Del" };

  function keyLabel(step) {
    const m = step.mods || {};
    const parts = [];
    if (m.ctrl) parts.push("Ctrl");
    if (m.alt) parts.push("Alt");
    if (m.shift) parts.push("Shift");
    if (m.meta) parts.push("Cmd");
    parts.push(KEY_NAMES[step.key] || (step.key.length === 1 ? step.key.toUpperCase() : step.key));
    return parts.join("+");
  }

  function tabTo(from, back) {
    const all = Array.from(document.querySelectorAll(FOCUSABLE)).filter(
      (n) => n.tabIndex >= 0 && !n.disabled && TT.isVisible(n) && !TT.HOST_TAGS.has(n.localName)
    );
    if (!all.length) return;
    let i = all.indexOf(from);
    i = i < 0 ? (back ? all.length : -1) : i;
    const next = all[(i + (back ? -1 : 1) + all.length) % all.length];
    next.focus();
  }

  function pressKey(el, step) {
    const m = step.mods || {};
    const plain = !m.ctrl && !m.meta && !m.alt;
    const allowed = fireKey("keydown", el, step.key, step.code, step.keyCode, m);
    // Ctrl+A selects all, so a following Ctrl+C copies everything.
    if (allowed && (m.ctrl || m.meta) && !m.alt && step.key.toLowerCase() === "a") {
      if ((el.localName === "input" || el.localName === "textarea") && typeof el.select === "function") el.select();
      else document.execCommand("selectAll");
    }
    if (allowed && step.key.length === 1 && plain) fireKey("keypress", el, step.key, step.code, step.keyCode, m);
    if (allowed && step.key === "Enter" && plain) fireKey("keypress", el, "Enter", step.code, 13, m);
    if (allowed && plain) {
      const tag = el.localName;
      const type = (el.type || "").toLowerCase();
      if (step.key === "Enter") {
        if (tag === "input" && el.form && !["checkbox", "radio", "button", "submit", "reset", "file"].includes(type)) {
          const form = el.form;
          const btn = form.querySelector('button:not([type]), button[type="submit"], input[type="submit"], input[type="image"]');
          if (btn && !btn.disabled) btn.click();
          else if (form.requestSubmit) form.requestSubmit();
        } else if ((tag === "a" && el.href) || tag === "button" || tag === "summary" || (tag === "input" && ["submit", "button", "reset"].includes(type))) {
          el.click();
        }
      } else if (step.key === "Tab") {
        tabTo(el, !!m.shift);
      }
    }
    fireKey("keyup", el, step.key, step.code, step.keyCode, m);
    if (allowed && plain && step.key === " ") {
      const tag = el.localName;
      const type = (el.type || "").toLowerCase();
      if (tag === "button" || tag === "summary" || (tag === "input" && ["checkbox", "radio", "submit", "button"].includes(type))) el.click();
    }
  }

  // ---------- scrolling ----------

  async function scrollTo(target, x, y, ms, cancelled) {
    const isWin = !target;
    const sx = isWin ? scrollX : target.scrollLeft;
    const sy = isWin ? scrollY : target.scrollTop;
    if (Math.abs(sx - x) < 1 && Math.abs(sy - y) < 1) return;
    await TT.animate(
      ms,
      (p) => {
        const e = TT.easeInOut(p);
        const nx = sx + (x - sx) * e;
        const ny = sy + (y - sy) * e;
        if (isWin) window.scrollTo({ left: nx, top: ny, behavior: "instant" });
        else target.scrollTo({ left: nx, top: ny, behavior: "instant" });
      },
      cancelled
    );
  }


  // ---------- playback session ----------

  let session = 0;
  let playing = false;

  async function perform(msg) {
    const my = session;
    const cancelled = () => my !== session || !playing;
    const { step, speed } = msg;
    const fast = speed === "max";
    // Fast pacing skips the recorded pauses, so the page gets time here instead:
    // wait for the element itself, up to a minute, and say what we wait for.
    // msg.wait: the worker's choice (shorter right after a recovery).
    const timeout = msg.wait || (msg.patient ? 40000 : 10000);
    const find = async (t, ms) => {
      const note = setTimeout(() => TT.send({ type: "status", text: `Waiting for ${TT.label(t)}` }).catch(() => {}), 1200);
      const el = await TT.locate(t, ms, cancelled, msg.patient && ms === timeout ? 8000 : undefined);
      clearTimeout(note);
      TT.send({ type: "status", text: "" }).catch(() => {});
      return el;
    };
    cursor.show(msg.from);
    const done = (extra = {}) => ({ ok: true, x: cursor.x, y: cursor.y, hidden: TT.hidden(), ...extra });
    // missing: the page answered but the recorded element isn't on it.
    const fail = (error, extra = {}) => ({ ok: false, error, x: cursor.x, y: cursor.y, hidden: TT.hidden(), ...extra });
    const lost = { missing: true };
    const acted = () => TT.send({ type: "acted", i: msg.i }).catch(() => {});

    switch (step.type) {
      case "click":
      case "dbl": {
        const el = await find(step.target, timeout);
        if (cancelled()) return done();
        if (!el) return fail(`couldn't find ${TT.label(step.target)}`, lost);
        inView(el);
        let p = pointIn(el, step.rx, step.ry);
        await glide(p.x, p.y, fast ? 0 : msg.lead, cancelled);
        if (cancelled()) return done();
        if (!(await waitEnabled(el, 6000))) return fail(`${TT.label(step.target)} stays disabled (the form before it isn't filled in)`, lost);
        p = pointIn(el, step.rx, step.ry);
        cursor.set(p.x, p.y);
        await acted();
        if (step.type === "dbl") {
          fireMouse("dblclick", el, p.x, p.y, { detail: 2 });
          selectWordAt(el, p.x, p.y, step);
        } else {
          clickSequence(el, p.x, p.y, step.detail || 1, step.mods);
        }
        cursor.ripple();
        return done();
      }
      case "input": {
        const el = await find(step.target, timeout);
        if (cancelled()) return done();
        if (!el) return fail(`couldn't find ${TT.label(step.target)}`, lost);
        inView(el);
        const p = pointIn(el, 0.5, 0.5);
        if (step.kind !== "check") await glide(Math.min(p.x, el.getBoundingClientRect().left + 24), p.y, fast ? 0 : msg.lead, cancelled);
        if (cancelled()) return done();
        await acted();
        const ms = fast ? 0 : Math.min((step.dur || 0) / speed, 30000);
        await fillInput(el, step, ms, cancelled);
        return done();
      }
      case "key": {
        let el = null;
        if (step.target) el = await find(step.target, 3000);
        if (cancelled()) return done();
        if (!el) el = document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body;
        else if (document.activeElement !== el && typeof el.focus === "function") el.focus({ preventScroll: true });
        if (!fast) await TT.sleep(msg.lead);
        await acted();
        cursor.showKey(keyLabel(step));
        pressKey(el, step);
        return done();
      }
      case "scroll": {
        let target = null;
        if (step.target) {
          target = await find(step.target, 3000);
          if (!target) return done();
        }
        const ms = fast ? 0 : TT.clamp((step.dur || 0) / speed, 180, 900);
        await scrollTo(target, step.x, step.y, ms, cancelled);
        return done();
      }
      case "path":
        return done(); // old tapes: recorded mouse wiggles are not replayed
      case "hover": {
        // Mouse over the element that opens a menu, and give the menu a moment.
        const el = await find(step.target, timeout);
        if (cancelled()) return done();
        if (!el) return fail(`couldn't find ${TT.label(step.target)} to point at`, lost);
        inView(el);
        const p = pointIn(el, 0.5, 0.5);
        await glide(p.x, p.y, fast ? 0 : msg.lead, cancelled);
        if (cancelled()) return done();
        await acted();
        cursor.set(p.x, p.y);
        hover(p.x, p.y, el);
        await new Promise((r) => setTimeout(r, 350));
        return done();
      }
      case "rclick": {
        const el = await find(step.target, timeout);
        if (cancelled()) return done();
        if (!el) return fail(`couldn't find ${TT.label(step.target)} to right-click`, lost);
        inView(el);
        const p = pointIn(el, step.rx, step.ry);
        await glide(p.x, p.y, fast ? 0 : msg.lead, cancelled);
        if (cancelled()) return done();
        await acted();
        // Right-click without touching the selection, so a highlighted word stays.
        const extra = { button: 2 };
        hover(p.x, p.y, el);
        if (fireMouse("pointerdown", el, p.x, p.y, extra)) fireMouse("mousedown", el, p.x, p.y, extra);
        fireMouse("pointerup", el, p.x, p.y, extra);
        fireMouse("mouseup", el, p.x, p.y, extra);
        fireMouse("contextmenu", el, p.x, p.y, extra);
        cursor.ripple();
        return done();
      }
      case "copy": {
        // Like Ctrl+C: take what is selected right now. No search, no mouse move.
        let text = liveSelection();
        if (!text) {
          // Nothing selected (for example a copy made from the menu on a field):
          // take the text from the recorded element instead.
          const el = await find(step.target, 4000);
          if (cancelled()) return done();
          if (!el) return fail(`couldn't find the text to copy (${TT.label(step.target)})`, lost);
          text = copyFrom(el, step);
        }
        await acted();
        cursor.showKey("Ctrl+C");
        return done({ copied: text });
      }
      case "paste": {
        let el = await find(step.target, timeout);
        if (cancelled()) return done();
        if (!el) return fail(`couldn't find ${TT.label(step.target)} to paste into`, lost);
        if (el.isContentEditable) el = TT.editableRoot(el);
        inView(el);
        const r = el.getBoundingClientRect();
        const p = pointIn(el, 0.5, 0.5);
        await glide(Math.min(p.x, r.left + 24), p.y, fast ? 0 : msg.lead, cancelled);
        if (cancelled()) return done();
        await acted();
        const text = typeof msg.clip === "string" ? msg.clip : step.text || "";
        cursor.showKey("Paste");
        if (msg.native) {
          // The worker pastes for real (trusted Ctrl+V). Just put focus in place.
          if (document.activeElement !== el && typeof el.focus === "function") el.focus({ preventScroll: true });
          document.dispatchEvent(new CustomEvent("tinytab:clip", { detail: text }));
          return done({ nativeReady: document.activeElement === el || el.contains(document.activeElement) });
        }
        pasteInto(el, text);
        return done();
      }
    }
    return done();
  }

  TT.player = {
    begin(settings) {
      if (!playing) session++;
      playing = true;
      cursor.show();
      if (settings && settings.shield) shield.mount();
      else shield.unmount();
    },
    end() {
      if (!playing && !cursor.host && !shield.host) return;
      playing = false;
      session++;
      hoverEl = null;
      cursor.hide();
      shield.unmount();
    },
    perform: (msg) => {
      if (!playing) TT.player.begin(msg.settings);
      return perform(msg).catch((e) => ({ ok: false, error: String((e && e.message) || e) }));
    },
    // What a paste target holds now: its value, or for code boxes (one box per
    // digit, the paste spread over them) all the boxes' values together.
    // null when the box isn't on the page (the site moved on).
    fieldText: async (t) => {
      const el = await TT.locate(t, 1500, null, Infinity);
      if (!el) return null;
      if (el.isContentEditable) return TT.editableRoot(el).innerText;
      if (!("value" in el)) return el.textContent || "";
      let box = el.parentElement;
      for (let d = 0; box && d < 3; d++, box = box.parentElement) {
        const all = box.querySelectorAll("input");
        if (all.length >= 2) return Array.from(all, (n) => n.value).join("");
      }
      return String(el.value);
    },
    // Which recorded elements are on the page right now, without waiting.
    // The screen position is not trusted here: any page has something there.
    // sure[i]: target i is far from where playback was; count it only when it
    // is clearly the recorded element (see TT.findSure).
    probe: (targets, sure = []) =>
      Promise.all(
        (targets || []).map((t, i) =>
          sure[i]
            ? Promise.resolve(!!TT.findSure(t))
            : TT.locate(t, 0, null, Infinity).then(
                // A disabled button is not a place to go on from: the form
                // before it needs filling in first.
                (el) => !!el && TT.isVisible(el) && (!t.text || TT.textOf(el) === t.text) && !((t.tag === "button" || t.tag === "div" || t.tag === "a") && TT.isDisabled(el)),
                () => false
              )
        )
      ),
    // Press an element the way playback does (pointer over it, then a click),
    // without the cursor's glide. For the page rules in sense.js.
    press(el) {
      if (!el || !el.isConnected) return;
      inView(el);
      const p = pointIn(el, 0.5, 0.5);
      cursor.set(p.x, p.y);
      clickSequence(el, p.x, p.y, 1);
      cursor.ripple();
    },
    // Press a key (Escape closes most popups) on whatever has the focus.
    key(key, code, keyCode) {
      const el = document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body;
      pressKey(el, { key, code, keyCode, mods: {} });
    },
    teardown() {
      TT.player.end();
      cursor.unmount();
    },
  };
})();
