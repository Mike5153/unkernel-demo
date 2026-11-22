import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  // Keep unkernel out of Vite's dependency pre-bundler so
  // `new URL("./unkernel.wasm", import.meta.url)` resolves in dev mode.
  optimizeDeps: {
    exclude: ["unkernel"],
  },
  worker: {
    format: "es",
  },
  build: {
    target: "esnext",
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        terminal: resolve(import.meta.dirname, "terminal.html"),
      },
    },
  },
});
