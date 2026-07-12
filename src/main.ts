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

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.use(ArcoVue);
app.use(ArcoVueIcon);

// 全局错误捕获
app.config.errorHandler = (err, _instance, info) => {
  console.error("[Vue Error]", err, info);
};

app.mount("#app");

// MCP 插件前端监听器
if (import.meta.env.DEV) {
  import("tauri-plugin-mcp")
    .then(({ setupPluginListeners }) => setupPluginListeners())
    .catch(() => {});
}
