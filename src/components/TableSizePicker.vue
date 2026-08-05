<script setup lang="ts">
// 表格行列选择器 —— hover 划选 N×N 网格（Word/Notion 风格）。
// 用在工具栏表格按钮、斜杠菜单、块手柄菜单的「表格」入口。
import { ref, computed } from "vue";

/** 最大可选行列数（10×10） */
const MAX = 10;
/** 每个格子的 px 尺寸 */
const CELL = 16;

const props = defineProps<{
  /** 选择 (rows, cols) 后回调（由调用方执行 insertTable） */
  onPick: (rows: number, cols: number) => void;
}>();

/** 当前 hover 的行列（0 = 未 hover） */
const hoverRows = ref(0);
const hoverCols = ref(0);

/** 网格 1..MAX × 1..MAX */
const cells = computed(() => {
  const arr: { r: number; c: number }[] = [];
  for (let r = 1; r <= MAX; r++) {
    for (let c = 1; c <= MAX; c++) {
      arr.push({ r, c });
    }
  }
  return arr;
});

/** 底部提示文案，如「3 × 4 表格」 */
const label = computed(() =>
  hoverRows.value > 0 && hoverCols.value > 0
    ? `${hoverRows.value} × ${hoverCols.value} 表格`
    : "拖动选择行列",
);

/** hover 到某个格子：更新当前行列 */
function onCellHover(r: number, c: number): void {
  hoverRows.value = r;
  hoverCols.value = c;
}

/** 点击格子：确认选择 */
function onCellClick(r: number, c: number): void {
  props.onPick(r, c);
}

/** 鼠标离开整个选择器：重置 */
function onLeave(): void {
  hoverRows.value = 0;
  hoverCols.value = 0;
}
</script>

<template>
  <div class="table-size-picker" @mouseleave="onLeave">
    <div class="table-size-picker__grid" :style="{ width: MAX * CELL + 'px' }">
      <div
        v-for="cell in cells"
        :key="`${cell.r}-${cell.c}`"
        class="table-size-picker__cell"
        :class="{ 'table-size-picker__cell--active': cell.r <= hoverRows && cell.c <= hoverCols }"
        @mouseenter="onCellHover(cell.r, cell.c)"
        @click="onCellClick(cell.r, cell.c)"
      />
    </div>
    <div class="table-size-picker__label">{{ label }}</div>
  </div>
</template>

<style scoped>
.table-size-picker {
  padding: 8px 10px 6px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}
.table-size-picker__grid {
  display: grid;
  grid-template-columns: repeat(10, 16px);
  grid-template-rows: repeat(10, 16px);
  gap: 2px;
}
.table-size-picker__cell {
  width: 16px;
  height: 16px;
  border: 1px solid var(--jt-border);
  border-radius: 2px;
  background: transparent;
  cursor: pointer;
  transition: background-color 0.08s, border-color 0.08s;
}
.table-size-picker__cell:hover {
  border-color: var(--jt-primary);
}
/* hover 范围内的格子（左上角到当前格子）填充主色 */
.table-size-picker__cell--active {
  background: color-mix(in srgb, var(--jt-primary) 35%, transparent);
  border-color: var(--jt-primary);
}
.table-size-picker__label {
  font-size: 12px;
  color: var(--jt-text-secondary);
  font-family: var(--font-body);
  user-select: none;
}
</style>
