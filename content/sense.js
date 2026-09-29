// Page sense: rules that read any page, with no knowledge of particular sites.
//   signOut()  find and press a log out / sign out / disconnect control,
//              opening an account, profile or wallet menu to reach it.
//   unblock()  close a popup, dialog or cookie banner that covers the page.
//   snapshot() the page in words, for the AI check in the service worker.
// Rules only: nothing leaves the computer from here. The service worker sends
// a snapshot to the AI model only when the AI check is set up and on.
(() => {
  if (globalThis.__tinytabBooted) return;
  const TT = globalThis.TinyTab;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
  // Text of a short control only: reading every big box's text is slow and useless.
  const shortText = (el) => (el.textContent && el.textContent.length <= 60 ? clean(TT.textOf(el)) : "");
  const hintOf = (el) => clean(el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("alt") || "");
  const classWord = (el) => (typeof el.className === "string" ? el.className.trim().split(/\s+/)[0] : "") || "";
  const labelOf = (el) => hintOf(el) || shortText(el) || classWord(el) || el.localName;
  const innermost = (list) => list.filter((n) => !list.some((m) => m !== n && n.contains(m)));
  // A link that goes somewhere (a real page) is not a menu to open.
  const leaves = (el) => el.localName === "a" && /^(https?:|\/)/i.test(el.getAttribute("href") || "") && !/^#/.test(el.getAttribute("href") || "");

  // ---------- signing out ----------

  // "Log out" in the languages people use most. The whole label only:
  // "Logout history" is not a log out button. Keep in step with background.js.
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
  const SIGN_OUT_HREF = /(^|[\/?#=&_-])(log-?out|sign-?out|log-?off|sign-?off)([\/?#=&_.-]|$)/i;
  const CONTROLS = 'a, button, [role="button"], [role="menuitem"], [role="option"], [onclick], li, div, span, input[type="button"], input[type="submit"]';

  // Log out controls on the page, visible ones first. Hidden ones count too:
  // the items of a menu that opens on hover stay in the page, hidden.
  function signOutControls() {
    const hits = [];
    for (const el of document.querySelectorAll(CONTROLS)) {
      if (TT.HOST_TAGS.has(el.localName) || el.closest("tinytab-deck")) continue;
      const text = el.localName === "input" ? clean(el.value) : shortText(el);
      const href = el.localName === "a" ? el.getAttribute("href") || "" : "";
      if (SIGN_OUT.test(text) || SIGN_OUT.test(hintOf(el)) || SIGN_OUT_HREF.test(href)) hits.push(el);
    }
    return innermost(hits).sort((a, b) => TT.isVisible(b) - TT.isVisible(a));
  }

  // Things near the top of the page that open an account menu: marked as
  // opening a popup, named like an account / profile / avatar / wallet, or
  // showing a wallet address (0x12…ab). Rightmost first: that's where sites put them.
  const OPENER = /(account|profile|avatar|user|my ?page|member|person|wallet|\bme\b)/i;
  function menuOpeners() {
    const out = [];
    for (const el of document.querySelectorAll('[aria-haspopup], [aria-expanded], button, [role="button"], a, img, svg, div, span')) {
      if (TT.HOST_TAGS.has(el.localName) || leaves(el) || !TT.isVisible(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.top > 220 || r.width > 320 || r.height > 120 || r.width < 8) continue;
      const cls = typeof el.className === "string" ? el.className : el.className && el.className.baseVal ? el.className.baseVal : "";
      const text = shortText(el);
      const hint = [hintOf(el), el.id, cls, TT.iconOf(el), text.slice(0, 40)].join(" ");
      const wallet = /^0x[0-9a-f]{2,}/i.test(text);
      if (wallet || el.hasAttribute("aria-haspopup") || OPENER.test(hint)) out.push({ el, x: r.right, wallet });
    }
    const els = innermost(out.map((o) => o.el));
    return out
      .filter((o) => els.includes(o.el))
      .sort((a, b) => b.wallet - a.wallet || b.x - a.x)
      .slice(0, 5)
      .map((o) => o.el);
  }

  // A "Are you sure?" dialog after pressing log out: confirm it.
  async function confirmIfAsked() {
    await sleep(700);
    for (const box of document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open]')) {
      if (!TT.isVisible(box)) continue;
      const btn = Array.from(box.querySelectorAll('button, a, [role="button"]')).find((b) => TT.isVisible(b) && (SIGN_OUT.test(shortText(b)) || /^(yes|confirm|ok|continue)$/i.test(shortText(b))));
      if (btn) {
        TT.player.press(btn);
        return labelOf(btn);
      }
    }
    return "";
  }

  async function signOut() {
    let control = signOutControls()[0] || null;
    let opened = "";
    if (!control || !TT.isVisible(control)) {
      // Not in view: it may sit in a menu that opens on a click.
      for (const opener of menuOpeners()) {
        TT.player.press(opener);
        await sleep(900);
        const seen = signOutControls().find(TT.isVisible);
        if (seen) {
          control = seen;
          opened = labelOf(opener);
          break;
        }
        TT.player.key("Escape", "Escape", 27);
        await sleep(250);
      }
    }
    if (!control) return { done: false };
    const label = labelOf(control);
    // Answer first, then press: signing out usually reloads or leaves the
    // page, which would cut the answer off.
    setTimeout(() => {
      TT.player.press(control);
      confirmIfAsked().catch(() => {});
    }, 60);
    return { done: true, label, opened };
  }

  // ---------- popups in the way ----------

  const DECLINE = /^(reject all|reject|decline( all)?|refuse( all)?|deny( all)?|only necessary|necessary only|essential only|use necessary cookies only|accept (only )?(essential|necessary)( cookies)?( only)?|continue without accepting)$/i;
  // Words that close a popup without doing anything ("Cancel" can undo work; not here).
  const CLOSE_TEXT = /^(×|✕|✖|x|close|dismiss|no thanks|no, thanks|not now|maybe later|later|skip|got it)$/i;
  const CLOSE_HINT = /(close|dismiss|关闭|閉じる|schließen|fermer|cerrar|chiudi|fechar|закрыть)/i;

  // Boxes on top of the page: a dialog, or a fixed box over a good part of the
  // screen (a newsletter popup, a cookie banner). A site's own sticky header isn't one.
  function overlays() {
    const vw = innerWidth;
    const vh = innerHeight;
    const found = new Set();
    for (const [fx, fy] of [[0.5, 0.5], [0.3, 0.3], [0.7, 0.3], [0.3, 0.7], [0.7, 0.7], [0.5, 0.93], [0.5, 0.07]]) {
      for (let n = TT.elementAt(vw * fx, vh * fy); n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
        const cs = getComputedStyle(n);
        const dialog = n.getAttribute("role") === "dialog" || n.getAttribute("role") === "alertdialog" || n.getAttribute("aria-modal") === "true" || n.localName === "dialog";
        if (!dialog && cs.position !== "fixed" && cs.position !== "sticky") continue;
        // Sitting on top: a popup stacks itself above the page (z-index). A web
        // app laid out in one fixed full-screen box doesn't; that isn't a popup.
        const onTop = dialog || (parseInt(cs.zIndex, 10) || 0) >= 10;
        const r = n.getBoundingClientRect();
        const header = r.top <= 1 && r.height < 140 && !dialog;
        if (onTop && !header && r.width * r.height > vw * vh * 0.08) found.add(n);
        break;
      }
    }
    return [...found];
  }

  async function unblock() {
    const done = [];
    for (let round = 0; round < 3; round++) {
      const boxes = overlays();
      if (!boxes.length) break;
      let acted = false;
      for (const box of boxes) {
        const btns = Array.from(box.querySelectorAll('button, a, [role="button"], span, div, i, svg')).filter((b) => TT.isVisible(b) && !leaves(b));
        const pick =
          btns.find((b) => DECLINE.test(shortText(b))) ||
          btns.find((b) => CLOSE_TEXT.test(shortText(b)) || CLOSE_HINT.test(hintOf(b)) || /(^|[-_ ])close([-_ ]|$)/i.test(typeof b.className === "string" ? b.className : ""));
        if (pick) {
          done.push(labelOf(pick));
          TT.player.press(pick);
          acted = true;
          await sleep(600);
        }
      }
      if (!acted) {
        TT.player.key("Escape", "Escape", 27);
        await sleep(400);
        if (overlays().length >= boxes.length) break;
        done.push("Esc");
      }
    }
    return done;
  }

  // ---------- what the page shows (for the AI check) ----------

  // Whether the page changes within ms (a page loading or updating does).
  // Watched only while TinyTab asks, so playback pays nothing for it.
  const ours = (n) => n.nodeType === 1 && TT.HOST_TAGS.has(n.localName);
  const theirs = (m) => !ours(m.target) && !(m.type === "childList" && [...m.addedNodes, ...m.removedNodes].every(ours));
  function changesWithin(ms) {
    return new Promise((resolve) => {
      const done = (v) => {
        clearTimeout(timer);
        mo.disconnect();
        resolve(v);
      };
      const mo = new MutationObserver((list) => {
        if (list.some(theirs)) done(true);
      });
      mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true });
      const timer = setTimeout(() => done(false), ms);
    });
  }

  const LOADERS = '[aria-busy="true"], [role="progressbar"], progress, [class*="spinner" i], [class*="loading" i], [class*="loader" i], [class*="skeleton" i]';
  const inViewport = (el) => {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
  };
  // Up to max distinct names of the elements on screen that match sel.
  // Looks at 400 elements at most: a big page has thousands.
  function onScreen(sel, name, max) {
    const out = [];
    let seen = 0;
    for (const el of document.querySelectorAll(sel)) {
      if (out.length >= max || ++seen > 400) break;
      if (!TT.isVisible(el) || !inViewport(el)) continue;
      const v = name(el);
      if (v && !out.includes(v)) out.push(v);
    }
    return out;
  }
  const controlName = (el) => (el.localName === "input" ? clean(el.value) : clean(el.innerText).slice(0, 50)) || hintOf(el);
  const fieldName = (el) => {
    const label = el.labels && el.labels[0] ? clean(el.labels[0].innerText) : "";
    const name = clean(el.getAttribute("placeholder") || el.getAttribute("aria-label") || label || el.getAttribute("name") || "").slice(0, 50);
    return `${name || "unnamed"} (${el.localName === "input" ? el.type || "text" : el.localName})`;
  };

  // ---------- task rules (background.js: codeWatch, goToGoal) ----------

  // A sign-up form's code button: "Send" while the code hasn't gone, then a
  // countdown in seconds ("90s", "Resend (58s)") once it has.
  const SEND_CODE = /^(send|send code|get code|get the code|resend|resend code|send again|get verification code|send verification code|obtain code|获取验证码|发送|发送验证码|重新发送)$/i;
  const SECONDS = /(\d{1,3})\s*(?:s|sec|secs|seconds?|秒)(?![a-z])/i;
  function codeTimer() {
    let send = "";
    let seconds = null;
    for (const el of document.querySelectorAll('button, a, [role="button"], span, div, input[type="button"]')) {
      if (el.children.length > 2 || TT.HOST_TAGS.has(el.localName)) continue;
      const raw = el.localName === "input" ? el.value : el.textContent && el.textContent.length <= 30 ? el.textContent : "";
      const text = clean(raw);
      if (!text) continue;
      const m = SECONDS.exec(text);
      if (!m && !SEND_CODE.test(text)) continue;
      if (!TT.isVisible(el)) continue;
      if (m) {
        const n = Number(m[1]);
        if (n <= 300 && (seconds == null || n < seconds)) seconds = n;
      } else if (!send && !TT.isDisabled(el)) send = text;
    }
    return { send, seconds };
  }

  // Clicks the link or button named like name ("8th Anniversary"): whole
  // name first, then one that holds the name.
  const norm = (s) => clean(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  function clickText(name) {
    const want = norm(name);
    if (!want) return { done: false };
    let best = null;
    let bestScore = 0;
    for (const el of document.querySelectorAll('a, button, [role="button"], [role="menuitem"], [role="tab"], li, span, div, img')) {
      if (TT.HOST_TAGS.has(el.localName)) continue;
      const raw = el.localName === "img" ? el.getAttribute("alt") || "" : el.textContent && el.textContent.length <= 80 ? el.textContent : "";
      const text = norm(raw) || norm(hintOf(el));
      if (!text || !text.includes(want) || !TT.isVisible(el)) continue;
      const score = (text === want ? 4 : 1) + (el.localName === "a" || el.localName === "button" || el.getAttribute("role") ? 2 : 0);
      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    }
    if (!best) return { done: false };
    const label = clean(best.localName === "img" ? best.getAttribute("alt") : best.textContent).slice(0, 60) || name;
    // Answer first, then press: the click usually leaves the page.
    setTimeout(() => TT.player.press(best), 60);
    return { done: true, label };
  }

  // The page in words: address without the query, title, the start of its
  // text, and the names of what is on screen. Never what is typed in a field.
  // watch: how long to look for changes, in ms (0: don't).
  async function snapshot(watch = 1000) {
    const changing = watch > 0 ? changesWithin(watch) : Promise.resolve(null);
    let loaders = 0;
    for (const el of document.querySelectorAll(LOADERS)) {
      if (TT.isVisible(el) && inViewport(el) && ++loaders >= 20) break;
    }
    const controls = onScreen('button, a, [role="button"], [role="tab"], [role="menuitem"], input[type="submit"], input[type="button"]', controlName, 40);
    // A log out control on screen, or a log out link anywhere (a cheap look,
    // unlike signOutControls, which reads every box on the page).
    const signOut = controls.some((c) => SIGN_OUT.test(c)) || Array.from(document.querySelectorAll("a[href]")).some((a) => SIGN_OUT_HREF.test(a.getAttribute("href")));
    const snap = {
      url: location.origin + location.pathname,
      title: clean(document.title).slice(0, 150),
      readyState: document.readyState,
      loaders,
      headings: onScreen("h1, h2, h3", (el) => clean(el.innerText).slice(0, 80), 8),
      text: clean(document.body ? document.body.innerText : "").slice(0, 1500),
      controls,
      fields: onScreen('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select', fieldName, 15),
      dialogs: onScreen('[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open]', (el) => clean(el.innerText).slice(0, 200), 3),
      signOut,
      code: codeTimer(), // the code button: "Send", or a countdown
    };
    snap.changing = await changing; // still loading or updating while watched
    return snap;
  }

  TT.sense = { signOut, unblock, signOutControls, menuOpeners, SIGN_OUT, snapshot, codeTimer, clickText };
})();
