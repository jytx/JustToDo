<script setup lang="ts">
// 轻量 Popover 组件 —— 浮层 + 点击外部关闭
// 用法：
//   <Popover v-model:visible="visible" :offset="4">
//     <template #trigger><button @click="visible = !visible">打开</button></template>
//     <div class="my-popup">...</div>
//   </Popover>
import { ref, watch, onBeforeUnmount, nextTick } from "vue";

const props = withDefaults(
  defineProps<{
    visible: boolean;
    /** 弹层相对 trigger 的偏移（px） */
    offset?: number;
    /** 弹层位置 */
    placement?: "bottom-left" | "bottom-right" | "bottom-center" | "top-left";
  }>(),
  { offset: 6, placement: "bottom-left" },
);

const emit = defineEmits<{
  "update:visible": [value: boolean];
}>();

const triggerRef = ref<HTMLElement | null>(null);
const popupRef = ref<HTMLElement | null>(null);
const popupStyle = ref<Record<string, string>>({});

function updatePosition() {
  if (!triggerRef.value || !popupRef.value) return;
  const tr = triggerRef.value.getBoundingClientRect();
  // 用 popup 自身尺寸（包括 padding/border）
  let pu = popupRef.value.getBoundingClientRect();
  // 如果 popup 宽度被 absolute 拉伸成视口宽（>600px 视为异常），改读内容元素宽度
  if (pu.width > 600 && popupRef.value.firstElementChild) {
    pu = popupRef.value.firstElementChild.getBoundingClientRect();
  }
  const scrollY = window.scrollY;
  const scrollX = window.scrollX;
  const viewportW = document.documentElement.clientWidth;
  const viewportH = document.documentElement.clientHeight;
  const margin = 4;

  // 先按指定 placement 计算 left
  let placement = props.placement;
  let top = tr.bottom + scrollY + props.offset;
  let left = tr.left + scrollX;
  if (placement === "bottom-right") {
    left = tr.right + scrollX - pu.width;
  } else if (placement === "bottom-center") {
    left = tr.left + scrollX + tr.width / 2 - pu.width / 2;
  }

  // 智能翻转：超出右边界 → 改成 bottom-right 或居中
  if (left + pu.width > viewportW - margin) {
    // 试 bottom-right
    const newLeft = tr.right + scrollX - pu.width;
    if (newLeft >= margin) {
      placement = "bottom-right";
      left = newLeft;
    } else {
      // 都装不下，强制居中并夹在视口内
      placement = "bottom-center";
      left = tr.left + scrollX + tr.width / 2 - pu.width / 2;
    }
  }
  // 超出左边界 → 改成 bottom-left
  if (left < margin) {
    placement = "bottom-left";
    left = tr.left + scrollX;
    if (left + pu.width > viewportW - margin) {
      // 还是超出，夹在视口内
      left = Math.max(margin, viewportW - pu.width - margin);
    }
  }

  // 底部翻转到 trigger 上方
  if (top + pu.height > scrollY + viewportH - margin) {
    top = tr.top + scrollY - pu.height - props.offset;
  }

  popupStyle.value = {
    position: "absolute",
    top: top + "px",
    left: left + "px",
    zIndex: "9999",
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

function onDocumentClick(e: MouseEvent) {
  if (!props.visible) return;
  const target = e.target as Node;
  if (
    triggerRef.value?.contains(target) ||
    popupRef.value?.contains(target)
  ) {
    return;
  }
  emit("update:visible", false);
}

function onScroll() {
  if (props.visible) updatePosition();
}

onBeforeUnmount(() => {
  document.removeEventListener("mousedown", onDocumentClick);
  document.removeEventListener("scroll", onScroll, true);
});

watch(
  () => props.visible,
  (v) => {
    if (v) {
      document.addEventListener("mousedown", onDocumentClick);
      document.addEventListener("scroll", onScroll, true);
    } else {
      document.removeEventListener("mousedown", onDocumentClick);
      document.removeEventListener("scroll", onScroll, true);
    }
  },
  { immediate: true },
);
</script>

<template>
  <span class="popover-trigger" ref="triggerRef">
    <slot name="trigger" />
  </span>
  <Teleport to="body">
    <div v-if="visible" ref="popupRef" :style="popupStyle" class="popover-content">
      <slot />
    </div>
  </Teleport>
</template>

<style scoped>
.popover-trigger {
  display: inline-flex;
}

.popover-content {
  /* 由内容驱动宽度，避免 position:absolute 被父级（body）撑成视口宽 */
  width: max-content;
  max-width: calc(100vw - 8px);
}
</style>
