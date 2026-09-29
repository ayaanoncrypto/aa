// A hidden extension page. The service worker has no page of its own, so it
// asks this one to put text on the computer's clipboard, the way Ctrl+C does.
// This works whichever tab or window has focus.
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (!msg || msg.target !== "offscreen" || msg.type !== "write") return;
  const box = document.getElementById("t");
  box.value = String(msg.text);
  box.focus();
  box.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch (_) {}
  box.value = "";
  reply(ok);
});
