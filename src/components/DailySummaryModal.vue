<script setup lang="ts">
// AI 总结弹窗（每日/周报 + 清单/目录/多选，通用）
// 详见 discuss/2026-07-31-ai-daily-summary-design.md + 2026-07-31-ai-summary-scope-design.md
//
// 两种模式：
// - smart 模式（默认）：每日/周报，调 generateSummary(mode)，顶部有每日/周报切换
// - scope 模式：清单/目录/多选，调 generateScopeSummary(scope)，无切换 radio
//
// 超阈值裁剪：scope 模式下若返回 count > 设置阈值，弹确认是否裁剪
import { ref, watch, computed, nextTick } from "vue";
import { Message, Modal } from "@arco-design/web-vue";
import { marked } from "marked";
import { generateSummary, generateScopeSummary, type SummaryScope } from "@/api/ai";
import { useTaskStore } from "@/stores/task";
import { useSettingsStore } from "@/stores/settings";

const props = defineProps<{ visible: boolean }>();
const emit = defineEmits<{ "update:visible": [v: boolean] }>();

const taskStore = useTaskStore();
const settingsStore = useSettingsStore();

/** smart 模式下的每日/周报选择 */
type SmartMode = "daily" | "weekly";
const smartMode = ref<SmartMode>("daily");

/** 当前是否为 scope 模式（pendingSummaryScope 非 null） */
const currentScope = computed<SummaryScope | null>(() => taskStore.pendingSummaryScope);
const isScopeMode = computed(() => currentScope.value !== null);

/** 弹窗标题：随 scope 动态 */
const title = computed(() => {
  const scope = currentScope.value;
  if (!scope) return "AI 小结";
  if (scope.type === "tasks") return `选中 ${scope.ids.length} 项的总结`;
  return `${scope.name} 总结`;
});

/** 加载状态 */
const loading = ref(false);
/** 生成的 Markdown 文本 */
const content = ref("");
/** 错误信息 */
const errorMsg = ref("");
/** 范围为空提示（无任务/笔记，不需要调 AI） */
const isEmpty = ref(false);
/** 裁剪提示（若本次结果已裁剪） */
const truncatedHint = ref("");

/** 渲染后的 HTML（marked v18 parse 异步，用 watch 渲染到 ref） */
const renderedHtml = ref("");
watch(content, async (md) => {
  renderedHtml.value = md ? await marked.parse(md) : "";
});

/** 是否正在保存为笔记 */
const saving = ref(false);

/** 生成总结：按模式分发到不同 API */
async function generate(truncate = false): Promise<void> {
  // 去重：watch(visible) 和 watch(scope) 可能同时触发，避免重复调用导致重复提示
  if (generating) return;
  generating = true;
  try {
    loading.value = true;
    errorMsg.value = "";
    isEmpty.value = false;
    content.value = "";
    truncatedHint.value = "";

    const scope = currentScope.value;
    if (scope) {
      // scope 模式：调 generateScopeSummary
      const res = await generateScopeSummary(scope, truncate);
      loading.value = false;
      if (res.empty) {
        // 范围为空：toast 提示并关闭弹窗（不占用弹窗空间）。
        // 防抖：500ms 内重复的 empty 提示只显示一次（避免 watch 重复触发）
        const now = Date.now();
        if (now - lastEmptyToast > 500) {
          lastEmptyToast = now;
          Message.info(res.message ?? "该范围暂无内容");
        }
        emit("update:visible", false);
        return;
      }
      if (res.ok && res.content) {
        content.value = res.content;
        // 检查是否超阈值（未裁剪且 count > 阈值 → 弹确认）
        if (!truncate && typeof res.count === "number") {
          const threshold = settingsStore.aiSummaryTruncateThreshold;
          if (res.count > threshold) {
            askTruncate(res.count, threshold);
          }
        }
        if (res.truncated) {
          truncatedHint.value = `（已智能裁剪至重点任务，共 ${res.count} 项）`;
        }
      } else {
        errorMsg.value = res.message ?? "生成失败";
      }
    } else {
      // smart 模式：调 generateSummary
      const res = await generateSummary(smartMode.value);
      loading.value = false;
      if (res.ok && res.content) {
        content.value = res.content;
      } else {
        errorMsg.value = res.message ?? "生成失败";
      }
    }
  } finally {
    generating = false;
  }
}

/** 超阈值时弹确认：是否智能裁剪 */
function askTruncate(count: number, threshold: number): void {
  Modal.confirm({
    title: "任务数量较多",
    content: `该范围共 ${count} 项任务，全部总结可能较慢且消耗较多 token。是否智能裁剪至前 ${threshold} 项重点任务？`,
    okText: "智能裁剪",
    cancelText: "全量总结",
    onOk: () => {
      generate(true);
    },
    // 取消 = 全量保留（当前内容已是全量，无需重生成）
  });
}

/** smart 模式切换每日/周报 */
function onSmartModeChange(v: SmartMode): void {
  if (v === smartMode.value) return;
  smartMode.value = v;
  generate();
}

/** 重试 */
function onRetry(): void {
  generate();
}

/** 保存为笔记 */
async function onSaveAsNote(): Promise<void> {
  if (!content.value || saving.value) return;
  saving.value = true;
  try {
    const html = await marked.parse(content.value);
    const today = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const dateStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    // 标题随模式：smart 用每日/周报，scope 用范围名
    const scope = currentScope.value;
    const noteTitle = scope
      ? scope.type === "tasks"
        ? `任务总结 ${dateStr}`
        : `${scope.name} 总结 ${dateStr}`
      : smartMode.value === "weekly"
        ? `周报 ${dateStr}`
        : `每日小结 ${dateStr}`;
    const note = await taskStore.createTask({
      title: noteTitle,
      listId: "default-notebook",
      kind: "note",
    });
    await taskStore.updateTask(note.id, { note: html });
    Message.success(`已保存为笔记「${noteTitle}」`);
    emit("update:visible", false);
  } catch (e) {
    Message.error(`保存失败：${String(e)}`);
  } finally {
    saving.value = false;
  }
}

// ─── 触发逻辑（避免重复 generate 导致重复提示）───
// generating 标志：generate 是 async，期间再次触发（watch visible + scope 同时）直接跳过
let generating = false;
/** empty toast 防抖时间戳（避免重复触发显示多个提示） */
let lastEmptyToast = 0;

watch(
  () => props.visible,
  (v) => {
    if (v) {
      if (!generating) generate();
    } else {
      content.value = "";
      errorMsg.value = "";
      isEmpty.value = false;
      truncatedHint.value = "";
      smartMode.value = "daily";
      nextTick(() => {
        taskStore.pendingSummaryScope = null;
      });
    }
  },
);

// 弹窗已打开时，scope 变化重新生成（切清单/切目录场景）
watch(
  () => taskStore.pendingSummaryScope,
  (scope) => {
    if (props.visible && scope && !generating) {
      generate();
    }
  },
);
</script>

<template>
  <a-modal
    :visible="visible"
    :width="560"
    :footer="false"
    :mask-closable="true"
    :mask-style="{ backgroundColor: 'rgba(0,0,0,0.35)' }"
    modal-class="daily-summary-modal"
    wrap-class="daily-summary-wrap"
    @update:visible="(v: boolean) => emit('update:visible', v)"
  >
    <div class="daily-summary">
      <!-- 头部：标题 + smart 模式切换（仅 smart 模式显示 radio） -->
      <div class="daily-summary__header">
        <h2 class="daily-summary__title">{{ title }}</h2>
        <a-radio-group
          v-if="!isScopeMode"
          :model-value="smartMode"
          type="button"
          size="small"
          @change="(v: any) => onSmartModeChange(v as SmartMode)"
        >
          <a-radio value="daily">每日</a-radio>
          <a-radio value="weekly">周报</a-radio>
        </a-radio-group>
      </div>

      <!-- 内容区 -->
      <div class="daily-summary__body">
        <!-- 加载中 -->
        <div v-if="loading" class="daily-summary__loading">
          <a-spin />
          <span class="daily-summary__loading-text">AI 正在生成总结...</span>
        </div>

        <!-- 错误 / 空范围提示（空范围不显示重试按钮） -->
        <div v-else-if="errorMsg" class="daily-summary__error">
          <p class="daily-summary__error-msg">{{ errorMsg }}</p>
          <a-button v-if="!isEmpty" type="outline" size="small" @click="onRetry">重试</a-button>
        </div>

        <!-- 成功：渲染 Markdown -->
        <template v-else>
          <div v-if="truncatedHint" class="daily-summary__truncated-hint">
            ⚠️ {{ truncatedHint }}
          </div>
          <div class="daily-summary__content" v-html="renderedHtml"></div>
        </template>
      </div>

      <!-- 底部操作 -->
      <div v-if="!loading && !errorMsg && content" class="daily-summary__footer">
        <a-button
          type="outline"
          size="small"
          :loading="saving"
          @click="onSaveAsNote"
        >保存为笔记</a-button>
      </div>
    </div>
  </a-modal>
</template>

<style scoped>
.daily-summary {
  padding: 4px 0;
}

.daily-summary__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-bottom: 12px;
  border-bottom: 1px solid var(--jt-border);
  margin-bottom: 16px;
}

.daily-summary__title {
  font-family: var(--font-display);
  font-size: 17px;
  font-weight: 600;
  color: var(--jt-text-primary);
  margin: 0;
}

.daily-summary__body {
  min-height: 200px;
  max-height: 60vh;
  overflow-y: auto;
}

.daily-summary__loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 60px 0;
}

.daily-summary__loading-text {
  font-size: 13px;
  color: var(--jt-text-secondary);
}

.daily-summary__error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 40px 0;
}

.daily-summary__error-msg {
  font-size: 13px;
  color: var(--jt-error);
  margin: 0;
  text-align: center;
  word-break: break-word;
}

/* 裁剪提示条 */
.daily-summary__truncated-hint {
  font-size: 12px;
  color: var(--jt-text-tertiary);
  background-color: var(--jt-surface-hover);
  padding: 6px 10px;
  border-radius: 6px;
  margin-bottom: 10px;
}

.daily-summary__content {
  font-size: 14px;
  line-height: 1.7;
  color: var(--jt-text-primary);
}

.daily-summary__content :deep(h2) {
  font-family: var(--font-display);
  font-size: 15px;
  font-weight: 600;
  color: var(--jt-text-primary);
  margin: 16px 0 8px;
}

.daily-summary__content :deep(h2:first-child) {
  margin-top: 0;
}

.daily-summary__content :deep(p) {
  margin: 6px 0;
}

.daily-summary__content :deep(ul),
.daily-summary__content :deep(ol) {
  margin: 6px 0;
  padding-left: 20px;
}

.daily-summary__content :deep(li) {
  margin: 2px 0;
}

.daily-summary__content :deep(strong) {
  font-weight: 600;
}

.daily-summary__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 12px;
  border-top: 1px solid var(--jt-border);
  margin-top: 12px;
}
</style>
