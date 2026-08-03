<script setup lang="ts">
// 日历视图顶部工具条 —— 月/周/年 三个视图共用
// 布局（仿滴答清单 / Notion）：
//   左侧：📅 标题（点击弹月历，选某天跳转）
//   右侧：+ 新建  视图下拉（周/月/年）  ‹ 今天 ›
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { IconPlus, IconLeft, IconRight, IconDown } from "@arco-design/web-vue/es/icon";
import type { CalendarApi } from "@fullcalendar/core";
import Popover from "@/components/Popover.vue";
import MiniCalendar from "@/components/MiniCalendar.vue";

const props = defineProps<{
  /** FullCalendar API 引用（父组件从 ref 传入） */
  calendarApi: CalendarApi | null;
  /** 当前视图显示的标题（FC view.title，如 "2026年7月"） */
  title: string;
}>();

const emit = defineEmits<{
  (e: "today"): void;
  (e: "prev"): void;
  (e: "next"): void;
  (e: "create"): void;
  /** 跳转到指定日期（FC api.gotoDate，按当前视图类型定位） */
  (e: "goto", date: Date): void;
}>();

const route = useRoute();
const router = useRouter();

/** 当前日历视图名称 */
type CalendarView = "dayGridMonth" | "timeGridWeek" | "dayGridYear";
const currentView = computed<CalendarView>(() => {
  const name = route.name as string;
  if (name === "week") return "timeGridWeek";
  if (name === "year") return "dayGridYear";
  return "dayGridMonth";
});

/** 视图下拉 */
const viewMenuOpen = ref(false);

function switchView(view: CalendarView): void {
  if (view === currentView.value) {
    viewMenuOpen.value = false;
    return;
  }
  if (view === "timeGridWeek") router.push("/week");
  else if (view === "dayGridYear") router.push("/year");
  else router.push("/month");
  viewMenuOpen.value = false;
}

const viewMenuItems: Array<{ view: CalendarView; label: string; shortcut: string }> = [
  { view: "timeGridWeek", label: "周", shortcut: "W" },
  { view: "dayGridMonth", label: "月", shortcut: "M" },
  { view: "dayGridYear", label: "年", shortcut: "Y" },
];

// ─── 标题点击 → 弹日期选择器跳转 ──────────────────────
const pickerVisible = ref(false);
/** 月历光标（当前显示哪个月），打开弹层时初始化为 FC 当前焦点日期所在月 */
const pickerMonth = ref(new Date());

/** FC 当前焦点日期（用作选择器的高亮选中） */
const cursorDate = computed<Date | null>(() => {
  return props.calendarApi?.getDate() ?? null;
});

/**
 * 选择器粒度：与当前视图匹配。
 *   周（timeGridWeek）→ day（选某天跳到那周）
 *   月（dayGridMonth）→ month（选某月）
 *   年（dayGridYear） → year（选某年）
 */
const pickerMode = computed<"day" | "month" | "year">(() => {
  if (currentView.value === "dayGridYear") return "year";
  if (currentView.value === "dayGridMonth") return "month";
  return "day";
});

/** 打开弹层时把选择器光标对齐到当前焦点日期 */
watch(pickerVisible, (v) => {
  if (v) {
    const d = props.calendarApi?.getDate() ?? new Date();
    pickerMonth.value = new Date(d.getFullYear(), d.getMonth(), 1);
  }
});

/** 选某天/某月/某年 → emit goto 让父组件跳转，并关闭弹层 */
function onPickDate(date: Date): void {
  emit("goto", date);
  pickerVisible.value = false;
}
</script>

<template>
  <div class="cal-toolbar">
    <!-- 左侧：标题（点击弹月历选日期跳转） -->
    <div class="cal-toolbar__date">
      <Popover v-model:visible="pickerVisible" placement="bottom-left">
        <template #trigger>
          <!-- Popover 不自动切换 visible，需在 trigger 上手动 toggle -->
          <button
            type="button"
            class="cal-toolbar__date-title"
            :title="'点击选择日期'"
            @click="pickerVisible = !pickerVisible"
          >
            <span>{{ title }}</span>
            <icon-down :size="14" class="cal-toolbar__date-caret" />
          </button>
        </template>
        <MiniCalendar
          :selected="cursorDate"
          :mode="pickerMode"
          v-model:month="pickerMonth"
          @select="onPickDate"
        />
      </Popover>
    </div>

    <!-- 右侧：新建 / 视图下拉 / 今天 / 更多 -->
    <div class="cal-toolbar__actions">
      <a-button
        type="text"
        size="small"
        :title="'新建任务'"
        @click="emit('create')"
      >
        <template #icon><icon-plus :size="20" /></template>
      </a-button>

      <!-- 视图下拉 -->
      <a-dropdown v-model:popup-visible="viewMenuOpen" trigger="click">
        <a-button size="small" class="cal-toolbar__view-btn">
          {{ viewMenuItems.find((v) => v.view === currentView)?.label }}
          <span class="cal-toolbar__chevron">▾</span>
        </a-button>
        <template #content>
          <a-doption
            v-for="item in viewMenuItems"
            :key="item.view"
            :value="item.view"
            @click="switchView(item.view)"
          >
            <span class="cal-toolbar__menu-label">{{ item.label }}</span>
            <span class="cal-toolbar__menu-shortcut">{{ item.shortcut }}</span>
          </a-doption>
        </template>
      </a-dropdown>

      <a-button
        type="text"
        size="small"
        :title="'上一段'"
        @click="emit('prev')"
      >
        <template #icon><icon-left :size="16" /></template>
      </a-button>
      <a-button
        size="small"
        class="cal-toolbar__today-btn"
        @click="emit('today')"
      >
        今天
      </a-button>
      <a-button
        type="text"
        size="small"
        :title="'下一段'"
        @click="emit('next')"
      >
        <template #icon><icon-right :size="16" /></template>
      </a-button>
    </div>
  </div>
</template>

<style scoped>
.cal-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 24px;
  height: 56px;
  border-bottom: 1px solid var(--jt-border);
  background-color: var(--jt-surface);
  -webkit-app-region: drag;
}

.cal-toolbar__date,
.cal-toolbar__actions {
  -webkit-app-region: no-drag;
  display: flex;
  align-items: center;
  gap: 4px;
}

.cal-toolbar__date-title {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: none;
  background: transparent;
  padding: 4px 6px;
  margin: 0;
  border-radius: 6px;
  font-size: 20px;
  font-weight: 700;
  color: var(--jt-text-primary);
  letter-spacing: 0.2px;
  line-height: 1.2;
  cursor: pointer;
  font-family: inherit;
}

.cal-toolbar__date-title:hover {
  background-color: var(--jt-surface-sunken);
}

.cal-toolbar__date-caret {
  color: var(--jt-text-tertiary);
  transition: transform 0.15s;
}

.cal-toolbar__date-title:hover .cal-toolbar__date-caret {
  color: var(--jt-text-secondary);
}

.cal-toolbar__view-btn {
  display: flex;
  align-items: center;
  gap: 4px;
}

.cal-toolbar__today-btn {
  font-weight: 500;
}

.cal-toolbar__menu-label {
  display: inline-block;
  min-width: 40px;
}

.cal-toolbar__menu-shortcut {
  margin-left: 16px;
  color: var(--jt-text-tertiary);
  font-size: 12px;
  font-family: var(--font-mono, monospace);
}
</style>