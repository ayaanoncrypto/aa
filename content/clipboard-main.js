// Runs in the page's own world (not the isolated one) so it can see what a
// site's Copy button puts on the clipboard. It only reports the text to
// TinyTab's content script; TinyTab decides whether to use it.
(() => {
  // Versioned: a newer TinyTab replaces the helper an older one left in the page.
  const VERSION = 3;
  if (typeof window.__tinytabClipHook === "number" && window.__tinytabClipHook >= VERSION) return;
  window.__tinytabClipHook = VERSION;

  let setText = null; // text a copy handler set with clipboardData.setData
  const report = (text) => {
    if (typeof text !== "string" || !text) return;
    document.dispatchEvent(new CustomEvent("tinytab:copied", { detail: text.slice(0, 100000) }));
  };

  // navigator.clipboard.writeText / write: capture the text even if the call is refused.
  const clip = navigator.clipboard;
  if (clip) {
    const proto = Object.getPrototypeOf(clip);
    const writeText = proto.writeText;
    if (writeText) {
      proto.writeText = function (text) {
        report(String(text));
        return writeText.apply(this, arguments);
      };
    }
    const write = proto.write;
    if (write) {
      proto.write = function (items) {
        try {
          for (const item of items || []) {
            if (item.types && item.types.includes("text/plain")) item.getType("text/plain").then((b) => b.text()).then(report, () => {});
          }
        } catch (_) {}
        return write.apply(this, arguments);
      };
    }
  }

  // During a replayed paste, a site that reads the clipboard itself (common in
  // code boxes) must get TinyTab's text, not whatever the computer's clipboard holds.
  let pending = null;
  let pendingAt = 0;
  // TinyTab sends its clipboard when a replayed copy happens, and null when playback ends.
  document.addEventListener("tinytab:clip", (e) => {
    if (e.detail === null) pending = null;
    else if (typeof e.detail === "string") pending = e.detail;
    pendingAt = Date.now();
  });
  const fresh = () => pending != null && Date.now() - pendingAt < 30 * 60 * 1000;
  if (clip) {
    const proto = Object.getPrototypeOf(clip);
    const readText = proto.readText;
    if (readText) {
      proto.readText = function () {
        return fresh() ? Promise.resolve(pending) : readText.apply(this, arguments);
      };
    }
    const read = proto.read;
    if (read && typeof ClipboardItem === "function") {
      proto.read = function () {
        if (!fresh()) return read.apply(this, arguments);
        return Promise.resolve([new ClipboardItem({ "text/plain": new Blob([pending], { type: "text/plain" }) })]);
      };
    }
  }

  // What is selected right now: the selected part of a focused field, or page text.
  const selectedText = () => {
    const a = document.activeElement;
    if (a && (a.localName === "input" || a.localName === "textarea") && typeof a.selectionStart === "number") {
      try {
        return a.value.slice(a.selectionStart, a.selectionEnd);
      } catch (_) {}
    }
    const sel = document.getSelection();
    return sel ? sel.toString() : "";
  };

  // Copy buttons in the style of clipboard.js: put the text in a hidden box, select
  // it, run execCommand("copy"), delete the box. Read the selection at that moment.
  // Chrome refuses the command for a replayed click, so no copy event fires then.
  let inExec = false;
  const exec = Document.prototype.execCommand;
  Document.prototype.execCommand = function (cmd) {
    const c = String(cmd || "").toLowerCase();
    if ((c === "copy" || c === "cut") && !inExec) {
      const text = selectedText();
      inExec = true;
      setText = null;
      try {
        const out = exec.apply(this, arguments);
        report(setText != null ? setText : text);
        return out;
      } finally {
        inExec = false;
      }
    }
    return exec.apply(this, arguments);
  };

  // Older copy buttons: a copy event where the page sets the data, or copies a selection.
  const setData = DataTransfer.prototype.setData;
  DataTransfer.prototype.setData = function (type, value) {
    if (/^text(\/plain)?$/i.test(type)) setText = String(value);
    return setData.apply(this, arguments);
  };
  const onCopy = () => {
    if (inExec) return; // execCommand reports it
    setText = null;
    // Read the selection now; the page may remove it right after.
    const text = selectedText();
    setTimeout(() => report(setText != null ? setText : text), 0);
  };
  window.addEventListener("copy", onCopy, true);
  window.addEventListener("cut", onCopy, true);
})();
