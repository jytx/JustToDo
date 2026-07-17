<script setup lang="ts">
// 轻量 popper 浮层：通过 Teleport 渲染到 body 避开任何祖先 stacking-context
// 用法：把 trigger 元素 ref 传进来，弹层自动定位在 trigger 下方
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";

const props = defineProps<{
  /** 触发元素 ref */
  anchor: HTMLElement | null;
  /** 弹层相对 trigger 的对齐位置 */
  placement?: "bottom-left" | "bottom-right" | "top-left" | "top-right";
  /** v-model:visible */
  visible: boolean;
  /** 与 trigger 的间距（px） */
  offset?: number;
}>();

const emit = defineEmits<{
  "update:visible": [v: boolean];
}>();

const popperRef = ref<HTMLElement | null>(null);
const pos = ref<{ left: number; top: number }>({ left: 0, top: 0 });

function updatePosition() {
  const anchor = props.anchor;
  const popper = popperRef.value;
  if (!anchor || !popper) return;
  const aRect = anchor.getBoundingClientRect();
  const pRect = popper.getBoundingClientRect();
  const offset = props.offset ?? 6;
  const placement = props.placement ?? "bottom-left";

  let left = aRect.left;
  let top = aRect.bottom + offset;

  // bottom-right: popper 右边对齐 trigger 右边
  if (placement === "bottom-right") {
    left = aRect.right - pRect.width;
  }

  // 防止右侧溢出
  const maxLeft = window.innerWidth - pRect.width - 8;
  if (left > maxLeft) left = maxLeft;
  if (left < 8) left = 8;

  pos.value = { left, top };
}

watch(
  () => props.visible,
  (v) => {
    if (v) {
      // 等下一帧让 popper 渲染出真实尺寸再算位置
      nextTick(() => {
        updatePosition();
      });
    } else {
      // 关闭时移除全局监听
      window.removeEventListener("mousedown", onDocMouseDown, true);
    }
  },
);

function onDocMouseDown(e: MouseEvent) {
  const popper = popperRef.value;
  const anchor = props.anchor;
  const target = e.target as Node | null;
  if (!target) return;
  if (popper && popper.contains(target)) return;
  if (anchor && anchor.contains(target)) return;
  emit("update:visible", false);
}

watch(
  () => props.visible,
  (v) => {
    if (v) {
      // 等 popper 渲染完再加全局监听
      nextTick(() => {
        window.addEventListener("mousedown", onDocMouseDown, true);
      });
    }
  },
);

onBeforeUnmount(() => {
  window.removeEventListener("mousedown", onDocMouseDown, true);
});

const popperStyle = computed(() => ({
  position: "fixed" as const,
  left: `${pos.value.left}px`,
  top: `${pos.value.top}px`,
  zIndex: 9999,
}));
</script>

<template>
  <Teleport to="body">
    <Transition name="tp-fade">
      <div
        v-if="visible"
        ref="popperRef"
        class="tp-popper"
        :style="popperStyle"
      >
        <slot />
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.tp-popper {
  pointer-events: auto;
  /* 限制子元素的 100% width 不会无限撑开 */
  max-width: 90vw;
}
</style>

<style>
.tp-fade-enter-active,
.tp-fade-leave-active {
  transition: opacity 0.12s ease, transform 0.12s ease;
}
.tp-fade-enter-from,
.tp-fade-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>
