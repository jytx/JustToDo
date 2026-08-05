<script setup lang="ts">
// 大纲浮层面板 —— 提取富文本中的所有标题（H1-H6），树形展示，
// 点击条目跳转到对应标题（光标定位 + 滚动）。
//
// 设计：
//   - 数据：从 editor.state.doc 扫描 heading 节点（level + text + pos）
//   - 渲染：按 level 缩进（每级 14px），当前活跃章节高亮
//   - 跳转：editor.commands.focus().setTextSelection(pos) + 滚动容器 scrollIntoView
//   - 当前章节高亮：监听滚动容器 scroll，找当前可视区首个 heading
import { onMounted, onBeforeUnmount, ref, watch } from "vue";
import type { Editor } from "@tiptap/vue-3";

/** 单个大纲条目 */
interface OutlineItem {
  id: number; // 序号（唯一 key）
  level: number; // 1-6
  text: string; // 标题文本
  pos: number; // 文档位置（heading 节点起始）
}

const props = defineProps<{
  editor: Editor | undefined;
}>();

const emit = defineEmits<{ close: [] }>();

/** 从 doc 提取标题列表（ref，不是 computed——
 *  Tiptap editor 用自定义 ref 异步触发更新，
 *  Vue 的响应式追踪不到 editor.state.doc 的变化，需手动订阅 onUpdate 重算） */
const headings = ref<OutlineItem[]>([]);

/** 一次性扫描当前 doc，构建大纲数组 */
function rebuildHeadings(): void {
  const ed = props.editor;
  if (!ed) {
    headings.value = [];
    return;
  }
  const items: OutlineItem[] = [];
  ed.state.doc.descendants((node, pos) => {
    if (node.type.name === "heading") {
      // 用 pos 作为稳定 key（文档内唯一，标题移动时 pos 自动跟随变化）
      items.push({
        id: pos,
        level: node.attrs.level as number,
        text: node.textContent || "(无标题)",
        pos,
      });
    }
    return false; // 不深入 heading 内部（标题无子标题）
  });
  headings.value = items;
}

// 订阅 editor 文档更新 + 初始构建
let detach: (() => void) | null = null;
watch(
  () => props.editor,
  (ed, _old, onCleanup) => {
    // 清理旧订阅
    if (detach) {
      detach();
      detach = null;
    }
    if (!ed) {
      headings.value = [];
      return;
    }
    rebuildHeadings();
    const handler = (): void => rebuildHeadings();
    ed.on("update", handler);
    detach = () => ed.off("update", handler);
    onCleanup(() => {
      detach?.();
      detach = null;
    });
  },
  { immediate: true },
);

/** 当前活跃标题序号（滚动高亮用） */
const activeIndex = ref(-1);
/** 滚动容器（详情面板的 .detail-panel__main） */
let scrollEl: HTMLElement | null = null;

/** 查找详情面板的滚动容器（向上找 overflow-y:auto 祖先） */
function findScrollContainer(): HTMLElement | null {
  const pm = document.querySelector(".ProseMirror");
  let el: HTMLElement | null = pm?.parentElement ?? null;
  while (el && el !== document.body) {
    const cs = getComputedStyle(el);
    if (cs.overflowY === "auto" || cs.overflowY === "scroll") return el;
    el = el.parentElement;
  }
  return null;
}

/** 滚动时计算当前可视区首个 heading，更新高亮 */
function onScroll(): void {
  const ed = props.editor;
  if (!ed || headings.value.length === 0) return;
  // 取每个 heading 的 DOM 元素位置，找最后一个在视口顶部之上的
  const view = ed.view;
  let current = -1;
  for (let i = 0; i < headings.value.length; i++) {
    const item = headings.value[i];
    const dom = view.domAtPos(item.pos + 1)?.node as HTMLElement | undefined;
    const blockEl = dom?.closest(".heading-block, h1, h2, h3, h4, h5, h6");
    if (!blockEl) continue;
    const rect = blockEl.getBoundingClientRect();
    // 顶部留 60px 容差（标题刚滚出顶部视为当前章节）
    if (rect.top <= 80) current = i;
    else break;
  }
  activeIndex.value = current;
}

/** 点击大纲条目：跳转到对应标题 */
function jumpTo(item: OutlineItem): void {
  const ed = props.editor;
  if (!ed) return;
  // 光标定位到标题块内开头
  ed.chain().focus().setTextSelection(item.pos + 1).run();
  // 滚动标题到可视区
  const view = ed.view;
  const dom = view.domAtPos(item.pos + 1)?.node as HTMLElement | undefined;
  const blockEl = dom?.closest(".heading-block, h1, h2, h3, h4, h5, h6");
  blockEl?.scrollIntoView({ behavior: "smooth", block: "start" });
}

onMounted(() => {
  scrollEl = findScrollContainer();
  scrollEl?.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
});

onBeforeUnmount(() => {
  scrollEl?.removeEventListener("scroll", onScroll);
  // 清理 editor.on('update') 订阅，避免内存泄漏
  detach?.();
  detach = null;
});
</script>

<template>
  <div class="outline-panel">
    <div class="outline-panel__header">
      <span class="outline-panel__title">大纲</span>
      <button
        type="button"
        class="outline-panel__close"
        title="关闭"
        @click="emit('close')"
      >
        <icon-close :size="14" />
      </button>
    </div>

    <div v-if="headings.length === 0" class="outline-panel__empty">
      暂无标题<br />在正文中使用 H1-H6 标题后，这里会显示大纲
    </div>

    <div v-else class="outline-panel__list">
      <button
        v-for="(item, idx) in headings"
        :key="item.id"
        type="button"
        class="outline-panel__item"
        :class="{
          'outline-panel__item--active': activeIndex === idx,
          [`outline-panel__item--h${item.level}`]: true,
        }"
        :style="{ paddingLeft: 12 + (item.level - 1) * 14 + 'px' }"
        :title="item.text"
        @click="jumpTo(item)"
      >
        <span class="outline-panel__level">H{{ item.level }}</span>
        <span class="outline-panel__text">{{ item.text }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.outline-panel {
  position: absolute;
  top: 48px;
  right: 8px;
  bottom: 56px;
  width: 240px;
  background: var(--jt-surface);
  border: 1px solid var(--jt-border);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
  display: flex;
  flex-direction: column;
  z-index: 10;
  overflow: hidden;
}

.outline-panel__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 8px 8px 12px;
  border-bottom: 1px solid var(--jt-border);
  flex-shrink: 0;
}
.outline-panel__title {
  font-size: 13px;
  font-weight: 600;
  color: var(--jt-text-primary);
}
.outline-panel__close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  background: transparent;
  color: var(--jt-text-tertiary);
  border-radius: 4px;
  cursor: pointer;
  transition: background-color 0.12s, color 0.12s;
}
.outline-panel__close:hover {
  background: var(--jt-surface-hover);
  color: var(--jt-text-primary);
}

.outline-panel__empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  font-size: 12px;
  color: var(--jt-text-tertiary);
  text-align: center;
  line-height: 1.6;
}

.outline-panel__list {
  flex: 1;
  overflow-y: auto;
  padding: 4px;
}

.outline-panel__item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  border: none;
  background: transparent;
  color: var(--jt-text-secondary);
  font-size: 12px;
  padding: 4px 8px;
  border-radius: 4px;
  cursor: pointer;
  text-align: left;
  transition: background-color 0.12s, color 0.12s;
}
.outline-panel__item:hover {
  background: var(--jt-surface-hover);
  color: var(--jt-text-primary);
}
.outline-panel__item--active {
  background: color-mix(in srgb, var(--jt-primary) 10%, transparent);
  color: var(--jt-primary);
  font-weight: 500;
}

/* 级别标签：小号 mono 字体，浅色 */
.outline-panel__level {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--jt-text-tertiary);
  flex-shrink: 0;
  opacity: 0.7;
}
.outline-panel__item--active .outline-panel__level {
  color: var(--jt-primary);
  opacity: 1;
}

/* 标题文本：单行省略 */
.outline-panel__text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
