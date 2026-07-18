<script setup lang="ts">
// 年视图 —— FullCalendar dayGridYear + 真实任务数据
// 顶部工具条由 CalendarToolbar 提供
import { computed, ref } from "vue";
import FullCalendar from "@fullcalendar/vue3";
import dayGridPlugin from "@fullcalendar/daygrid";
import interactionPlugin from "@fullcalendar/interaction";
import {
  createCalendarOptions,
  useCalendarCreateAction,
  useCalendarEvents,
  onCalendarEventClick,
} from "@/composables/useCalendarView";
import CalendarToolbar from "@/components/CalendarToolbar.vue";

const calendarRef = ref<InstanceType<typeof FullCalendar> | null>(null);

const { events, status, error, handleDatesSet } = useCalendarEvents();

const initialDate = (() => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
})();

const options = computed(() => ({
  ...createCalendarOptions("dayGridYear", initialDate, events.value),
  plugins: [dayGridPlugin, interactionPlugin],
  datesSet: handleDatesSet,
  eventClick: onCalendarEventClick,
}));

const title = ref<string>(`${initialDate.slice(0, 4)}年`);

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

/** + 新建：取当前视图区间起点（当年 1 月 1 日）作为预填日期，打开 QuickAddDialog */
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
