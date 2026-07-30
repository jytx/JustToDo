<script setup lang="ts">
// 子任务进度条 —— 在任务行内显示一条细横条，按完成比例填充，旁边配 done/total 文字
// 进度仅统计「直接子任务」（一层），不递归多层，避免嵌套语义模糊
import { computed } from "vue";

const props = withDefaults(
  defineProps<{
    /** 已完成的直接子任务数 */
    doneCount: number;
    /** 直接子任务总数 */
    totalCount: number;
    /** 实体类型文案（任务 / 笔记），默认"子任务" */
    label?: string;
  }>(),
  { label: "子任务" },
);

/** 完成百分比（0–100）；totalCount 为 0 时返回 0，避免除零 */
const percent = computed(() => {
  if (props.totalCount <= 0) return 0;
  return Math.round((props.doneCount / props.totalCount) * 100);
});

/** 是否全部完成（进度条变绿） */
const allDone = computed(
  () => props.totalCount > 0 && props.doneCount >= props.totalCount,
);

/** 填充宽度（用于内联 style，带 % 单位） */
const fillWidth = computed(() => `${percent.value}%`);
</script>

<template>
  <span
    class="subtask-progress"
    :class="{ 'subtask-progress--done': allDone }"
    :title="`${doneCount}/${totalCount} 个${label}（${percent}%）`"
  >
    <span class="subtask-progress__track">
      <span class="subtask-progress__fill" :style="{ width: fillWidth }" />
    </span>
    <span class="subtask-progress__text">{{ doneCount }}/{{ totalCount }}</span>
  </span>
</template>

<style scoped>
.subtask-progress {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

/* 轨道：固定宽度的细横条容器，高度 3px，圆角，半透明底色 */
.subtask-progress__track {
  display: inline-block;
  width: 40px;
  height: 3px;
  border-radius: 2px;
  background-color: color-mix(in srgb, var(--jt-text-tertiary) 25%, transparent);
  overflow: hidden;
}

/* 填充条：宽度随百分比变化，默认用主色，0% 时仍渲染（宽度为 0 不占可见空间） */
.subtask-progress__fill {
  display: block;
  height: 100%;
  border-radius: 2px;
  background-color: var(--jt-primary);
  /* 宽度过渡，切换完成状态时填充更顺滑 */
  transition: width 0.25s ease, background-color 0.25s ease;
}

/* 全部完成时：填充变绿，强化"完成"语义 */
.subtask-progress--done .subtask-progress__fill {
  background-color: var(--jt-success);
}

/* 计数文字：小号、次要色，与现有 meta 区文字一致 */
.subtask-progress__text {
  font-size: 12px;
  line-height: 1;
  color: var(--jt-text-secondary);
  white-space: nowrap;
}

/* 全部完成时文字也轻微强调（变绿） */
.subtask-progress--done .subtask-progress__text {
  color: var(--jt-success);
}
</style>
