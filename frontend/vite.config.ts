import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import wails from "@wailsio/runtime/plugins/vite";
import tailwindcss from "@tailwindcss/vite";

// https://vitejs.dev/config/
export default defineConfig({
  server: {
    host: "127.0.0.1",
    port: Number(process.env.WAILS_VITE_PORT) || 9245,
    strictPort: true,
  },
  plugins: [svelte(), wails("./bindings"), tailwindcss()],
  worker: {
    // ES module worker（着色 worker 全量静态引入语法包，无动态 import，
    // 分包策略不影响其加载）；默认 iife 亦可，保持 es 与主包模块语义一致
    format: "es",
  },
});
