// Shared helpers for the TinyTab content scripts.
// Every file checks the boot flag so a second injection into the same page is a no-op.
(() => {
  if (globalThis.__tinytabBooted) return;
  const TT = (globalThis.TinyTab = {});

  TT.HOST_TAGS = new Set(["tinytab-deck", "tinytab-cursor", "tinytab-shield"]);

  // True when the event came from TinyTab's own UI.
  TT.isOwnEvent = (e) => {
    const path = e.composedPath ? e.composedPath() : [];
    for (const n of path) if (n && n.nodeType === 1 && TT.HOST_TAGS.has(n.localName)) return true;
    return false;
  };

  TT.clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  TT.hidden = () => document.visibilityState === "hidden";

  // One animation frame. Falls back to a short timer when frames stop (hidden or occluded tab).
  TT.frame = () =>
    new Promise((resolve) => {
      if (TT.hidden()) return resolve(performance.now());
      let done = false;
      const fin = (t) => {
        if (done) return;
        done = true;
        resolve(t || performance.now());
      };
      requestAnimationFrame(fin);
      setTimeout(fin, 40);
    });

  TT.sleep = (ms) => new Promise((r) => (ms > 0 && !TT.hidden() ? setTimeout(r, ms) : r()));

  // Runs fn(progress 0..1) across `ms`, frame by frame. Jumps to the end when the tab is hidden.
  TT.animate = async (ms, fn, isCancelled) => {
    if (!(ms > 16) || TT.hidden()) {
      fn(1);
      return;
    }
    const start = performance.now();
    for (;;) {
      const now = await TT.frame();
      if (isCancelled && isCancelled()) return;
      const p = Math.min(1, (now - start) / ms);
      fn(p);
      if (p >= 1 || TT.hidden()) {
        if (p < 1) fn(1);
        return;
      }
    }
  };

  TT.easeInOut = (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

  TT.isTextField = (el) => {
    if (!el || el.nodeType !== 1) return false;
    if (el.isContentEditable) return true;
    if (el.localName === "textarea") return true;
    if (el.localName !== "input") return false;
    const t = (el.type || "text").toLowerCase();
    return ["text", "search", "email", "url", "tel", "password", "number", ""].includes(t);
  };

  TT.editableRoot = (el) => {
    if (!el || !el.isContentEditable) return el;
    let n = el;
    while (n.parentElement && n.parentElement.isContentEditable) n = n.parentElement;
    return n;
  };

  // Deepest real target of an event, looking through open shadow roots.
  TT.realTarget = (e) => {
    const path = e.composedPath ? e.composedPath() : [];
    for (const n of path) if (n && n.nodeType === 1) return n;
    return e.target && e.target.nodeType === 1 ? e.target : null;
  };

  // F5, Ctrl+R, Ctrl+Shift+R, Ctrl+F5 (Cmd on a Mac): the browser reloads the page.
  TT.isReloadKey = (key, m = {}) => {
    const k = String(key || "");
    if (m.alt) return false;
    if (k === "F5") return true;
    return (k === "r" || k === "R") && !!(m.ctrl || m.meta);
  };

  // A click on an icon lands on a part of it (<use>, <path>, <rect>). Record the
  // whole icon instead: the part has no name, and the same parts sit in every
  // icon on the page, so only the icon's name (TT.iconOf) tells them apart.
  TT.clickTarget = (el) => {
    if (!el || typeof SVGElement === "undefined" || !(el instanceof SVGElement)) return el;
    let svg = el.localName === "svg" ? el : el.closest("svg");
    for (let up = svg && svg.parentElement && svg.parentElement.closest("svg"); up; up = up.parentElement && up.parentElement.closest("svg")) svg = up;
    return svg || el;
  };

  // The name of the icon an <svg> (or its <use>) draws: "#icon-user" for
  // <svg><use href="#icon-user"></svg>, the way icon sprites work. "" if none.
  TT.iconOf = (el) => {
    if (!el || !el.querySelector) return "";
    const use = el.localName === "use" ? el : el.querySelector("use");
    const v = use ? use.getAttribute("href") || use.getAttribute("xlink:href") || "" : "";
    return v.length < 120 ? v : "";
  };

  // A control that can't be used yet: the disabled attribute, aria-disabled, a
  // "…-disabled" class (sites draw their own buttons, like Bitrue's
  // "register-disabled" Next), or a not-allowed cursor. Checks the element and
  // two boxes around it (the label inside a disabled button).
  const DISABLED_CLASS = /(^|[-_])disabled($|[-_])/i;
  TT.isDisabled = (el) => {
    for (let n = el, d = 0; n && n.nodeType === 1 && d < 3; n = n.parentElement, d++) {
      if (n.disabled === true || n.getAttribute("aria-disabled") === "true") return true;
      const cls = typeof n.className === "string" ? n.className : "";
      if (cls && cls.split(/\s+/).some((c) => DISABLED_CLASS.test(c))) return true;
    }
    try {
      return getComputedStyle(el).cursor === "not-allowed";
    } catch (_) {
      return false;
    }
  };

  TT.isVisible = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none";
  };

  TT.send = (msg) => {
    try {
      if (!chrome.runtime || !chrome.runtime.id) return Promise.reject(new Error("orphaned"));
      return chrome.runtime.sendMessage(msg);
    } catch (e) {
      return Promise.reject(e);
    }
  };
})();
