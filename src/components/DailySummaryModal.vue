<script setup lang="ts">
// 每日小结 / 周报 AI 弹窗
// 详见 discuss/2026-07-31-ai-daily-summary-design.md
//
// 交互：打开自动生成 → 展示 Markdown → 可切换每日/周报（重新生成）→ 可保存为笔记
// 依赖：src/api/ai.ts（generateSummary）、marked（Markdown→HTML）、task store（存为笔记）
import { ref, watch } from "vue";
import { Message } from "@arco-design/web-vue";
import { marked } from "marked";
import { generateSummary } from "@/api/ai";
import { useTaskStore } from "@/stores/task";

const props = defineProps<{ visible: boolean }>();
const emit = defineEmits<{ "update:visible": [v: boolean] }>();

const taskStore = useTaskStore();

/** 模式：每日 | 周报 */
type SummaryMode = "daily" | "weekly";
const mode = ref<SummaryMode>("daily");

/** 加载状态 */
const loading = ref(false);
/** 生成的 Markdown 文本（成功后填充） */
const content = ref("");
/** 错误信息（失败时填充） */
const errorMsg = ref("");

/** 渲染后的 HTML（用于 v-html 展示）。
 *  marked v18 的 parse 是异步的，用 watch 异步渲染到 ref（computed 无法处理 async）。 */
const renderedHtml = ref("");
watch(content, async (md) => {
  renderedHtml.value = md ? await marked.parse(md) : "";
});

/** 是否正在保存为笔记（防重复点击） */
const saving = ref(false);

/** 调 AI 生成小结 */
async function generate(): Promise<void> {
  loading.value = true;
  errorMsg.value = "";
  content.value = "";
  const res = await generateSummary(mode.value);
  loading.value = false;
  if (res.ok && res.content) {
    content.value = res.content;
  } else {
    errorMsg.value = res.message ?? "生成失败";
  }
}

/** 切换模式：重新生成 */
function onModeChange(v: SummaryMode): void {
  if (v === mode.value) return;
  mode.value = v;
  generate();
}

/** 重试（失败时） */
function onRetry(): void {
  generate();
}

/** 保存为笔记：Markdown → HTML → 创建笔记（kind=note）→ 写入 note 字段 */
async function onSaveAsNote(): Promise<void> {
  if (!content.value || saving.value) return;
  saving.value = true;
  try {
    // marked v18 的 parse 返回 Promise<string>，必须 await（参考 AttachmentPreview.vue:126）
    const html = await marked.parse(content.value);
    const today = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const dateStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    const title = mode.value === "weekly" ? `周报 ${dateStr}` : `每日小结 ${dateStr}`;
    // 创建笔记到默认笔记本
    const note = await taskStore.createTask({
      title,
      listId: "default-notebook",
      kind: "note",
    });
    // 写入富文本正文（createTask 不支持 note 字段，需 update）
    await taskStore.updateTask(note.id, { note: html });
    Message.success(`已保存为笔记「${title}」`);
    emit("update:visible", false);
  } catch (e) {
    Message.error(`保存失败：${String(e)}`);
  } finally {
    saving.value = false;
  }
}

// 打开时自动生成；关闭时清空状态（下次打开重新生成）
watch(
  () => props.visible,
  (v) => {
    if (v) {
      generate();
    } else {
      content.value = "";
      errorMsg.value = "";
      mode.value = "daily";
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
      <!-- 头部：标题 + 模式切换 -->
      <div class="daily-summary__header">
        <h2 class="daily-summary__title">AI 小结</h2>
        <a-radio-group
          :model-value="mode"
          type="button"
          size="small"
          @change="(v: any) => onModeChange(v as SummaryMode)"
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
          <span class="daily-summary__loading-text">AI 正在生成小结...</span>
        </div>

        <!-- 错误 -->
        <div v-else-if="errorMsg" class="daily-summary__error">
          <p class="daily-summary__error-msg">{{ errorMsg }}</p>
          <a-button type="outline" size="small" @click="onRetry">重试</a-button>
        </div>

        <!-- 成功：渲染 Markdown -->
        <div v-else class="daily-summary__content" v-html="renderedHtml"></div>
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

/* 加载态 */
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

/* 错误态 */
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

/* Markdown 内容渲染（复用富文本编辑器的 ProseMirror 样式 token） */
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

/* 底部操作 */
.daily-summary__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 12px;
  border-top: 1px solid var(--jt-border);
  margin-top: 12px;
}
</style>
