<script setup lang="ts">
// 模板编辑/新建弹窗 —— 分区式（头部 + 任务标题 + 富文本 + footer）
// · 编辑模式（template prop 非 null）：预填表单，footer「保存模板」走 updateTemplate
// · 新建模式（template prop 为 null）：空表单，footer「保存模板」走 createTemplate
// · 「应用模板」走 templateStore.applyTemplate（内部含保存逻辑）
// · 「取消」直接关弹窗（MVP 不做"放弃改动"二次确认）
import { ref, watch, computed } from "vue";
import { Message } from "@arco-design/web-vue";
import type { Template, TemplateForm } from "@/types";
import { useTemplateStore } from "@/stores/template";
import RichTextEditor from "./RichTextEditor.vue";
import RichTextToolbar from "./RichTextToolbar.vue";
import Popover from "./Popover.vue";

const props = defineProps<{
  visible: boolean;
  /** 非 null = 编辑模式；null = 新建模式 */
  template: Template | null;
}>();
const emit = defineEmits<{
  "update:visible": [value: boolean];
  /** 创建/保存成功后通知父组件（用于刷新列表等） */
  saved: [];
  /** 应用模板成功后通知父组件关闭弹窗 */
  applied: [];
}>();

const templateStore = useTemplateStore();

const isEdit = computed(() => props.template !== null);

/** 表单状态：每次 visible 打开时根据 template 重置 */
const form = ref<TemplateForm>({ id: null, name: "", title: "", note: "" });
const applying = ref(false);
const saving = ref(false);

/** RichTextEditor 实例引用（用于把 editor 传给工具条）*/
const richTextRef = ref<InstanceType<typeof RichTextEditor> | null>(null);
/** 「A」按钮触发的工具条 Popover 可见态 */
const formatToolbarVisible = ref(false);

/** visible 由 false → true 时初始化表单 */
watch(
  () => props.visible,
  (open) => {
    if (open) {
      if (props.template) {
        form.value = {
          id: props.template.id,
          name: props.template.name,
          title: props.template.title,
          note: props.template.note,
        };
      } else {
        form.value = { id: null, name: "", title: "", note: "" };
      }
    }
  },
  { immediate: true },
);

function close() {
  emit("update:visible", false);
}

/** 校验表单：name 必填 */
function validate(): boolean {
  if (!form.value.name.trim()) {
    Message.error("请填写模板名称");
    return false;
  }
  return true;
}

/** 保存模板：新建走 createTemplate，编辑走 updateTemplate */
async function onSave() {
  if (!validate()) return;
  saving.value = true;
  try {
    if (form.value.id === null) {
      await templateStore.createTemplate({
        name: form.value.name,
        title: form.value.title,
        note: form.value.note,
      });
      Message.success("已创建模板");
    } else {
      await templateStore.updateTemplate(form.value.id, {
        name: form.value.name,
        title: form.value.title,
        note: form.value.note,
      });
      Message.success("已保存模板");
    }
    emit("saved");
    close();
  } catch (e) {
    Message.error("保存失败：" + String(e));
  } finally {
    saving.value = false;
  }
}

/** 应用模板：保存 + 创建任务 + 打开详情（由 store 编排） */
async function onApply() {
  if (!validate()) return;
  applying.value = true;
  try {
    await templateStore.applyTemplate(form.value);
    Message.success("已创建任务");
    emit("applied");
    close();
  } catch (e) {
    Message.error("应用模板失败：" + String(e));
  } finally {
    applying.value = false;
  }
}
</script>

<template>
  <a-modal
    :visible="visible"
    :title="isEdit ? '编辑模板' : '新建模板'"
    :width="640"
    :footer="false"
    :mask-closable="false"
    :mask-style="{ backgroundColor: 'rgba(0,0,0,0.35)' }"
    modal-class="template-edit-modal"
    @update:visible="(v) => emit('update:visible', v)"
  >
    <div class="tpl-edit">
      <!-- 模板名 -->
      <section class="tpl-edit__field">
        <label class="tpl-edit__field-label">模板名称</label>
        <input
          v-model="form.name"
          class="tpl-edit__field-input tpl-edit__field-input--name"
          placeholder="模板名称"
          maxlength="60"
        />
      </section>

      <!-- 任务标题分区 -->
      <section class="tpl-edit__field">
        <label class="tpl-edit__field-label">任务标题</label>
        <input
          v-model="form.title"
          class="tpl-edit__field-input"
          placeholder="应用模板时新任务的标题（可留空，默认用模板名）"
          maxlength="120"
        />
      </section>

      <!-- 富文本分区（主体） -->
      <section class="tpl-edit__field tpl-edit__field--rich">
        <label class="tpl-edit__field-label">备注</label>
        <div class="tpl-edit__rich-wrap">
          <RichTextEditor
            ref="richTextRef"
            v-model="form.note"
            :drag-handle="false"
            borderless
            placeholder="按 / 唤起命令，或点击右下角 A 图标打开工具栏…"
          />
          <!-- 富文本工具条入口（悬浮在备注框右下角的 A 按钮）-->
          <div class="tpl-edit__format-popover">
            <Popover
              v-model:visible="formatToolbarVisible"
              placement="top-right"
              :offset="8"
            >
              <template #trigger>
                <button
                  class="tpl-edit__format-btn"
                  :class="{ 'tpl-edit__format-btn--active': formatToolbarVisible }"
                  title="文字格式"
                  @click="formatToolbarVisible = !formatToolbarVisible"
                >
                  <span class="tpl-edit__format-btn-text">A</span>
                </button>
              </template>
              <div class="tpl-edit__format-popup">
                <RichTextToolbar
                  v-if="richTextRef?.editor"
                  :editor="richTextRef.editor"
                  compact
                />
              </div>
            </Popover>
          </div>
        </div>
      </section>

      <!-- footer -->
      <footer class="tpl-edit__footer">
        <div class="tpl-edit__footer-actions">
          <a-button @click="close">取消</a-button>
          <a-button type="outline" :loading="saving" @click="onSave">保存模板</a-button>
          <a-button type="primary" :loading="applying" @click="onApply">应用模板</a-button>
        </div>
      </footer>
    </div>
  </a-modal>
</template>

<style scoped>
.tpl-edit {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 4px 0;
}

.tpl-edit__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.tpl-edit__field-label {
  font-size: 11px;
  color: var(--jt-text-secondary);
  font-weight: 500;
}
.tpl-edit__field-input {
  border: 1px solid var(--jt-border);
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 13px;
  color: var(--jt-text-primary);
  background: var(--jt-surface);
  outline: none;
  transition: border-color 0.12s, box-shadow 0.12s;
}
.tpl-edit__field-input:focus {
  border-color: var(--jt-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--jt-primary) 20%, transparent);
}
/* 模板名输入：比其它字段更醒目（替代原 name-input 的 18px 体验） */
.tpl-edit__field-input--name {
  font-size: 15px;
  font-weight: 600;
}

.tpl-edit__field--rich {
  flex: 1;
  /* 限制整个富文本区的最大高度，内容超出后内部滚动，
     防止备注变长把弹窗顶出屏幕 */
  max-height: 50vh;
  min-height: 0;
  display: flex;
}
.tpl-edit__rich-wrap {
  position: relative; /* 锚定 A 悬浮按钮的 absolute 定位 */
  min-height: 240px;
  border: 1px solid var(--jt-border);
  border-radius: 6px;
  overflow: hidden;
  display: flex;
}
.tpl-edit__rich-wrap:focus-within {
  border-color: var(--jt-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--jt-primary) 20%, transparent);
}
/* borderless 模式下 RichTextEditor 自带 24px 左 padding（给块拖拽手柄留位）；
   本场景已关闭 dragHandle，恢复对称 10/12 padding */
.tpl-edit__rich-wrap :deep(.rich-text--borderless) .rich-text__editor-wrapper {
  padding: 10px 12px;
}
/* 让内部 RichTextEditor 撑满外层 wrap 的高度，避免下方出现未填充空隙（视觉上的"线"）*/
.tpl-edit__rich-wrap :deep(.rich-text) {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.tpl-edit__rich-wrap :deep(.rich-text__editor-wrapper) {
  flex: 1;
  /* 备注内容超出时内部滚动，不撑破弹窗 */
  overflow-y: auto;
  min-height: 0;
}

.tpl-edit__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 8px;
  margin-top: 4px;
}
.tpl-edit__footer-actions {
  display: flex;
  gap: 8px;
}

/* 富文本工具条入口（悬浮在备注框右下角的 A 按钮）*/
.tpl-edit__format-popover {
  position: absolute;
  right: 8px;
  bottom: 8px;
  z-index: 2;
}
.tpl-edit__format-btn {
  width: 28px;
  height: 28px;
  border: none;
  background: var(--jt-surface);
  border: 1px solid var(--jt-border);
  border-radius: 6px;
  color: var(--jt-text-tertiary);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: all 0.12s;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
}
.tpl-edit__format-btn:hover {
  background: var(--jt-surface-hover);
  color: var(--jt-text-primary);
}
.tpl-edit__format-btn--active {
  background: var(--jt-surface-sunken);
  color: var(--jt-text-primary);
}
.tpl-edit__format-btn-text {
  font-size: 14px;
  font-weight: 600;
  text-decoration: underline;
  text-underline-offset: 2px;
}
.tpl-edit__format-popup {
  padding: 6px 8px;
  background: var(--jt-surface);
  border: 1px solid var(--jt-border);
  border-radius: 8px;
  box-shadow:
    0 6px 20px rgba(0, 0, 0, 0.12),
    0 2px 6px rgba(0, 0, 0, 0.06);
}
</style>

<style>
/* 弹窗 body 内边距（非 scoped，作用于 .arco-modal-body） */
.template-edit-modal .arco-modal-body {
  padding: 20px 24px 16px;
}
</style>
