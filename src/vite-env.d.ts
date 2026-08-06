/// <reference types="vite/client" />

declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent<{}, {}, any>;
  export default component;
}

// turndown-plugin-gfm 无官方类型声明
declare module "turndown-plugin-gfm";
