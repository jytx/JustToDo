import {
  createRouter,
  createWebHashHistory,
  type RouteRecordRaw,
} from "vue-router";

// Tauri 使用自定义协议加载前端，无服务器处理深链接，
// 必须用 hash 模式避免刷新/深链 404
const routes: RouteRecordRaw[] = [
  { path: "/", redirect: "/today" },
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

const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

export default router;
