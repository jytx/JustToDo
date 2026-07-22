<script setup lang="ts">
// 模板卡片 —— 极简卡风格
// · 整卡 click → 打开编辑弹窗（emit 'edit'）
// · 右上「⋯」按钮 → 菜单（emit 'rename' / 'delete'）
// · 整卡可拖拽 → emit 'dragstart' / 'dragover' / 'drop' / 'dragend'
//   交由父组件 TemplateSection 编排实时让位动画
// · 正文区显示 note 前 3 行纯文本预览（HTML → textContent 截断）
import { computed, ref } from "vue";
import { IconMore, IconEdit, IconDelete, IconLaunch } from "@arco-design/web-vue/es/icon";
import type { Template } from "@/types";
import MenuPopover from "./MenuPopover.vue";
import MenuPopoverItem from "./MenuPopoverItem.vue";

const props = defineProps<{ template: Template }>();
const emit = defineEmits<{
  edit: [template: Template];
  rename: [template: Template];
  delete: [template: Template];
  /** 直接应用模板（不打开编辑弹窗，用模板当前内容创建任务）*/
  apply: [template: Template];
  /** 拖拽事件转发 —— 让父组件做实时重排 + 持久化 */
  dragstart: [template: Template, e: DragEvent];
  dragend: [];
  dragover: [template: Template, position: "before" | "after", e: DragEvent];
  drop: [template: Template, position: "before" | "after", e: DragEvent];
}>();

const menuOpen = ref(false);
const isDragging = ref(false);

/** 内置模板的 emoji 图标（按 id 匹配；其它一律 📄） */
const icon = computed<string>(() => {
  switch (props.template.id) {
    case "tpl-meeting":
      return "📝";
    case "tpl-weekly":
      return "📊";
    case "tpl-codereview":
      return "👀";
    case "tpl-reading":
      return "📖";
    default:
      return "📄";
  }
});

/** 把 HTML 转纯文本并截前 3 行 */
const previewText = computed<string>(() => {
  try {
    const doc = new DOMParser().parseFromString(props.template.note, "text/html");
    const text = doc.body.textContent ?? "";
    const lines = text.split("\n").map((s) => s.trim()).filter(Boolean);
    return lines.slice(0, 3).join("\n");
  } catch {
    return "";
  }
});

function onEdit() {
  emit("edit", props.template);
}
function onApply() {
  menuOpen.value = false;
  emit("apply", props.template);
}
function onRename() {
  menuOpen.value = false;
  emit("rename", props.template);
}
function onDelete() {
  menuOpen.value = false;
  emit("delete", props.template);
}

// ─── 拖拽（转发给父组件编排）────────────────────────────
// 本组件只负责：
// 1. 设置 dataTransfer（dragstart）
// 2. 计算 before/after 位置（dragover / drop）
// 3. 自身 isDragging 视觉状态（半透明）
// 真正的数组重排 + 持久化在父组件做。

function onDragStart(e: DragEvent) {
  e.dataTransfer!.setData("text/plain", props.template.id);
  e.dataTransfer!.effectAllowed = "move";

  // 自定义 ghost：克隆整张卡片作为拖拽预览，跟随鼠标
  // 克隆后会被移到屏幕外（top:-1000px），DnD 引擎只截图作为 ghost
  const source = e.currentTarget as HTMLElement;
  const rect = source.getBoundingClientRect();
  const ghost = source.cloneNode(true) as HTMLElement;
  // 用 inline style 重新声明外观，避免克隆后 scoped CSS 失效（data-v-xxx 在 body 上下文匹配不到）
  // 宽度锁定为原卡片宽度，避免在 body 里塌缩到 0
  ghost.style.cssText = `
    position: absolute;
    top: -1000px;
    left: -1000px;
    width: ${rect.width}px;
    background: var(--jt-surface, #fff);
    border: 1px solid var(--jt-border, #e4e4e7);
    border-radius: 8px;
    padding: 12px 14px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
    opacity: 0.95;
    pointer-events: none;
    font-family: var(--font-body, system-ui);
  `;
  document.body.appendChild(ghost);
  // 鼠标在卡片中的相对位置作为拖拽锚点（手指/光标落在原位置）
  const offsetX = e.clientX - rect.left;
  const offsetY = e.clientY - rect.top;
  e.dataTransfer!.setDragImage(ghost, offsetX, offsetY);
  // 拖拽结束后移除 ghost
  setTimeout(() => document.body.removeChild(ghost), 0);

  isDragging.value = true;
  emit("dragstart", props.template, e);
}

function onDragEnd() {
  isDragging.value = false;
  emit("dragend");
}

/** 计算落点位置：上半 = before，下半 = after */
function computePosition(e: DragEvent): "before" | "after" {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const y = e.clientY - rect.top;
  return y < rect.height * 0.5 ? "before" : "after";
}

function onDragOver(e: DragEvent) {
  e.preventDefault();
  e.dataTransfer!.dropEffect = "move";
  emit("dragover", props.template, computePosition(e), e);
}

function onDrop(e: DragEvent) {
  e.preventDefault();
  e.stopPropagation();
  emit("drop", props.template, computePosition(e), e);
}
</script>

<template>
  <div
    class="tpl-card"
    :class="{ 'tpl-card--dragging': isDragging }"
    draggable="true"
    @click="onEdit"
    @dragstart="onDragStart"
    @dragend="onDragEnd"
    @dragover="onDragOver"
    @drop="onDrop"
  >
    <div class="tpl-card__header">
      <span class="tpl-card__icon">{{ icon }}</span>
      <span class="tpl-card__name" :title="template.name">{{ template.name }}</span>
      <MenuPopover v-model:visible="menuOpen" placement="bottom-right">
        <template #trigger>
          <button
            class="tpl-card__menu"
            title="更多操作"
            @click.stop="menuOpen = !menuOpen"
            @dragstart.stop.prevent
          >
            <IconMore :size="16" />
          </button>
        </template>
        <MenuPopoverItem @click="onApply">
          <IconLaunch :size="15" />
          <span>应用模板</span>
        </MenuPopoverItem>
        <MenuPopoverItem @click="onRename">
          <IconEdit :size="15" />
          <span>重命名</span>
        </MenuPopoverItem>
        <MenuPopoverItem danger @click="onDelete">
          <IconDelete :size="15" />
          <span>删除</span>
        </MenuPopoverItem>
      </MenuPopover>
    </div>
    <div v-if="previewText" class="tpl-card__preview">{{ previewText }}</div>
    <div v-else class="tpl-card__preview tpl-card__preview--empty">(空白模板)</div>
  </div>
</template>

<style scoped>
.tpl-card {
  background: var(--jt-surface);
  border: 1px solid var(--jt-border);
  border-radius: 8px;
  padding: 12px 14px;
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 110px;
}
.tpl-card:hover {
  border-color: var(--jt-text-tertiary);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
}
/* 拖拽中的源卡片：半透明留在原位 */
.tpl-card--dragging {
  opacity: 0.4;
}
.tpl-card[draggable="true"] {
  cursor: grab;
}
.tpl-card[draggable="true"]:active {
  cursor: grabbing;
}

.tpl-card__header {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tpl-card__icon {
  font-size: 16px;
  line-height: 1;
  flex-shrink: 0;
}
.tpl-card__name {
  font-size: 13px;
  font-weight: 600;
  color: var(--jt-text-primary);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tpl-card__menu {
  margin: 0;
  padding: 0;
  background: transparent;
  border: none;
  cursor: pointer;
  border-radius: 4px;
  color: var(--jt-text-tertiary);
  display: flex;
  align-items: center;
  flex-shrink: 0;
}
.tpl-card__menu:hover {
  background-color: var(--jt-surface-hover);
  color: var(--jt-text-primary);
}

.tpl-card__preview {
  font-size: 12px;
  color: var(--jt-text-secondary);
  line-height: 1.5;
  white-space: pre-wrap;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  border-top: 1px dashed var(--jt-border);
  padding-top: 8px;
}
.tpl-card__preview--empty {
  color: var(--jt-text-tertiary);
  font-style: italic;
}
</style>
