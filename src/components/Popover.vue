<script setup lang="ts">
// 轻量 Popover 组件 —— 浮层 + 点击外部关闭
// 用法：
//   <Popover v-model:visible="visible" :offset="4">
//     <template #trigger><button @click="visible = !visible">打开</button></template>
//     <div class="my-popup">...</div>
//   </Popover>
import { ref, computed, watch, onBeforeUnmount, nextTick } from "vue";

const props = withDefaults(
  defineProps<{
    /** 弹层是否可见。声明为可选：调用方对 reactive 对象取值（如 menuOpen[id]）
     *  在 key 未初始化时会得到 undefined，可选类型避免 Vue 的必填 Boolean 校验告警。
     *  组件内统一通过 open（规范化为 boolean）使用。 */
    visible?: boolean;
    /** 弹层相对 trigger 的偏移（px） */
    offset?: number;
    /** 弹层位置 */
    placement?:
      | "bottom-left"
      | "bottom-right"
      | "bottom-center"
      | "top-left"
      | "top-right"
      | "top-center";
  }>(),
  { offset: 6, placement: "bottom-left" },
);

const emit = defineEmits<{
  "update:visible": [value: boolean];
}>();

/** 规范化 visible：undefined / null 一律视作 false，得到确定的 boolean */
const open = computed(() => props.visible === true);

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
  // top-* 系列：弹层在 trigger 上方；其它在下方
  let top =
    placement.startsWith("top-")
      ? tr.top + scrollY - props.offset
      : tr.bottom + scrollY + props.offset;
  let left = tr.left + scrollX;
  if (placement === "bottom-right" || placement === "top-right") {
    left = tr.right + scrollX - pu.width;
  } else if (placement === "bottom-center" || placement === "top-center") {
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
  // 顶部 clip 保护：翻转后如果还在视口上方外，夹到 0（依赖 Tauri webview 的
  // 滚动容器或弹层 max-height 自带滚动条，避免被裁的内容直接消失）
  if (top < margin) {
    top = margin;
  }

  popupStyle.value = {
    position: "absolute",
    top: top + "px",
    left: left + "px",
    zIndex: "9999",
  };
}

watch(
  () => open.value,
  async (v) => {
    if (v) {
      await nextTick();
      updatePosition();
    }
  },
);

function onDocumentClick(e: MouseEvent) {
  if (!open.value) return;
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
  if (open.value) updatePosition();
}

/** ESC 关闭浮层。
 *  不做 stopPropagation：AppLayout 的 ESC 守卫会通过 .popover-content 检测到本浮层
 *  仍在 DOM 中而 return（不关详情面板），二者通过 DOM 状态协同，实现「逐层关闭」。 */
function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape" && open.value) {
    emit("update:visible", false);
  }
}

onBeforeUnmount(() => {
  document.removeEventListener("mousedown", onDocumentClick);
  document.removeEventListener("scroll", onScroll, true);
  document.removeEventListener("keydown", onKeydown);
});

watch(
  () => open.value,
  (v) => {
    if (v) {
      document.addEventListener("mousedown", onDocumentClick);
      document.addEventListener("scroll", onScroll, true);
      document.addEventListener("keydown", onKeydown);
    } else {
      document.removeEventListener("mousedown", onDocumentClick);
      document.removeEventListener("scroll", onScroll, true);
      document.removeEventListener("keydown", onKeydown);
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
    <div v-if="open" ref="popupRef" :style="popupStyle" class="popover-content">
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
