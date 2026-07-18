<script setup lang="ts">
// 周视图 —— FullCalendar timeGridWeek
// 顶部工具条复用 FullCalendar 自带的 prev/next/today + 标题
import FullCalendar from "@fullcalendar/vue3";
import timeGridPlugin from "@fullcalendar/timegrid";
import interactionPlugin from "@fullcalendar/interaction";
import { createCalendarOptions } from "@/composables/useCalendarView";

const options = createCalendarOptions("timeGridWeek");
options.plugins = [timeGridPlugin, interactionPlugin];
</script>

<template>
  <div class="calendar-view">
    <FullCalendar :options="options" />
  </div>
</template>

<style scoped>
.calendar-view {
  padding: 16px 24px;
  height: 100%;
  overflow: hidden;
}
</style>