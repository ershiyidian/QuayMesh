import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// 聊天卡片构建为单文件 HTML，避免宿主浏览器再去访问入口节点的回环地址。
export default defineConfig({
  root: resolve(__dirname, "src/ui"),
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: resolve(__dirname, "dist/ui-card"),
    emptyOutDir: true,
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    rollupOptions: {
      input: resolve(__dirname, "src/ui/workspace-app.html"),
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});