<script setup lang="ts">
// 清单生成计划卡片 —— 极简卡风格
// · 整卡 click → 打开编辑弹窗（emit 'edit'）
// · 右上「⋯」按钮 → 菜单（emit 'delete'）
// · 右侧启用开关（emit 'toggle-enabled'）
// · 显示：名称 + 颜色点 + 频率标签 + 路径预览
import { ref } from "vue";
import { IconMore, IconEdit, IconDelete } from "@arco-design/web-vue/es/icon";
import type { ListSchedule } from "@/types/listSchedule";
import { FREQ_LABELS } from "@/types/listSchedule";
import MenuPopover from "./MenuPopover.vue";
import MenuPopoverItem from "./MenuPopoverItem.vue";

const props = defineProps<{ schedule: ListSchedule }>();
const emit = defineEmits<{
  edit: [schedule: ListSchedule];
  delete: [schedule: ListSchedule];
  /** 启用/停用切换 */
  "toggle-enabled": [schedule: ListSchedule];
}>();

const menuOpen = ref(false);

function onEdit() {
  emit("edit", props.schedule);
}

function onToggleEnabled(value: string | number | boolean) {
  // a-switch 的 modelValue 类型是 string | number | boolean，此处只可能是 boolean
  emit("toggle-enabled", { ...props.schedule, enabled: Boolean(value) });
}

function onDelete() {
  menuOpen.value = false;
  emit("delete", props.schedule);
}
</script>

<template>
  <div class="ls-card" @click="onEdit">
    <div class="ls-card__header">
      <span class="ls-card__dot" :style="{ backgroundColor: schedule.color }" />
      <span class="ls-card__name" :title="schedule.name">{{ schedule.name }}</span>
      <span class="ls-card__freq">{{ FREQ_LABELS[schedule.freq] }}</span>
      <a-switch
        :model-value="schedule.enabled"
        size="small"
        @click.stop
        @update:model-value="onToggleEnabled"
      />
      <MenuPopover v-model:visible="menuOpen" placement="bottom-right">
        <template #trigger>
          <button
            class="ls-card__menu"
            title="更多操作"
            @click.stop="menuOpen = !menuOpen"
          >
            <IconMore :size="16" />
          </button>
        </template>
        <MenuPopoverItem @click="onEdit">
          <IconEdit :size="15" />
          <span>编辑</span>
        </MenuPopoverItem>
        <MenuPopoverItem danger @click="onDelete">
          <IconDelete :size="15" />
          <span>删除</span>
        </MenuPopoverItem>
      </MenuPopover>
    </div>
    <div class="ls-card__path" :title="schedule.pathTemplate">
      {{ schedule.pathTemplate }}
    </div>
  </div>
</template>

<style scoped>
.ls-card {
  background: var(--jt-surface);
  border: 1px solid var(--jt-border);
  border-radius: 8px;
  padding: 12px 14px;
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ls-card:hover {
  border-color: var(--jt-text-tertiary);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
}

.ls-card__header {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ls-card__dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.08);
}
.ls-card__name {
  font-size: 13px;
  font-weight: 600;
  color: var(--jt-text-primary);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ls-card__freq {
  font-size: 11px;
  color: var(--jt-text-secondary);
  background: var(--jt-surface-hover);
  padding: 2px 6px;
  border-radius: 4px;
  flex-shrink: 0;
}
.ls-card__menu {
  margin: 0;
  padding: 0;
  background: transparent;
  border: none;
  cursor: pointer;
  border-radius: 4px;
  color: var(--jt-text-tertiary);
  display: flex;
  align-items: center;
  flex-shrink: 0;
}
.ls-card__menu:hover {
  background-color: var(--jt-surface-hover);
  color: var(--jt-text-primary);
}

.ls-card__path {
  font-size: 12px;
  font-family: var(--font-mono, ui-monospace, monospace);
  color: var(--jt-text-tertiary);
  line-height: 1.5;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border-top: 1px dashed var(--jt-border);
  padding-top: 8px;
}
</style>
