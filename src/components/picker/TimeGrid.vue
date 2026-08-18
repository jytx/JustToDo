<script setup lang="ts">
// 时分选择网格 —— DatePopover / ReminderPopover 共用的时刻选择器
// 布局：左「时」右「分」两列并排，各 4 列网格、固定行高（不滚动）
// 纯受控：当前时分由外部传入，点选回调外部处理（不直接改状态）
defineProps<{
  /** 当前选中的小时（0-23） */
  hour: number;
  /** 当前选中的分钟（5 步进，0-55） */
  minute: number;
}>();

const emit = defineEmits<{
  selectHour: [hour: number];
  selectMinute: [minute: number];
}>();

/** 小时 0-23 */
const HOUR_OPTIONS: number[] = Array.from({ length: 24 }, (_, i) => i);
/** 分钟 0-55，5 步进 */
const MINUTE_OPTIONS: number[] = Array.from({ length: 12 }, (_, i) => i * 5);

/** 补零到两位（如 5 → "05"） */
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
</script>

<template>
  <div class="tg">
    <!-- 时列：24 项 / 4 列 = 6 行 -->
    <div class="tg__col tg__col--hour">
      <button
        v-for="h in HOUR_OPTIONS"
        :key="h"
        type="button"
        class="tg__cell"
        :class="{ 'tg__cell--selected': h === hour }"
        @click="emit('selectHour', h)"
      >
        {{ pad2(h) }}
      </button>
    </div>
    <!-- 分列：12 项 / 4 列 = 3 行 -->
    <div class="tg__col tg__col--minute">
      <button
        v-for="m in MINUTE_OPTIONS"
        :key="m"
        type="button"
        class="tg__cell"
        :class="{ 'tg__cell--selected': m === minute }"
        @click="emit('selectMinute', m)"
      >
        {{ pad2(m) }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.tg {
  display: flex;
  gap: 4px;
  max-height: 156px;
  overflow: hidden;
  border: 1px solid var(--jt-border);
  border-radius: 6px;
  padding: 4px 2px;
}

.tg__col {
  flex: 1;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 0 2px;
  overflow: hidden;
}

/* 小时列：24 项 / 4 列 = 6 行，row 15px、gap 2px → 总 6*15 + 5*2 = 100px，
   picker max-height 156px 内不滚动。cell 拉伸贴满行。 */
.tg__col--hour {
  grid-template-rows: repeat(6, 15px);
}

/* 分钟列：12 项 / 4 列 = 3 行，row 30px、gap 2px → 总 3*30 + 2*2 = 94px，
   cell 高度固定 18px + 垂直居中，上下留白让"色块"漂在行中央。 */
.tg__col--minute {
  grid-template-rows: repeat(3, 30px);
}

.tg__cell {
  border: none;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 3px;
  font-size: 10px;
  color: var(--jt-text-primary);
  cursor: pointer;
  font-family: var(--font-mono);
  background: transparent;
  transition: background-color 0.1s, color 0.1s;
}

/* 小时列 cell：拉伸贴满行（无上下留白，6 行紧凑一屏） */
.tg__col--hour .tg__cell {
  height: 12px;
  align-self: stretch;
  justify-self: stretch;
}

/* 分钟列 cell：高度固定 18px（不被行高撑开），行内垂直居中 */
.tg__col--minute .tg__cell {
  height: 18px;
  align-self: center;
  justify-self: stretch;
}

.tg__cell:hover {
  background: var(--jt-surface-sunken);
}

.tg__cell--selected {
  background: var(--jt-primary);
  color: #fff;
  font-weight: 500;
}

.tg__cell--selected:hover {
  background: var(--jt-primary);
  color: #fff;
}
</style>
