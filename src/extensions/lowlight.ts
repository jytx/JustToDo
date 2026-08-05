// 共享的 lowlight 实例 —— 供 CodeBlockLowlight 扩展与代码块 NodeView 共用。
// 集中创建一处，避免多处 createLowlight 导致语言注册状态不一致。
import { createLowlight, common } from "lowlight";

/** 全局唯一的 lowlight 实例（common 语言集，含 35+ 种语言） */
export const lowlight = createLowlight(common);

/** lowlight 已注册的语言列表（供代码块语言下拉菜单使用），按字母序排序 */
export const LANGUAGES: readonly string[] = Object.freeze(
  [...lowlight.listLanguages()].sort((a, b) => a.localeCompare(b)),
);
