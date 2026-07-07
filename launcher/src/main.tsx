import { createRoot } from "react-dom/client";
import { init } from "@noriginmedia/norigin-spatial-navigation";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import "./index.css";

// Spatial navigation: the CEC->uinput bridge sends arrow keys + Enter, which
// norigin maps to directional focus moves + onEnterPress.
init({
  debug: false,
  visualDebug: false,
  // Back/Home/media keys are handled by the shell preload, not here.
});

// Auto-hide the mouse cursor: hidden by default (D-pad UI), shown for ~2.5s when
// a mouse actually moves - so a connected mouse works but an idle pointer never
// lingers on screen.
let cursorTimer: ReturnType<typeof setTimeout>;
window.addEventListener(
  "mousemove",
  () => {
    document.documentElement.classList.add("cursor-on");
    clearTimeout(cursorTimer);
    cursorTimer = setTimeout(() => document.documentElement.classList.remove("cursor-on"), 2500);
  },
  true,
);

// Global state lives in zustand stores (lib/i18n, stores/*) - no provider
// needed. The boundary is the only thing above App: a crash on a keyboardless
// TV must end at a reload button, never a black screen.
async function start() {
  // Demo build (GitHub Pages): mock the shell API + bridge before anything
  // mounts. Statically false outside --mode demo, so production builds drop it.
  if (import.meta.env.MODE === "demo") {
    (await import("./demo/install")).installDemo();
  }
  createRoot(document.getElementById("root")!).render(
    <ErrorBoundary>
      <App />
    </ErrorBoundary>,
  );
}
void start();
