<script setup lang="ts">
// 模板重命名弹窗 —— 单输入框，回车 = 确认
// 确认时校验非空 + 与原名不同（否则静默关闭）
import { ref, watch, nextTick } from "vue";
import { Message } from "@arco-design/web-vue";
import type { Template } from "@/types";
import { useTemplateStore } from "@/stores/template";

const props = defineProps<{
  visible: boolean;
  template: Template | null;
}>();
const emit = defineEmits<{
  "update:visible": [value: boolean];
}>();

const templateStore = useTemplateStore();
const newName = ref("");
const inputRef = ref<HTMLInputElement | null>(null);
const confirming = ref(false);

/** visible → true 时回填原名并自动聚焦 */
watch(
  () => props.visible,
  async (open) => {
    if (open && props.template) {
      newName.value = props.template.name;
      await nextTick();
      inputRef.value?.focus();
      inputRef.value?.select();
    }
  },
);

function close() {
  emit("update:visible", false);
}

async function confirm() {
  if (!props.template) return;
  const trimmed = newName.value.trim();
  if (!trimmed) {
    Message.error("模板名称不能为空");
    return;
  }
  if (trimmed === props.template.name) {
    // 与原名相同，静默关闭
    close();
    return;
  }
  confirming.value = true;
  try {
    await templateStore.renameTemplate(props.template.id, trimmed);
    Message.success("已重命名");
    close();
  } catch (e) {
    Message.error("重命名失败：" + String(e));
  } finally {
    confirming.value = false;
  }
}
</script>

<template>
  <a-modal
    :visible="visible"
    :width="400"
    :footer="false"
    :mask-closable="true"
    :mask-style="{ backgroundColor: 'rgba(0,0,0,0.35)' }"
    modal-class="template-rename-modal"
    @update:visible="(v) => emit('update:visible', v)"
  >
    <div class="tpl-rename">
      <header class="tpl-rename__header">
        <span class="tpl-rename__label">重命名模板</span>
      </header>
      <input
        ref="inputRef"
        v-model="newName"
        class="tpl-rename__input"
        placeholder="模板名称"
        maxlength="60"
        @keydown.enter="confirm"
      />
      <footer class="tpl-rename__footer">
        <a-button @click="close">取消</a-button>
        <a-button type="primary" :loading="confirming" @click="confirm">确认</a-button>
      </footer>
    </div>
  </a-modal>
</template>

<style scoped>
.tpl-rename {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 4px 0;
}
.tpl-rename__header {
  display: flex;
  flex-direction: column;
}
.tpl-rename__label {
  font-size: 11px;
  color: var(--jt-text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.tpl-rename__input {
  border: 1px solid var(--jt-border);
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 14px;
  color: var(--jt-text-primary);
  background: var(--jt-surface);
  outline: none;
  transition: border-color 0.12s, box-shadow 0.12s;
}
.tpl-rename__input:focus {
  border-color: var(--jt-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--jt-primary) 20%, transparent);
}
.tpl-rename__footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>

<style>
.template-rename-modal .arco-modal-body {
  padding: 20px 24px 16px;
}
</style>
