<script setup lang="ts">
// 月视图 —— FullCalendar dayGridMonth + 真实任务数据
// 顶部工具条由 CalendarToolbar 提供
import { computed, ref, watch } from "vue";
import FullCalendar from "@fullcalendar/vue3";
import dayGridPlugin from "@fullcalendar/daygrid";
import interactionPlugin from "@fullcalendar/interaction";
import {
  createCalendarOptions,
  useCalendarCreateAction,
  useCalendarEvents,
  onCalendarEventClick,
  onCalendarEventChange,
  onCalendarDateClick,
  onCalendarSelect,
} from "@/composables/useCalendarView";
import { useTaskStore } from "@/stores/task";
import CalendarToolbar from "@/components/CalendarToolbar.vue";

const calendarRef = ref<InstanceType<typeof FullCalendar> | null>(null);
const taskStore = useTaskStore();

/** 真实任务事件 + 加载状态（选中态与 taskStore.selectedTaskId 同步；title 由 datesSet 同步） */
const { events, status, error, title, handleDatesSet, applySelection } = useCalendarEvents(
  () => taskStore.selectedTaskId,
);

// 选中任务变化时只重算 events 上的选中 className（不重拉 DB）
watch(
  () => taskStore.selectedTaskId,
  () => applySelection(),
);

/** 初始日期：默认今天（前端 Date → YYYY-MM-DD） */
const initialDate = (() => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
})();

/** FullCalendar options —— events 反应式跟随数据；标题用 view.title 同步（详见上方 notes） */
const options = computed(() => {
  const opts = createCalendarOptions("dayGridMonth", initialDate, events.value);
  // createCalendarOptions 不接受 plugins（避免与 useCalendarEvents 的事件循环耦合），
  // 在此补齐：插件 + 钩子
  return {
    ...opts,
    plugins: [dayGridPlugin, interactionPlugin],
    datesSet: handleDatesSet,
    eventClick: onCalendarEventClick,
    eventDrop: (info: Parameters<typeof onCalendarEventChange>[0]) =>
      onCalendarEventChange(info, () => getApi()),
    eventResize: (info: Parameters<typeof onCalendarEventChange>[0]) =>
      onCalendarEventChange(info, () => getApi()),
    dateClick: onCalendarDateClick,
    select: onCalendarSelect,
    selectable: true,
    // selectMinDistance: 区分"拖事件"和"拖空白创建选区"
    // 0 距离时按下：FC 优先识别为 eventClick（单天任务小 hit area 会先触发 select 起点 → 误判）
    // 设 8px：用户先在事件上按下没移动 = 视为 event；移动 8px+ = 视为 select
    // 解决"单天任务拖不了"问题
    selectMinDistance: 8,
  };
});

/** 拿到 FullCalendar API（用于 toolbar 触发 today/prev/next/goto） */
function getApi() {
  return calendarRef.value?.getApi() ?? null;
}

function onToday(): void {
  getApi()?.today();
}
function onPrev(): void {
  getApi()?.prev();
}
function onNext(): void {
  getApi()?.next();
}
/** 跳转到指定日期（FC 按当前视图类型定位：月视图跳到该月） */
function onGoto(date: Date): void {
  getApi()?.gotoDate(date);
}

/** + 新建：取当前视图区间起点（当月 1 号）作为预填日期，打开 QuickAddDialog */
const onCreate = useCalendarCreateAction(getApi);
</script>

<template>
  <div class="calendar-view">
    <CalendarToolbar
      :calendar-api="getApi()"
      :title="title"
      @today="onToday"
      @prev="onPrev"
      @next="onNext"
      @goto="onGoto"
      @create="onCreate"
    />
    <div class="calendar-view__body">
      <div v-if="status === 'loading'" class="calendar-view__status">
        加载中…
      </div>
      <div
        v-else-if="status === 'error'"
        class="calendar-view__status calendar-view__status--error"
      >
        加载失败：{{ error }}
      </div>
      <FullCalendar ref="calendarRef" :options="options" />
    </div>
  </div>
</template>

<style scoped>
.calendar-view {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.calendar-view__body {
  flex: 1;
  padding: 16px 24px;
  overflow: hidden;
  position: relative;
}

.calendar-view__status {
  position: absolute;
  top: 16px;
  right: 32px;
  z-index: 5;
  padding: 4px 10px;
  border-radius: 6px;
  background-color: var(--jt-surface-sunken);
  color: var(--jt-text-secondary);
  font-size: 12px;
  pointer-events: none;
}

.calendar-view__status--error {
  background-color: rgba(239, 68, 68, 0.12);
  color: var(--jt-error);
}
</style>

