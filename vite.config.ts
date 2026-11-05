import { defineConfig } from "vite";

// The desktop shell sets its own policy, which also has to allow its IPC.
const WEB_CSP = "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; worker-src 'self' blob:; connect-src 'self' http: https:; base-uri 'self'; form-action 'none'";

export default defineConfig(({ mode }) => ({
  // Relative, so the site works from a subfolder such as a GitHub Pages project URL.
  base: "./",
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  preview: { port: 4173, strictPort: true, allowedHosts: [".ts.net"] },
  // Matches the WebKit in the oldest supported macOS, 12.3.
  build: {
    target: "safari15.4",
    sourcemap: false,
    // WebKit remembers a failed preload for a while and fails the import with it, so a chunk that
    // loads on demand, like the assistant's, couldn't be retried when the connection came back.
    modulePreload: { resolveDependencies: (_file, deps, { hostType }) => (hostType === "html" ? deps : []) },
  },
  worker: { format: "es" },
  plugins: mode === "web" ? [{
    name: "web-csp",
    transformIndexHtml: () => [{
      tag: "meta",
      attrs: { "http-equiv": "Content-Security-Policy", content: WEB_CSP },
      injectTo: "head-prepend" as const,
    }],
  }] : [],
}));
