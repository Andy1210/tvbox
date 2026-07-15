// Demo-mode bootstrap (vite --mode demo, e.g. the GitHub Pages build): patches
// window.fetch so every shell call is answered from mocks, and installs a fake
// window.tvbox bridge. Runs before React mounts (main.tsx), so
// launcher code needs no demo awareness. Not part of the production bundle -
// the conditional import in main.tsx is dead-code-eliminated there.
import { useLocaleStore } from "../lib/i18n";
import { handleApi } from "./routes";
import { installBridge } from "./bridge";

function presetLocaleFromUrl(): void {
  const lang = new URLSearchParams(window.location.search).get("lang");
  if (lang) useLocaleStore.getState().setLocale(lang); // ignored if unknown
}

function patchFetch(): void {
  const real = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("/tvbox/api/")) return real(input, init);
    const u = new URL(url, window.location.origin);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = undefined;
      }
    }
    await new Promise((r) => setTimeout(r, 60 + Math.random() * 120)); // a whiff of network latency
    const result = await handleApi(method, u.pathname, u.searchParams, body);
    return new Response(JSON.stringify(result ?? { ok: false, error: "not_mocked" }), {
      status: result === undefined ? 404 : 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

const STYLES = `
.demo-badge{position:fixed;right:1.2vw;bottom:1.8vh;z-index:60;display:flex;align-items:center;gap:1vw;padding:.9vh 1.4vw;border-radius:999px;background:rgba(10,14,20,.78);border:1px solid rgba(255,255,255,.14);font-size:1.7vh;color:rgba(244,246,250,.85);backdrop-filter:blur(6px)}
.demo-badge b{color:#fff;letter-spacing:.2vh}
.demo-badge a{color:#7fb3d5;text-decoration:none}
.demo-badge a:hover{text-decoration:underline}
`;

const BADGE_HINT: Record<string, string> = {
  en: "arrows: move · Enter: OK · Backspace: back",
  hu: "nyilak: mozgás · Enter: OK · Backspace: vissza",
};

function installBadge(): void {
  const style = document.createElement("style");
  style.textContent = STYLES;
  document.head.appendChild(style);

  const badge = document.createElement("div");
  badge.className = "demo-badge";
  const label = document.createElement("b");
  label.textContent = "DEMO";
  const hint = document.createElement("span");
  const link = document.createElement("a");
  link.href = "https://github.com/Andy1210/tvbox";
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = "GitHub";
  link.tabIndex = -1; // never steal D-pad/keyboard focus from the launcher
  badge.append(label, hint, link);
  document.body.appendChild(badge);

  const setHint = () => {
    hint.textContent = BADGE_HINT[useLocaleStore.getState().locale ?? "en"] ?? BADGE_HINT.en;
  };
  setHint();
  useLocaleStore.subscribe(setHint);
}

export function installDemo(): void {
  presetLocaleFromUrl();
  patchFetch();
  installBridge();
  installBadge();
}
