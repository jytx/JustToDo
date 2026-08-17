import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath, URL } from "node:url";
import { readdirSync, readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// ── 音效 base64 内嵌插件 ──────────────────────────────────────
//
// 把 src/assets/sounds/ 下的音效转成 base64 常量（src/generated/sounds.ts），
// 播放/预解码全部走 data: URL 与内存字节，不依赖任何网络协议——
// 生产环境（tauri:// 自定义协议）下 fetch 资源行为不确定，内嵌后 dev / 打包行为完全一致。
// 仅在内容变化时才写文件，避免触发 vite 自身 watch 造成循环重载。
const SOUNDS_DIR = fileURLToPath(new URL("./src/assets/sounds", import.meta.url));
const SOUNDS_OUT = fileURLToPath(new URL("./src/generated/sounds.ts", import.meta.url));

function soundDataPlugin(): Plugin {
  return {
    name: "justtodo-sound-data",
    buildStart() {
      const files = readdirSync(SOUNDS_DIR).filter((f) => /\.(wav|mp3|aac)$/i.test(f));
      const lines = files.map(
        (f) => `  "${f}": "${readFileSync(path.join(SOUNDS_DIR, f)).toString("base64")}",`,
      );
      const content = [
        "// 自动生成：vite 插件从 src/assets/sounds/ 生成（勿手改；新增/修改音效后重启 dev）",
        "export const SOUND_DATA: Record<string, string> = {",
        ...lines,
        "};",
        "",
      ].join("\n");
      if (existsSync(SOUNDS_OUT) && readFileSync(SOUNDS_OUT, "utf8") === content) {
        return;
      }
      mkdirSync(path.dirname(SOUNDS_OUT), { recursive: true });
      writeFileSync(SOUNDS_OUT, content);
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [vue(), soundDataPlugin()],

  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1425,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
