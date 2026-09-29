// Describes an element when recording, and finds it again when playing.
// A description holds several independent ways back to the element, tried in order.
(() => {
  if (globalThis.__tinytabBooted) return;
  const TT = globalThis.TinyTab;

  const ATTRS = ["data-testid", "data-test", "data-test-id", "data-qa", "data-cy", "name", "aria-label", "placeholder", "title", "alt", "for"];
  const TEXT_TAGS = new Set(["a", "button", "label", "summary", "option", "li", "td", "th", "span", "div", "p", "h1", "h2", "h3", "h4", "h5", "h6", "img"]);

  const esc = (s) => CSS.escape(s);
  const attrSel = (name, value) => `[${name}="${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;

  function stableId(id) {
    if (!id || id.length > 60) return false;
    if (/^\d/.test(id) || id.startsWith(":")) return false;
    if (/\d{4,}/.test(id)) return false;
    if (/[0-9a-f]{8}-?[0-9a-f]{4}/i.test(id)) return false;
    if (/^(ember|react|radix|headlessui|mui|rc_|jsx-|__)/i.test(id)) return false;
    return true;
  }

  function stableValue(v) {
    return v && v.length <= 80 && !/[0-9a-f]{12,}/i.test(v);
  }

  const unique = (root, sel) => {
    try {
      return root.querySelectorAll(sel).length === 1;
    } catch (_) {
      return false;
    }
  };

  function textOf(el) {
    const raw = el.localName === "input" ? el.value : el.innerText || el.textContent || "";
    return raw.replace(/\s+/g, " ").trim().slice(0, 80);
  }

  // A selector that matches only `el` inside `root` (a document or a shadow root).
  function selectorIn(el, root) {
    const tag = el.localName;
    if (el.id && stableId(el.id) && unique(root, "#" + esc(el.id))) return "#" + esc(el.id);
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (!stableValue(v)) continue;
      const sel = tag + attrSel(a, v);
      if (unique(root, sel)) return sel;
    }
    if (tag === "a") {
      const href = el.getAttribute("href");
      if (href && href.length < 120 && !href.startsWith("javascript:")) {
        const sel = "a" + attrSel("href", href);
        if (unique(root, sel)) return sel;
      }
    }
    if (tag === "input" && el.type && el.name) {
      const sel = `input[type="${el.type}"]${attrSel("name", el.name)}${el.type === "radio" || el.type === "checkbox" ? attrSel("value", el.value) : ""}`;
      if (unique(root, sel)) return sel;
    }
    // Walk up, adding :nth-of-type until the path is unique.
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== root) {
      let part = node.localName;
      if (node !== el && node.id && stableId(node.id) && unique(root, "#" + esc(node.id))) {
        parts.unshift("#" + esc(node.id));
        break;
      }
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.localName === node.localName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      const sel = parts.join(" > ");
      if (unique(root, sel)) return sel;
      node = parent;
      if (!node && parts.length) break;
    }
    return parts.join(" > ");
  }

  // Full position path, used as a fallback when the selectors above break.
  function nthPath(el, root) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== root) {
      const parent = node.parentElement;
      const idx = parent ? Array.from(parent.children).indexOf(node) + 1 : 1;
      parts.unshift(`${node.localName}:nth-child(${idx})`);
      node = parent;
    }
    return parts.join(" > ");
  }

  TT.describe = (el) => {
    const chain = [];
    const paths = [];
    let node = el;
    // Walk out through open shadow roots, one selector per root.
    for (let guard = 0; node && guard < 12; guard++) {
      const root = node.getRootNode();
      chain.unshift(selectorIn(node, root));
      paths.unshift(nthPath(node, root));
      if (root instanceof ShadowRoot) node = root.host;
      else break;
    }
    const r = el.getBoundingClientRect();
    const attrs = {};
    for (const a of ["id", "name", "type", "role", "placeholder", "aria-label", "data-testid", "title", "href", "value"]) {
      const v = el.getAttribute(a);
      if (v && v.length < 200 && !(a === "value" && el.localName === "input" && TT.isTextField(el))) attrs[a] = v;
    }
    const icon = el.localName === "svg" || el.localName === "use" ? TT.iconOf(el) : "";
    if (icon) attrs.icon = icon;
    return {
      chain,
      paths,
      tag: el.localName,
      text: TEXT_TAGS.has(el.localName) || el.getAttribute("role") === "button" ? textOf(el) : "",
      attrs,
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  };

  // The icon with the recorded name (see TT.iconOf): the visible one nearest
  // the recorded spot, else the only one.
  function byIcon(t) {
    const icon = t.attrs && t.attrs.icon;
    if (!icon) return null;
    const list = [];
    for (const use of document.querySelectorAll("use")) {
      if ((use.getAttribute("href") || use.getAttribute("xlink:href")) !== icon) continue;
      const el = t.tag === "use" ? use : TT.clickTarget(use);
      if (el && el.localName === t.tag && !list.includes(el)) list.push(el);
    }
    const vis = list.filter(TT.isVisible);
    if (!vis.length) return list.length === 1 ? list[0] : null;
    let best = vis[0];
    let bestDist = Infinity;
    for (const n of vis) {
      const r = n.getBoundingClientRect();
      const d = t.x == null ? 0 : Math.hypot(r.left + r.width / 2 - t.x, r.top + r.height / 2 - t.y);
      if (d < bestDist) {
        best = n;
        bestDist = d;
      }
    }
    return best;
  }

  function byChain(chain) {
    let root = document;
    let el = null;
    for (let i = 0; i < chain.length; i++) {
      try {
        el = root.querySelector(chain[i]);
      } catch (_) {
        return null;
      }
      if (!el) return null;
      if (i < chain.length - 1) {
        root = el.shadowRoot;
        if (!root) return null;
      }
    }
    return el;
  }

  function byAttrs(t) {
    const a = t.attrs || {};
    if (t.chain && t.chain.length > 1) return null;
    const tries = [];
    if (a.id) tries.push("#" + esc(a.id));
    if (a["data-testid"]) tries.push(t.tag + attrSel("data-testid", a["data-testid"]));
    if (a.name) tries.push(t.tag + attrSel("name", a.name) + (a.type ? attrSel("type", a.type) : ""));
    if (a["aria-label"]) tries.push(t.tag + attrSel("aria-label", a["aria-label"]));
    if (a.placeholder) tries.push(t.tag + attrSel("placeholder", a.placeholder));
    if (a.href && t.tag === "a") tries.push("a" + attrSel("href", a.href));
    if (a.icon) {
      const el = byIcon(t);
      if (el) return el;
    }
    for (const sel of tries) {
      try {
        const list = Array.from(document.querySelectorAll(sel)).filter((n) => n.localName === t.tag);
        const vis = list.filter(TT.isVisible);
        if (vis.length === 1) return vis[0];
        if (list.length === 1) return list[0];
      } catch (_) {}
    }
    return null;
  }

  function byText(t) {
    if (!t.text || (t.chain && t.chain.length > 1)) return null;
    let list;
    try {
      list = document.querySelectorAll(t.tag);
    } catch (_) {
      return null;
    }
    if (list.length > 3000) return null;
    let best = null;
    let bestDist = Infinity;
    for (const n of list) {
      if (textOf(n) !== t.text || !TT.isVisible(n)) continue;
      const r = n.getBoundingClientRect();
      const d = Math.hypot(r.left + r.width / 2 - t.x, r.top + r.height / 2 - t.y);
      if (d < bestDist) {
        best = n;
        bestDist = d;
      }
    }
    return best;
  }

  // The element with the recorded text: the visible one nearest the recorded
  // spot, else the one hidden one (items of a menu that opens on hover stay in
  // the page, hidden). Nested boxes share their text; the innermost counts.
  function byTextAny(t) {
    const vis = byText(t);
    if (vis || !t.text || (t.chain && t.chain.length > 1)) return vis;
    let list;
    try {
      list = Array.from(document.querySelectorAll(t.tag));
    } catch (_) {
      return null;
    }
    if (list.length > 3000) return null;
    const same = list.filter((n) => textOf(n) === t.text);
    const inner = same.filter((n) => !same.some((m) => m !== n && n.contains(m)));
    return inner.length === 1 ? inner[0] : null;
  }

  function byPoint(t) {
    if (t.x == null || t.x < 0 || t.y < 0 || t.x > innerWidth || t.y > innerHeight) return null;
    const hit = TT.elementAt(t.x, t.y);
    if (!hit) return null;
    const el = hit.localName === t.tag ? hit : hit.closest && hit.closest(t.tag);
    // Whatever sits at that spot now is only it if it says the same.
    return same(el, t) ? el : null;
  }

  // late: the page has had its time; weaker matches count from then on.
  // Says what was recorded: the same text, for an icon the same icon name, and
  // for a text box the same kind and hint. A "first <input>" path recorded on a
  // code box (type tel, no placeholder) must not land on the E-mail box.
  // The same kind of thing: tag, icon name, and for a text box its type and hint.
  const sameShape = (el, t) => {
    if (!el || el.localName !== t.tag) return false;
    const a = t.attrs || {};
    if (a.icon && TT.iconOf(el) !== a.icon) return false;
    if (t.tag === "input" || t.tag === "textarea") {
      const kind = (v) => String(v || "text").toLowerCase();
      if (a.type && kind(el.getAttribute("type")) !== kind(a.type)) return false;
      if ((el.getAttribute("placeholder") || "") !== (a.placeholder || "")) return false;
    }
    return true;
  };
  const same = (el, t) => sameShape(el, t) && (!t.text || textOf(el) === t.text);

  // A path by position ("the first <input> in its box") matches many elements;
  // the browser hands back the first. Look at all of them for the one that is
  // the same kind as recorded (the first code box, not a hidden search field):
  // the visible one nearest the recorded spot.
  function byChainAll(t) {
    const chain = t.chain || [];
    if (chain.length !== 1) return null;
    let list;
    try {
      list = Array.from(document.querySelectorAll(chain[0])).filter((n) => same(n, t));
    } catch (_) {
      return null;
    }
    const vis = list.filter(TT.isVisible);
    if (!vis.length) return list.length === 1 ? list[0] : null;
    let best = vis[0];
    let bestDist = Infinity;
    for (const n of vis) {
      const r = n.getBoundingClientRect();
      const d = t.x == null ? 0 : Math.hypot(r.left + r.width / 2 - t.x, r.top + r.height / 2 - t.y);
      if (d < bestDist) {
        best = n;
        bestDist = d;
      }
    }
    return best;
  }

  function findOnce(t, late) {
    let el = byChain(t.chain || []);
    let moved = null; // the recorded path's element, now saying something else
    if (el && el.localName === t.tag) {
      // A path by position can land on a neighbour (the next menu item, the
      // next icon). When the recorded text or icon is elsewhere, that is it.
      if (same(el, t)) return el;
      const other = byTextAny(t) || byIcon(t) || byChainAll(t);
      if (other) return other;
      // Only its text changed ("Copy" now says "Copied"): usable later. A box
      // of another kind (the E-mail box for a code box) never is.
      if (sameShape(el, t)) moved = el;
    }
    el = byChain(t.paths || []);
    if (same(el, t)) return el;
    // byTextAny: also the one hidden element with that text, like the item of
    // a menu that only shows while the mouse is over it (CSS :hover).
    el = byAttrs(t) || byText(t) || byTextAny(t) || byChainAll(t);
    if (el) return el;
    if (!late) return null;
    // Given time, the recorded path wins even when its text changed
    // (a button that now says "Copied"), then the recorded screen spot.
    return moved || byPoint(t);
  }

  // Resolves on the next DOM change or after `ms`, whichever comes first.
  function waitChange(ms) {
    return new Promise((resolve) => {
      const mo = new MutationObserver(() => fin());
      const timer = setTimeout(() => fin(), ms);
      function fin() {
        clearTimeout(timer);
        mo.disconnect();
        resolve();
      }
      mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    });
  }

  // Finds the recorded element, waiting up to `timeout` ms for it to appear.
  // `pointAfter`: how long to wait before trusting the recorded screen position.
  TT.locate = async (t, timeout = 10000, isCancelled, pointAfter) => {
    if (!t) return null;
    const start = performance.now();
    const pointAt = pointAfter != null ? pointAfter : Math.min(1500, timeout / 2);
    for (let round = 0; ; round++) {
      const late = performance.now() - start > pointAt;
      const el = findOnce(t, late);
      if (el) return el;
      if (performance.now() - start >= timeout || (isCancelled && isCancelled())) return null;
      await waitChange(round < 5 ? 60 : 250);
    }
  };

  TT.textOf = textOf;

  // For finding the place after trouble, far from where playback was: only an
  // element that is clearly the recorded one (its id or attributes, or its
  // exact text). Never a position: any page has some first <input> or third
  // <div>. Hidden counts, like the items of a menu that opens on hover.
  TT.findSure = (t) => {
    if (!t) return null;
    const chain = t.chain || [];
    const named = chain.length > 0 && /[#[]/.test(chain[chain.length - 1]);
    const el = byChain(chain);
    // An icon counts by its name (byAttrs finds it); text by the text.
    if (same(el, t) && (t.text || named)) return el;
    return byAttrs(t) || byTextAny(t);
  };

  // Element under a viewport point, ignoring TinyTab's own overlays.
  TT.elementAt = (x, y) => {
    const shield = TT.shieldEl && TT.shieldEl();
    const prev = shield ? shield.style.pointerEvents : "";
    if (shield) shield.style.pointerEvents = "none";
    let el = document.elementFromPoint(x, y);
    if (shield) shield.style.pointerEvents = prev;
    while (el && el.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    if (el && TT.HOST_TAGS.has(el.localName)) return null;
    return el;
  };

  TT.label = (t) => {
    if (!t) return "element";
    const name = t.text || (t.attrs && (t.attrs["aria-label"] || t.attrs.placeholder || t.attrs.name || t.attrs.title)) || "";
    const kind = { a: "link", button: "button", input: "field", textarea: "text box", select: "menu", img: "image" }[t.tag] || t.tag;
    return name ? `the "${name.slice(0, 40)}" ${kind}` : `a ${kind}`;
  };
})();
