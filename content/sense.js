// Page sense: rules that read any page, with no knowledge of particular sites.
//   signOut()  find and press a log out / sign out / disconnect control,
//              opening an account, profile or wallet menu to reach it.
//   unblock()  close a popup, dialog or cookie banner that covers the page.
// Rules only: nothing leaves the computer.
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

  TT.sense = { signOut, unblock, signOutControls, menuOpeners, SIGN_OUT };
})();
