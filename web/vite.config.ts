import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    cssCodeSplit: false,
    assetsDir: "assets",
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8767",
        changeOrigin: true,
      },
    },
  },
});
