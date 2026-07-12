// 深色模式切换 composable
// Arco Design Vue 用 body[arco-theme="dark"] 属性切换主题

import { ref } from "vue";

const isDark = ref(document.body.getAttribute("arco-theme") === "dark");

export function useTheme() {
  function toggleTheme() {
    isDark.value = !isDark.value;
    document.body.setAttribute("arco-theme", isDark.value ? "dark" : "");
  }

  function setDark(dark: boolean) {
    isDark.value = dark;
    document.body.setAttribute("arco-theme", dark ? "dark" : "");
  }

  return { isDark, toggleTheme, setDark };
}
