import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};

function renameHtmlToApp(): Plugin {
  return {
    name: "rename-mcp-app-html",
    enforce: "post",
    generateBundle(_options, bundle) {
      const entry = bundle["mcp-app.html"];
      if (entry) {
        entry.fileName = "app.html";
        bundle["app.html"] = entry;
        delete bundle["mcp-app.html"];
      }
    },
  };
}

export default defineConfig({
  base: "./",
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [viteSingleFile(), renameHtmlToApp()],
  build: {
    outDir: "../dist/mcp-app",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    rollupOptions: {
      input: "mcp-app.html",
    },
  },
});
