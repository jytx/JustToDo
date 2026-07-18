<script setup lang="ts">
// 年视图 —— FullCalendar dayGridYear
// 顶部工具条由 CalendarToolbar 提供
import { ref } from "vue";
import FullCalendar from "@fullcalendar/vue3";
import dayGridPlugin from "@fullcalendar/daygrid";
import interactionPlugin from "@fullcalendar/interaction";
import {
  createCalendarOptions,
  useCalendarCreateAction,
} from "@/composables/useCalendarView";
import CalendarToolbar from "@/components/CalendarToolbar.vue";

const calendarRef = ref<InstanceType<typeof FullCalendar> | null>(null);
const options = createCalendarOptions("dayGridYear");
options.plugins = [dayGridPlugin, interactionPlugin];

const title = ref<string>(String(options.initialDate ?? ""));

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
}
</style>