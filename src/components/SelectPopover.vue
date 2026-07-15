<script setup lang="ts">
// 统一风格的 Select 下拉 —— 沿用 Arco a-select 的 trigger 外观（200px 高 32，
// 灰边灰底、圆角、右侧下拉箭头），弹层复用 MenuPopover / MenuPopoverItem，
// 与清单更多 / 标签删除 / 优先级 / 标题级别 / 排序 等所有下拉视觉语言一致。
//
// 用法：
//   <SelectPopover
//     v-model="value"
//     :options="[{ value: 'a', label: 'A' }]"
//     :width="200"
//   />
import { computed, ref } from "vue";
import { IconDown } from "@arco-design/web-vue/es/icon";
import MenuPopover from "./MenuPopover.vue";
import MenuPopoverItem from "./MenuPopoverItem.vue";

type Option = { value: string; label: string };

const props = withDefaults(
  defineProps<{
    /** 当前选中值（v-model） */
    modelValue: string;
    /** 选项列表（value 用 string；外部可用 String() 转） */
    options: Option[];
    /** 触发器宽度，默认 200px */
    width?: number | string;
    /** 占位文本（modelValue 为空时显示） */
    placeholder?: string;
    /** 禁用态：灰显，不响应点击 */
    disabled?: boolean;
  }>(),
  { width: 200, placeholder: "", disabled: false },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
}>();

const open = ref(false);

/** 当前选中项的 label，用于 trigger 显示 */
const currentLabel = computed(() => {
  const hit = props.options.find((o) => o.value === props.modelValue);
  return hit?.label ?? props.placeholder ?? "";
});

function selectOption(value: string) {
  if (props.disabled) return;
  if (value === props.modelValue) {
    open.value = false;
    return;
  }
  emit("update:modelValue", value);
  open.value = false;
}

function onTriggerClick() {
  if (props.disabled) return;
  open.value = !open.value;
}
</script>

<template>
  <MenuPopover v-model:visible="open" placement="bottom-left">
    <template #trigger>
      <!--
        trigger 是 <button>，可获焦 + Enter/Space 触发；
        width 通过 CSS 变量传入，避开 :style inline 写法
      -->
      <button
        type="button"
        class="select-popover__trigger"
        :class="{ 'select-popover__trigger--disabled': disabled }"
        :style="{ '--select-width': typeof width === 'number' ? `${width}px` : width }"
        :disabled="disabled"
        @click="onTriggerClick"
      >
        <span
          class="select-popover__value"
          :class="{ 'select-popover__value--placeholder': !modelValue && !currentLabel }"
        >
          {{ currentLabel || modelValue || placeholder }}
        </span>
        <icon-down :size="14" class="select-popover__arrow" />
      </button>
    </template>

    <MenuPopoverItem
      v-for="opt in options"
      :key="opt.value"
      :active="opt.value === modelValue"
      @click="selectOption(opt.value)"
    >
      {{ opt.label }}
    </MenuPopoverItem>
  </MenuPopover>
</template>

<style scoped>
.select-popover__trigger {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  width: var(--select-width, 200px);
  height: 32px;
  padding: 0 12px;
  border: 1px solid var(--color-border-2);
  background-color: var(--color-bg-2);
  border-radius: 4px;
  font-size: 13px;
  font-family: var(--font-body);
  color: var(--jt-text-primary);
  cursor: pointer;
  transition: border-color 0.12s, box-shadow 0.12s;
}

/* hover：边框加到一个明显的浅灰，背景保持白（与输入控件同语言） */
.select-popover__trigger:hover:not(:disabled) {
  border-color: var(--jt-text-tertiary);
  background-color: var(--color-bg-2);
}
.select-popover__trigger:focus-visible {
  outline: none;
  border-color: var(--jt-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--jt-primary) 20%, transparent);
}

.select-popover__trigger--disabled {
  cursor: not-allowed;
  opacity: 0.5;
  background-color: var(--color-bg-3);
}

.select-popover__value {
  flex: 1;
  text-align: left;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.select-popover__value--placeholder {
  color: var(--jt-text-tertiary);
}

.select-popover__arrow {
  margin-left: 8px;
  flex-shrink: 0;
  color: var(--jt-text-tertiary);
  transition: transform 0.18s;
}

/* 展开时箭头翻转 */
.select-popover__trigger[aria-expanded="true"] .select-popover__arrow {
  transform: rotate(180deg);
}
</style>
