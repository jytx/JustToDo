import {
  createRouter,
  createWebHashHistory,
  type RouteRecordRaw,
} from "vue-router";
import { useSettingsStore, type StartupView } from "@/stores/settings";

// Tauri 使用自定义协议加载前端，无服务器处理深链接，
// 必须用 hash 模式避免刷新/深链 404
const routes: RouteRecordRaw[] = [
  // 根路径指向一个空壳路由，redirect 由全局守卫根据 startupView 动态决定
  {
    path: "/",
    name: "root",
    component: { template: "<div />" },
  },
  {
    path: "/today",
    name: "today",
    component: () => import("@/views/SmartView.vue"),
    props: { view: "today" },
  },
  {
    path: "/upcoming",
    name: "upcoming",
    component: () => import("@/views/SmartView.vue"),
    props: { view: "upcoming" },
  },
  {
    path: "/all",
    name: "all",
    component: () => import("@/views/SmartView.vue"),
    props: { view: "all" },
  },
  {
    path: "/list/:id",
    name: "list",
    component: () => import("@/views/ListView.vue"),
    props: true,
  },
  {
    path: "/settings",
    name: "settings",
    component: () => import("@/views/SettingsView.vue"),
  },
  {
    path: "/tag/:id",
    name: "tag",
    component: () => import("@/views/TagView.vue"),
    props: true,
  },
  {
    path: "/habits",
    name: "habits",
    component: () => import("@/views/HabitView.vue"),
  },
];

/** StartupView → 路由 path */
function startupPath(v: StartupView): string {
  switch (v) {
    case "all":
      return "/all";
    case "inbox":
      return "/list/inbox";
    case "today":
    default:
      return "/today";
  }
}

const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

/**
 * 全局守卫：访问根路径 / 时按 settings.startupView 决定真实目的地。
 * 只在 to.path === "/" 时改写；用户从其他入口直达深链不动。
 */
router.beforeEach((to) => {
  if (to.path !== "/") return true;
  try {
    const settings = useSettingsStore();
    return startupPath(settings.startupView);
  } catch {
    // store 还没初始化（理论上 main.ts 已 await initialize），兜底回 today
    return "/today";
  }
});

export default router;

