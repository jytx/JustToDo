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
  const pu = popupRef.value.getBoundingClientRect();
  const scrollY = window.scrollY;
  const scrollX = window.scrollX;
  const top = tr.bottom + scrollY + props.offset;
  let left = tr.left + scrollX;
  if (props.placement === "bottom-right") {
    left = tr.right + scrollX - pu.width;
  } else if (props.placement === "bottom-center") {
    left = tr.left + scrollX + tr.width / 2 - pu.width / 2;
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
  /* 内容由调用方控制样式 */
}
</style>
