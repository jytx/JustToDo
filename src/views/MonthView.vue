<script setup lang="ts">
// 月视图 —— FullCalendar dayGridMonth
import FullCalendar from "@fullcalendar/vue3";
import dayGridPlugin from "@fullcalendar/daygrid";
import interactionPlugin from "@fullcalendar/interaction";
import { createCalendarOptions } from "@/composables/useCalendarView";

const options = createCalendarOptions("dayGridMonth");
options.plugins = [dayGridPlugin, interactionPlugin];
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