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
    :width="640"
    :footer="false"
    :mask-closable="false"
    :mask-style="{ backgroundColor: 'rgba(0,0,0,0.35)' }"
    modal-class="template-edit-modal"
    @update:visible="(v) => emit('update:visible', v)"
  >
    <div class="tpl-edit">
      <!-- 头部：模式标识 + 模板名 -->
      <header class="tpl-edit__header">
        <span class="tpl-edit__label">
          {{ isEdit ? "编辑模板" : "新建模板" }}
        </span>
        <input
          v-model="form.name"
          class="tpl-edit__name-input"
          placeholder="模板名称"
          maxlength="60"
        />
      </header>

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
        <label class="tpl-edit__field-label">备注（富文本）</label>
        <div class="tpl-edit__rich-wrap">
          <RichTextEditor v-model="form.note" placeholder="支持富文本、图片粘贴..." />
        </div>
      </section>

      <!-- footer -->
      <footer class="tpl-edit__footer">
        <a-button @click="close">取消</a-button>
        <a-button type="outline" :loading="saving" @click="onSave">保存模板</a-button>
        <a-button type="primary" :loading="applying" @click="onApply">应用模板</a-button>
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

.tpl-edit__header {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.tpl-edit__label {
  font-size: 11px;
  color: var(--jt-text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.tpl-edit__name-input {
  border: none;
  outline: none;
  background: transparent;
  font-size: 18px;
  font-weight: 600;
  color: var(--jt-text-primary);
  padding: 2px 0;
  font-family: var(--font-display);
}
.tpl-edit__name-input::placeholder {
  color: var(--jt-text-tertiary);
  font-weight: 500;
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

.tpl-edit__field--rich {
  flex: 1;
}
.tpl-edit__rich-wrap {
  min-height: 240px;
  border: 1px solid var(--jt-border);
  border-radius: 6px;
  overflow: hidden;
}
.tpl-edit__rich-wrap:focus-within {
  border-color: var(--jt-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--jt-primary) 20%, transparent);
}

.tpl-edit__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--jt-border);
  margin-top: 4px;
}
</style>

<style>
/* 弹窗 body 内边距（非 scoped，作用于 .arco-modal-body） */
.template-edit-modal .arco-modal-body {
  padding: 20px 24px 16px;
}
</style>
