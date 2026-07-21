<script setup lang="ts">
// 模板卡片 —— 极简卡风格
// · 整卡 click → 打开编辑弹窗（emit 'edit'）
// · 右上「⋯」按钮 → 菜单（emit 'rename' / 'delete'）
// · 正文区显示 note 前 3 行纯文本预览（HTML → textContent 截断）
import { computed, ref } from "vue";
import type { Template } from "@/types";
import MenuPopover from "./MenuPopover.vue";
import MenuPopoverItem from "./MenuPopoverItem.vue";

const props = defineProps<{ template: Template }>();
const emit = defineEmits<{
  edit: [template: Template];
  rename: [template: Template];
  delete: [template: Template];
}>();

const menuOpen = ref(false);

/** 内置模板的 emoji 图标（按 id 匹配；其它一律 📄） */
const icon = computed<string>(() => {
  switch (props.template.id) {
    case "tpl-meeting":
      return "📝";
    case "tpl-weekly":
      return "📊";
    case "tpl-codereview":
      return "👀";
    case "tpl-reading":
      return "📖";
    default:
      return "📄";
  }
});

/** 把 HTML 转纯文本并截前 3 行 */
const previewText = computed<string>(() => {
  try {
    const doc = new DOMParser().parseFromString(props.template.note, "text/html");
    const text = doc.body.textContent ?? "";
    const lines = text.split("\n").map((s) => s.trim()).filter(Boolean);
    return lines.slice(0, 3).join("\n");
  } catch {
    return "";
  }
});

function onEdit() {
  emit("edit", props.template);
}
function onRename() {
  menuOpen.value = false;
  emit("rename", props.template);
}
function onDelete() {
  menuOpen.value = false;
  emit("delete", props.template);
}
</script>

<template>
  <div class="tpl-card" @click="onEdit">
    <div class="tpl-card__header">
      <span class="tpl-card__icon">{{ icon }}</span>
      <span class="tpl-card__name" :title="template.name">{{ template.name }}</span>
      <MenuPopover v-model:visible="menuOpen" placement="bottom-right">
        <template #trigger>
          <button
            class="tpl-card__menu"
            title="更多操作"
            @click.stop="menuOpen = !menuOpen"
          >
            ⋯
          </button>
        </template>
        <MenuPopoverItem @click="onRename">重命名</MenuPopoverItem>
        <MenuPopoverItem danger @click="onDelete">删除</MenuPopoverItem>
      </MenuPopover>
    </div>
    <div v-if="previewText" class="tpl-card__preview">{{ previewText }}</div>
    <div v-else class="tpl-card__preview tpl-card__preview--empty">(空白模板)</div>
  </div>
</template>

<style scoped>
.tpl-card {
  background: var(--jt-surface);
  border: 1px solid var(--jt-border);
  border-radius: 8px;
  padding: 12px 14px;
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 110px;
}
.tpl-card:hover {
  border-color: var(--jt-text-tertiary);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
}

.tpl-card__header {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tpl-card__icon {
  font-size: 16px;
  line-height: 1;
  flex-shrink: 0;
}
.tpl-card__name {
  font-size: 13px;
  font-weight: 600;
  color: var(--jt-text-primary);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tpl-card__menu {
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  border: none;
  background: transparent;
  color: var(--jt-text-tertiary);
  cursor: pointer;
  border-radius: 4px;
  font-size: 14px;
  line-height: 1;
  transition: background-color 0.12s, color 0.12s;
}
.tpl-card__menu:hover {
  background-color: var(--jt-surface-hover);
  color: var(--jt-text-primary);
}

.tpl-card__preview {
  font-size: 12px;
  color: var(--jt-text-secondary);
  line-height: 1.5;
  white-space: pre-wrap;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  border-top: 1px dashed var(--jt-border);
  padding-top: 8px;
}
.tpl-card__preview--empty {
  color: var(--jt-text-tertiary);
  font-style: italic;
}
</style>
