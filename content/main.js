// Boots TinyTab in the page and routes messages from the service worker.
// Stays dormant (one message at load) until the tab is switched on.
(() => {
  if (globalThis.__tinytabBooted) return;
  const TT = globalThis.TinyTab;

  // An older copy of TinyTab (from before an extension update) may still be in the page.
  document.dispatchEvent(new CustomEvent("tinytab:reboot"));
  for (const tag of TT.HOST_TAGS) document.querySelectorAll(tag).forEach((n) => n.remove());

  globalThis.__tinytabBooted = true;

  let current = null;
  let dead = false;

  function apply(s) {
    if (dead || !s) return;
    current = s;
    if (!s.on) {
      TT.recorder.stop();
      TT.player.end();
      TT.sense.unwatch();
      TT.deck.hide();
      return;
    }
    TT.deck.show(s);
    if (s.mode === "recording") TT.recorder.start(s.settings);
    else TT.recorder.stop();
    if (s.mode === "playing") {
      TT.player.begin(s.settings);
      TT.sense.watch();
    } else {
      TT.player.end();
      TT.sense.unwatch();
    }
  }

  function teardown() {
    if (dead) return;
    dead = true;
    TT.recorder.stop();
    TT.player.teardown();
    TT.sense.unwatch();
    TT.deck.hide();
    try {
      chrome.runtime.onMessage.removeListener(onMessage);
    } catch (_) {}
    document.removeEventListener("tinytab:reboot", teardown);
    document.removeEventListener("tinytab:copied", onCopied);
  }
  TT.orphaned = () => {
    if (!chrome.runtime || !chrome.runtime.id) teardown();
  };
  document.addEventListener("tinytab:reboot", teardown);

  function onMessage(msg, _sender, reply) {
    if (dead) return;
    switch (msg && msg.type) {
      case "ping":
        reply({ ok: true });
        return;
      case "state":
        apply(msg.state);
        return;
      case "tick":
        TT.deck.tick(msg.kind);
        return;
      case "progress":
        TT.deck.progress(msg.index, msg.eta, msg.run);
        return;
      case "done":
        TT.deck.done(msg.index);
        return;
      case "clip":
        // TinyTab's clipboard changed (or playback ended): tell the page helper.
        document.dispatchEvent(new CustomEvent("tinytab:clip", { detail: typeof msg.text === "string" ? msg.text : null }));
        return;
      case "status":
        TT.deck.status(msg.text);
        return;
      case "warn":
        TT.deck.message(msg.text, "warn", 4000);
        return;
      case "perform":
        TT.player.perform(msg).then(reply);
        return true;
      case "probe":
        TT.player.probe(msg.targets, msg.sure).then((found) => reply({ ok: true, found }));
        return true;
      case "fieldText":
        TT.player.fieldText(msg.target).then((text) => reply({ ok: true, text }), () => reply({ ok: true, text: null }));
        return true;
        return;
      case "signout":
        TT.sense.signOut().then((r) => reply({ ok: true, ...r }), (e) => reply({ ok: false, error: String(e) }));
        return true;
      case "unblock":
        TT.sense.unblock().then((done) => reply({ ok: true, done }), () => reply({ ok: true, done: [] }));
        return true;
      case "snapshot":
        try {
          reply({ ok: true, snap: TT.sense.snapshot() });
        } catch (e) {
          reply({ ok: false, error: String(e) });
        }
        return;
      case "abort":
        TT.player.abort();
        reply({ ok: true });
        return;
      case "clearSession":
        // Tab-only storage survives a reload; clearing site data doesn't reach it.
        try {
          sessionStorage.clear();
        } catch (_) {}
        reply({ ok: true });
        return;
    }
  }
  chrome.runtime.onMessage.addListener(onMessage);

  // Text a site's own Copy button copied (reported by clipboard-main.js).
  function onCopied(e) {
    if (dead || !current || !current.on || current.mode === "idle") return;
    if (typeof e.detail === "string" && e.detail) TT.send({ type: "copied", text: e.detail }).catch(() => {});
  }
  document.addEventListener("tinytab:copied", onCopied);

  // TinyTab's own errors on this page go to its log (the page's errors don't).
  const mine = (s) => typeof s === "string" && s.includes(chrome.runtime.getURL(""));
  const report = (text) => !dead && TT.send({ type: "log", text }).catch(() => {});
  window.addEventListener("error", (e) => {
    if (mine(e.filename) || mine(e.error && e.error.stack)) report(`${e.message} (${String(e.filename || "").split("/").pop()}:${e.lineno})`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    if (r && mine(r.stack)) report(String(r.stack).slice(0, 500));
  });

  function hello() {
    TT.send({ type: "hello", url: location.href }).then(apply, () => TT.orphaned());
  }
  hello();

  // Pages restored from the back/forward cache don't re-run scripts; say hello again.
  window.addEventListener("pageshow", (e) => {
    if (e.persisted && !dead) hello();
  });
})();
