<script setup lang="ts">
// AI 任务草稿预览组件（双数据源）
// 场景一（breakdown）：任务详情面板点「AI 拆解」→ 调 breakdownTask 获取子任务草稿
// 场景二（extract）：AI 助手弹窗粘贴文本 → 调 extractTasks 提取任务草稿
// → 展示可编辑列表（改标题/切优先级/删项）→ 用户确认后 emit 给父组件批量创建。
//
// 三态：loading（生成中）/ error（失败+重试）/ preview（可编辑列表）
// 视觉复用 TaskDetailPanel 检查项区的样式语言（透明 input + hover 变红删除按钮）。
import { ref, computed } from "vue";
import { IconRobot, IconClose } from "@arco-design/web-vue/es/icon";
import { breakdownTask, extractTasks, type ParsedSubtask } from "@/api/ai";
import PriorityDot from "@/components/PriorityDot.vue";
import { formatDueDate } from "@/utils/date";
import type { Priority } from "@/types";

/** 数据源：拆解（传 taskId）/ 提取（传 text） */
type PreviewSource =
  | { type: "breakdown"; taskId: string }
  | { type: "extract"; text: string };

const props = defineProps<{
  /** 数据源：决定调哪个 API + 文案 */
  source: PreviewSource;
}>();

const emit = defineEmits<{
  /** 用户确认 —— 把编辑后的任务列表传给父组件批量创建 */
  confirm: [subs: ParsedSubtask[]];
  /** 用户取消 / 关闭预览 */
  cancel: [];
}>();

/** 是否提取模式（文案跟随） */
const isExtract = computed(() => props.source.type === "extract");
/** 标题文案 */
const headerText = computed(() => (isExtract.value ? "AI 提取的任务" : "AI 拆解的子任务"));
/** 确认按钮文案 */
const confirmText = computed(() =>
  isExtract.value ? "全部创建为任务" : "全部创建为子任务",
);
/** 失败文案 */
const failText = computed(() => (isExtract.value ? "提取失败，请重试" : "拆解失败，请重试"));

/** 组件状态：idle（未请求）/ loading / error / preview */
const status = ref<"idle" | "loading" | "error" | "preview">("idle");
/** 错误信息（status=error 时） */
const errorMsg = ref("");
/** 预览的任务草稿列表（可编辑） */
const subtasks = ref<ParsedSubtask[]>([]);
/** 是否正在批量创建（父组件处理 confirm 期间） */
const creating = ref(false);

/** 优先级列表（用于点击切换） */
const PRIORITIES: Priority[] = [0, 1, 2, 3];

/** 调用 AI 获取任务草稿（按数据源分流） */
async function generate(): Promise<void> {
  status.value = "loading";
  errorMsg.value = "";
  const res =
    props.source.type === "breakdown"
      ? await breakdownTask(props.source.taskId)
      : await extractTasks(props.source.text);
  if (res.ok && res.subtasks && res.subtasks.length > 0) {
    subtasks.value = res.subtasks.map((s) => ({ ...s }));
    status.value = "preview";
  } else {
    errorMsg.value = res.message ?? failText.value;
    status.value = "error";
  }
}

/** 点击优先级圆点：循环切换 0→1→2→3→0 */
function cyclePriority(index: number): void {
  const cur = subtasks.value[index].priority;
  const nextIdx = (PRIORITIES.indexOf(cur as Priority) + 1) % PRIORITIES.length;
  subtasks.value[index].priority = PRIORITIES[nextIdx];
}

/** 删除某一项 */
function removeItem(index: number): void {
  subtasks.value.splice(index, 1);
  // 全删完直接关闭预览
  if (subtasks.value.length === 0) {
    emit("cancel");
  }
}

/** 确认：把编辑后的列表传给父组件 */
function onConfirm(): void {
  if (subtasks.value.length === 0 || creating.value) return;
  creating.value = true;
  // 过滤掉空标题项
  const valid = subtasks.value.filter((s) => s.title.trim());
  emit("confirm", valid);
}

/** 取消/关闭 */
function onCancel(): void {
  emit("cancel");
}

// 组件挂载即自动发起拆解（由父组件 v-if 控制挂载时机）
generate();
</script>

<template>
  <div class="ai-breakdown">
    <!-- 标题行 -->
    <div class="ai-breakdown__header">
      <icon-robot :size="14" />
      <span class="ai-breakdown__title">{{ headerText }}</span>
    </div>

    <!-- 加载中 -->
    <div v-if="status === 'loading'" class="ai-breakdown__loading">
      <a-spin :size="16" />
      <span>{{ isExtract ? "AI 正在提取任务..." : "AI 正在拆解任务..." }}</span>
    </div>

    <!-- 错误 -->
    <div v-else-if="status === 'error'" class="ai-breakdown__error">
      <span class="ai-breakdown__error-msg">{{ errorMsg }}</span>
      <a-button size="mini" @click="generate">重试</a-button>
    </div>

    <!-- 预览列表 -->
    <template v-else-if="status === 'preview'">
      <div class="ai-breakdown__list">
        <div
          v-for="(sub, i) in subtasks"
          :key="i"
          class="ai-breakdown__item"
        >
          <!-- 主行：优先级圆点（可点击切换） + 标题输入框 + 删除按钮 -->
          <div class="ai-breakdown__item-main">
            <button
              class="ai-breakdown__priority"
              :title="`优先级 ${sub.priority}（点击切换）`"
              @click="cyclePriority(i)"
            >
              <PriorityDot :priority="sub.priority as Priority" :size="10" />
            </button>
            <input
              v-model="sub.title"
              class="ai-breakdown__input"
              placeholder="子任务标题"
            />
            <button class="ai-breakdown__remove" @click="removeItem(i)">
              <icon-close :size="12" />
            </button>
          </div>
          <!-- 附加信息：日期提示 + 备注摘要 -->
          <div
            v-if="sub.dueEndAt || sub.note"
            class="ai-breakdown__item-meta"
          >
            <span
              v-if="formatDueDate(sub.dueStartAt, sub.dueEndAt)"
              class="ai-breakdown__date"
              :class="{
                'ai-breakdown__date--overdue': formatDueDate(sub.dueStartAt, sub.dueEndAt)?.overdue,
              }"
            >
              {{ formatDueDate(sub.dueStartAt, sub.dueEndAt)?.text }}
            </span>
            <span
              v-if="sub.note"
              class="ai-breakdown__note-summary"
              v-html="sub.note"
            ></span>
          </div>
        </div>
      </div>

      <!-- 底部操作 -->
      <div class="ai-breakdown__footer">
        <span class="ai-breakdown__count">{{ subtasks.length }} 个子任务</span>
        <div class="ai-breakdown__actions">
          <a-button size="small" :disabled="creating" @click="onCancel">取消</a-button>
          <a-button
            type="primary"
            size="small"
            :loading="creating"
            :disabled="subtasks.filter((s) => s.title.trim()).length === 0"
            @click="onConfirm"
          >
            {{ confirmText }}
          </a-button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.ai-breakdown {
  margin-top: 16px;
  padding: 12px;
  background: var(--jt-surface-sunken);
  border-radius: 8px;
  border: 1px solid var(--jt-border);
}

/* 标题行 */
.ai-breakdown__header {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
  color: var(--jt-primary);
  font-size: 13px;
  font-weight: 500;
}

/* 加载中 */
.ai-breakdown__loading {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 0;
  color: var(--jt-text-secondary);
  font-size: 13px;
}

/* 错误 */
.ai-breakdown__error {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
}
.ai-breakdown__error-msg {
  color: var(--jt-error);
  font-size: 13px;
  flex: 1;
}

/* 预览列表 */
.ai-breakdown__list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.ai-breakdown__item {
  padding: 4px 0;
  border-radius: 6px;
}

.ai-breakdown__item-main {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 优先级圆点按钮 */
.ai-breakdown__priority {
  border: none;
  background: transparent;
  cursor: pointer;
  padding: 2px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  border-radius: 50%;
  transition: transform 0.12s;
}
.ai-breakdown__priority:hover {
  transform: scale(1.25);
}

/* 标题输入框（透明无边框，复用检查项样式） */
.ai-breakdown__input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  font-family: var(--font-body);
  font-size: 13px;
  color: var(--jt-text-primary);
  padding: 4px 0;
  min-width: 0;
}
.ai-breakdown__input::placeholder {
  color: var(--jt-text-tertiary);
}

/* 删除按钮（hover 变红） */
.ai-breakdown__remove {
  width: 22px;
  height: 22px;
  border: none;
  background: transparent;
  border-radius: 4px;
  color: var(--jt-text-tertiary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transition: all 0.12s;
  flex-shrink: 0;
  padding: 0;
}
.ai-breakdown__item:hover .ai-breakdown__remove {
  opacity: 1;
}
.ai-breakdown__remove:hover {
  color: var(--jt-error);
  background: color-mix(in srgb, var(--jt-error) 10%, transparent);
}

/* 附加信息行 */
.ai-breakdown__item-meta {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-left: 20px;
  margin-top: 2px;
  flex-wrap: wrap;
}
.ai-breakdown__date {
  font-size: 11px;
  color: var(--jt-text-secondary);
  white-space: nowrap;
}
.ai-breakdown__date--overdue {
  color: var(--jt-error);
}
.ai-breakdown__note-summary {
  font-size: 11px;
  color: var(--jt-text-tertiary);
  line-height: 1.4;
  /* 限制单行省略，避免备注过长撑爆预览 */
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
}
.ai-breakdown__note-summary :deep(p) {
  margin: 0;
}

/* 底部操作 */
.ai-breakdown__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--jt-border);
}
.ai-breakdown__count {
  font-size: 12px;
  color: var(--jt-text-tertiary);
}
.ai-breakdown__actions {
  display: flex;
  gap: 8px;
}
</style>
