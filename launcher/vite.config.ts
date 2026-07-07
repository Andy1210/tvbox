import path from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The launcher is served by the shell under /tvbox/, so assets must be
// referenced relatively (base: "./"). The build output goes straight into the
// shell dir as launcher-dist/ so the shell is self-contained to deploy.
// `--mode demo` builds the browser demo (mocked shell, src/demo/) into
// dist-demo/ instead - that's what the GitHub Pages workflow publishes.
//
// Dev without a TV: `npm run demo` runs the dev server against the mocked
// shell (full HMR, no box needed). To develop against a REAL box's live data,
// proxy the shell API - it binds to the box's loopback only, so tunnel it:
//   ssh -N -L 8097:127.0.0.1:8097 <pi-ssh-host> &
//   TVBOX_HOST=127.0.0.1:8097 npm run dev
const tvboxHost = process.env.TVBOX_HOST;

export default defineConfig(({ mode }) => ({
  base: "./",
  plugins: [react(), tailwindcss()],
  // @sdk = the shared @tvbox/app-sdk, consumed as source (no build step). dedupe
  // is REQUIRED so app-sdk's bare `react`/`zustand`/etc. imports resolve to the
  // launcher's single copy - otherwise React sees two instances ("invalid hook
  // call"), since app-sdk has no node_modules of its own.
  resolve: {
    alias: { "@sdk": path.resolve(__dirname, "../app-sdk/src") },
    dedupe: ["react", "react-dom", "zustand", "@noriginmedia/norigin-spatial-navigation"],
  },
  // demo-public/ ships only with the demo: the static phone-pairing page the
  // demo QR codes point at (pair/). The box build has the real pairing server.
  publicDir: mode === "demo" ? "demo-public" : false,
  build: {
    outDir: mode === "demo" ? "dist-demo" : "../shell/launcher-dist",
    emptyOutDir: true,
  },
  server: tvboxHost ? { proxy: { "/tvbox/api": { target: "http://" + tvboxHost, changeOrigin: true } } } : undefined,
  test: {
    environment: "happy-dom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
  },
}));
