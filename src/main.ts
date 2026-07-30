import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import router from "./router";

// Arco Design Vue
import ArcoVue from "@arco-design/web-vue";
import ArcoVueIcon from "@arco-design/web-vue/es/icon";
import "@arco-design/web-vue/dist/arco.css";

// 字体（本地化打包，离线可用）
import "@fontsource-variable/fraunces";
import "@fontsource-variable/geist";
import "@fontsource/jetbrains-mono";

// 全局样式
import "./styles/theme.css";
import "./styles/typography.css";
import "./styles/sidebar-create.css";
import "./styles/confirm-dialog.css";

// 工具
import { disableNativeContextMenu } from "@/utils/contextMenu";

const app = createApp(App);
const pinia = createPinia();
app.use(pinia);
app.use(router);
app.use(ArcoVue);
app.use(ArcoVueIcon);

// 全局错误捕获
app.config.errorHandler = (err, _instance, info) => {
  console.error("[Vue Error]", err, info);
};

// 在挂载前同步等待设置初始化 —— 避免主题闪烁并让全局可立即读取设置
import { useSettingsStore } from "@/stores/settings";
const settingsStore = useSettingsStore(pinia);
settingsStore.initialize().catch((e) => {
  console.error("[SettingsStore] 启动初始化失败:", e);
});

app.mount("#app");

// 禁用 webview 原生右键菜单（Reload / Inspect Element / Save As 等）。
// 仅在输入框 / 文本域 / 富文本编辑器（contentEditable）放行，保留复制粘贴等系统能力。
// 已挂自定义右键的区域（任务项 / 侧边栏 / 面板空白区）不受影响：它们用自身的
// @contextmenu.prevent 完成拦截，本兜底只负责「未覆盖区域」。
window.addEventListener("contextmenu", disableNativeContextMenu);

// MCP 插件前端监听器
if (import.meta.env.DEV) {
  import("tauri-plugin-mcp")
    .then(({ setupPluginListeners }) => setupPluginListeners())
    .catch(() => {});
}
