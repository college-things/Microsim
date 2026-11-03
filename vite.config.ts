import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  // Matches the WebKit in the oldest supported macOS, 12.3.
  build: { target: "safari15.4", sourcemap: false },
  worker: { format: "es" },
});
