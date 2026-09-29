// AI services the AI check knows, and how to tell them from an API key.
// Shared by the service worker (ai.js) and the options page.
// Jev speaks TypeSafe's System One API (baseUrl + "/v1/systemone"); the
// others the OpenAI-style chat API (baseUrl + "/chat/completions").
self.AI_PROVIDERS = {
  jev: { name: "TypeSafe Jev", baseUrl: "https://api.typesafe.ai", model: "jev-latest", screenshot: false },
  deepseek: { name: "DeepSeek", baseUrl: "https://api.deepseek.com", model: "deepseek-chat", screenshot: false },
  gemini: { name: "Google Gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", model: "gemini-flash-latest", screenshot: true },
  openai: { name: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", screenshot: true },
};

// The service a key belongs to, from how it starts. Jev when unsure.
self.aiProviderOf = (key) => {
  const k = String(key || "").trim();
  if (/^AIza/.test(k)) return "gemini";
  if (/^sk-(proj|svcacct|admin)-/.test(k)) return "openai";
  if (/^sk-[0-9a-f]{32}$/.test(k)) return "deepseek";
  return "jev";
};
