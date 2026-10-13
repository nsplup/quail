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
    // ES worker：module worker 内的动态 import 保持独立分包（着色语言包按需加载，
    // 首次用到某语言才拉取对应 chunk）；默认 iife 会把动态 import 内联进 worker 主体
    format: "es",
  },
});
