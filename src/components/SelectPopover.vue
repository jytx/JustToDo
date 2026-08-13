<script setup lang="ts">
// 统一风格的 Select 下拉 —— 无边框、hover 加深底色、宽高随内容自适应
// （同滴答清单：内容多宽控件多宽，高度 26 紧凑），
// 右侧为细线条上下双三角图标（Lucide chevrons-up-down 风格），
// 弹层复用 MenuPopover / MenuPopoverItem，
// 与清单更多 / 标签删除 / 优先级 / 标题级别 / 排序 等所有下拉视觉语言一致。
// 空值（modelValue 为空）时显示占位符「请选择」，选中后显示选中项 —— 同滴答清单。
//
// 用法：
//   <SelectPopover
//     v-model="value"
//     :options="[{ value: 'a', label: 'A' }]"
//     :width="200"
//   />
import { computed, ref } from "vue";
import { IconPlayArrow } from "@arco-design/web-vue/es/icon";
import MenuPopover from "./MenuPopover.vue";
import MenuPopoverItem from "./MenuPopoverItem.vue";

/** 选项：previewable 为 true 时右侧显示播放图标，点击触发 preview 事件（试听） */
type Option = { value: string; label: string; previewable?: boolean };

const props = withDefaults(
  defineProps<{
    /** 当前选中值（v-model） */
    modelValue: string;
    /** 选项列表（value 用 string；外部可用 String() 转） */
    options: Option[];
    /** 触发器最大宽度（默认 220px）。实际宽度随内容自适应，仅超长选项才触达此上限 */
    width?: number | string;
    /** 占位文本（modelValue 为空时显示） */
    placeholder?: string;
    /** 禁用态：灰显，不响应点击 */
    disabled?: boolean;
  }>(),
  { width: 200, placeholder: "请选择", disabled: false },
);

const emit = defineEmits<{
  "update:modelValue": [value: string];
  /** 点击选项右侧播放图标（试听），值是该选项的 value */
  preview: [value: string];
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
        :class="{
          'select-popover__trigger--disabled': disabled,
          'select-popover__trigger--open': open,
        }"
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
        <!-- 细线条上下双三角（Lucide chevrons-up-down 风格，同滴答清单 iconfont） -->
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="select-popover__arrow"
        >
          <path d="m7 9 5-4 5 4" />
          <path d="m7 15 5 4 5-4" />
        </svg>
      </button>
    </template>

    <MenuPopoverItem
      v-for="opt in options"
      :key="opt.value"
      :active="opt.value === modelValue"
      @click="selectOption(opt.value)"
    >
      {{ opt.label }}
      <!-- 可试听选项：右侧播放图标，点击只播放不选中（stopPropagation 由 tail 处理） -->
      <template v-if="opt.previewable" #tail>
        <icon-play-arrow
          :size="14"
          class="select-popover__preview"
          @click.stop="emit('preview', opt.value)"
        />
      </template>
    </MenuPopoverItem>
  </MenuPopover>
</template>

<style scoped>
.select-popover__trigger {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  /* 宽度随内容自适应（同滴答清单），width prop 作 max-width 兜底防超长选项撑爆 */
  width: fit-content;
  max-width: var(--select-width, 220px);
  height: 26px;
  padding: 0 8px;
  /* 无边框无底色（同滴答清单），hover 才加深底色 */
  border: none;
  background-color: transparent;
  border-radius: 6px;
  font-size: 13px;
  font-family: var(--font-body);
  color: var(--jt-text-primary);
  cursor: pointer;
  transition: background-color 0.12s, box-shadow 0.12s;
}

/* hover：加深底色（比输入控件更轻的反馈） */
.select-popover__trigger:hover:not(:disabled) {
  background-color: var(--jt-surface-hover);
}
.select-popover__trigger:focus-visible {
  outline: none;
  /* 无边框控件 focus 用主色软环指示（与输入控件同语言） */
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--jt-primary) 20%, transparent);
}

.select-popover__trigger--disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.select-popover__value {
  /* 内容流内排列（自适应宽度），超长截断兜底 */
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.select-popover__value--placeholder {
  color: var(--jt-text-tertiary);
}

/* 细线条上下双三角：紧凑贴文字（同滴答清单 6px 级间距） */
.select-popover__arrow {
  width: 12px;
  height: 12px;
  margin-left: 5px;
  flex-shrink: 0;
  color: var(--jt-text-tertiary);
}

/* 展开时上三角变主色，提示"收起"方向（原单箭头旋转动画的替代反馈） */
.select-popover__trigger--open .select-popover__arrow path:first-child {
  stroke: var(--jt-primary);
}

/* 选项右侧试听图标：淡灰，hover 主题色 */
.select-popover__preview {
  color: var(--jt-text-tertiary);
  cursor: pointer;
  transition: color 0.12s;
}
.select-popover__preview:hover {
  color: var(--jt-primary);
}
</style>
