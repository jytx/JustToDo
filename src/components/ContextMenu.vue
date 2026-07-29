<script setup lang="ts">
// 右键菜单容器 —— 基于鼠标坐标定位（与 MenuPopover 的「相对 trigger 定位」不同）
// 复用 MenuPopoverItem 作为子项，保证视觉语言一致。
// 用法：
//   <ContextMenu v-model:visible="open" :x="e.clientX" :y="e.clientY">
//     <MenuPopoverItem @click="...">...</MenuPopoverItem>
//   </ContextMenu>
//
// 定位基准：MouseEvent.clientX/clientY（视口坐标），用 position:fixed 渲染。
// 渲染后按 popup 实际尺寸做视口边界翻转（超出右边→左移；超出下边→上移），
// 逻辑参考 Popover.updatePosition 的边界保护。
import { ref, watch, nextTick, onBeforeUnmount } from "vue";

const props = defineProps<{
  visible: boolean;
  /** 鼠标视口坐标 X（clientX） */
  x: number;
  /** 鼠标视口坐标 Y（clientY） */
  y: number;
}>();

const emit = defineEmits<{
  "update:visible": [value: boolean];
}>();

const popupRef = ref<HTMLElement | null>(null);
const popupStyle = ref<Record<string, string>>({});

/** 根据鼠标坐标 + popup 实际尺寸计算定位，做视口边界保护。
 *  - 默认：菜单左上角对齐鼠标点 (x, y)
 *  - 超出右边：菜单右边对齐视口右边（或整体左移到 x - width）
 *  - 超出下边：菜单底部对齐鼠标点上方 (y - height) */
function updatePosition() {
  if (!popupRef.value) return;
  const pu = popupRef.value.getBoundingClientRect();
  const viewportW = document.documentElement.clientWidth;
  const viewportH = document.documentElement.clientHeight;
  const margin = 4;

  let left = props.x;
  let top = props.y;

  // 超出右边界 → 整体左移，让菜单右边对齐鼠标点（避免被视口裁剪）
  if (left + pu.width > viewportW - margin) {
    left = Math.max(margin, props.x - pu.width);
  }
  // 超出下边界 → 翻转到鼠标点上方
  if (top + pu.height > viewportH - margin) {
    top = Math.max(margin, props.y - pu.height);
  }
  // 最终夹在视口内（防止极端情况）
  left = Math.min(left, viewportW - pu.width - margin);
  top = Math.min(top, viewportH - pu.height - margin);

  popupStyle.value = {
    position: "fixed",
    left: left + "px",
    top: top + "px",
    zIndex: "10000", // 高于普通 Popover(9999)，确保右键菜单在最上层
  };
}

watch(
  () => props.visible,
  async (v) => {
    if (v) {
      await nextTick();
      updatePosition();
    }
  },
);

/** 点击菜单外部 → 关闭（点菜单内部由各 item 的 @click 自行关闭） */
function onDocumentClick(e: MouseEvent) {
  if (!props.visible) return;
  const target = e.target as Node | null;
  if (popupRef.value && target && popupRef.value.contains(target)) return;
  emit("update:visible", false);
}

/** ESC 关闭 —— 捕获阶段注册 + stopImmediatePropagation，确保右键菜单的 ESC
 *  不冒泡到 window（AppLayout 的 ESC 监听器在冒泡阶段），避免关菜单连带关详情面板。 */
function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape" && props.visible) {
    e.preventDefault();
    e.stopImmediatePropagation();
    emit("update:visible", false);
  }
}

/** 滚动时关闭（避免定位错乱） */
function onScroll() {
  if (props.visible) emit("update:visible", false);
}

onBeforeUnmount(() => {
  document.removeEventListener("mousedown", onDocumentClick);
  // capture 参数须与 addEventListener 一致（true），否则无法移除
  document.removeEventListener("keydown", onKeydown, true);
  document.removeEventListener("scroll", onScroll, true);
});

watch(
  () => props.visible,
  (v) => {
    if (v) {
      // 用 mousedown 而非 click，确保在后续 click 之前就判定「点外部」
      document.addEventListener("mousedown", onDocumentClick);
      // 捕获阶段：保证先于 AppLayout 的冒泡阶段 ESC 监听器触发
      document.addEventListener("keydown", onKeydown, true);
      document.addEventListener("scroll", onScroll, true);
    } else {
      document.removeEventListener("mousedown", onDocumentClick);
      document.removeEventListener("keydown", onKeydown, true);
      document.removeEventListener("scroll", onScroll, true);
    }
  },
  { immediate: true },
);
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" ref="popupRef" class="context-menu" :style="popupStyle">
      <slot />
    </div>
  </Teleport>
</template>

<style scoped>
/* 容器外观与 MenuPopover 的 .menu-popover 完全一致，保证视觉统一 */
.context-menu {
  width: max-content;
  min-width: 120px;
  max-width: 220px;
  background: var(--jt-surface);
  border-radius: 12px;
  box-shadow:
    0 8px 32px rgba(0, 0, 0, 0.08),
    0 2px 8px rgba(0, 0, 0, 0.04);
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
</style>
