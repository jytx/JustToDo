<script setup lang="ts">
// 截止日期选择 chip —— 详情面板 / 主面板添加栏 / 快捷新建面板 共用
// 点击触发跟详情面板一致的 DatePopover（自建、滴答清单风格）
import { computed, ref } from "vue";
import { formatDueDate } from "@/utils/date";
import PropertyChip from "./PropertyChip.vue";
import Popover from "./Popover.vue";
import DatePopover from "./DatePopover.vue";

const props = defineProps<{
  /** 起始日期（本地时间字面量） */
  startIso: string | null;
  /** 结束日期（本地时间字面量） */
  endIso: string | null;
  /** 紧凑变体（用在小 footer / 主面板属性行内） */
  compact?: boolean;
  /** 弹层位置
   *  - bottom-* 默认（详情面板/主面板顶部 chip 用）
   *  - top-* 用于底部属性行（QuickAddDialog 的 chip 在弹窗底部，朝上开避免超窗）
   *  Popover 自身已实现"超出视口自动翻转"，所以传 bottom-left 也会自动适配 */
  placement?:
    | "bottom-left"
    | "bottom-right"
    | "bottom-center"
    | "top-left"
    | "top-right"
    | "top-center";
}>();

const emit = defineEmits<{
  /** 确认：传 [start, end]（任一可为 null） */
  confirm: [start: string | null, end: string | null];
  /** 清除 */
  clear: [];
}>();

const visible = ref(false);

/** 顶部 chip 显示文本 —— 复用详情面板的格式（今天 / 今天 14:00 / 周一 ~ 周二 等） */
const label = computed(() => {
  if (!props.startIso && !props.endIso) return "日期";
  return formatDueDate(props.startIso, props.endIso)?.text ?? "日期";
});

/** 是否处于已设置态（决定 chip 颜色高亮） */
const isSet = computed(() => Boolean(props.startIso || props.endIso));

/** chip 主色：今天 / 过期用错误色强调 */
const chipStyle = computed(() => {
  if (!isSet.value) return {};
  const info = formatDueDate(props.startIso, props.endIso);
  if (!info) return {};
  if (info.overdue) return { color: "var(--jt-error)" };
  if (info.isToday) return { color: "var(--jt-error)", fontWeight: "600" };
  return {};
});

function open() {
  visible.value = true;
}

function onConfirm(start: string | null, end: string | null) {
  emit("confirm", start, end);
  visible.value = false;
}

function onClear() {
  emit("clear");
  visible.value = false;
}
</script>

<template>
  <Popover v-model:visible="visible" :placement="props.placement ?? 'bottom-left'">
    <template #trigger>
      <PropertyChip
        :active="isSet"
        :compact="compact"
        :style="chipStyle"
        @click="open"
      >
        <template #icon>
          <icon-calendar :size="14" />
        </template>
        {{ label }}
      </PropertyChip>
    </template>
    <DatePopover
      :start-iso="startIso"
      :end-iso="endIso"
      @confirm="onConfirm"
      @clear="onClear"
    />
  </Popover>
</template>