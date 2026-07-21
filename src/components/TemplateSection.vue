<script setup lang="ts">
// 模板设置 section 容器 —— 上下两块：
//   上：可折叠「默认设置」面板（全局默认清单选择器）
//   下：模板卡片网格（新建按钮 + TemplateCard 列表）
// 弹窗在本组件统一管理（编辑/重命名/删除确认），子组件只 emit 事件
import { ref, computed } from "vue";
import { Modal, Message } from "@arco-design/web-vue";
import type { Template } from "@/types";
import { useTemplateStore } from "@/stores/template";
import { useListStore } from "@/stores/list";
import { useSettingsStore } from "@/stores/settings";
import SelectPopover from "@/components/SelectPopover.vue";
import TemplateCard from "./TemplateCard.vue";
import TemplateEditModal from "./TemplateEditModal.vue";
import TemplateRenameModal from "./TemplateRenameModal.vue";

const templateStore = useTemplateStore();
const listStore = useListStore();
const settings = useSettingsStore();

/** 默认设置面板是否展开（本地状态，无需持久化） */
const settingsExpanded = ref(true);

/** 清单下拉选项：仅展示真实清单（非目录），按 position 排序 */
const listOptions = computed(() =>
  listStore.sortedLists
    .filter((l) => !l.isFolder)
    .map((l) => ({ value: l.id, label: l.name })),
);

function onListChange(v: string) {
  settings.setTemplateDefaultListId(v);
}

// ─── 编辑弹窗 ───
const editModalVisible = ref(false);
const editingTemplate = ref<Template | null>(null);

function openCreate() {
  editingTemplate.value = null;
  editModalVisible.value = true;
}
function openEdit(tpl: Template) {
  editingTemplate.value = tpl;
  editModalVisible.value = true;
}

// ─── 重命名弹窗 ───
const renameModalVisible = ref(false);
const renamingTemplate = ref<Template | null>(null);

function openRename(tpl: Template) {
  renamingTemplate.value = tpl;
  renameModalVisible.value = true;
}

// ─── 删除二次确认 ───
function confirmDelete(tpl: Template) {
  Modal.warning({
    title: "删除模板",
    content: `确定要删除模板「${tpl.name}」吗？此操作不可撤销。`,
    okText: "删除",
    cancelText: "取消",
    hideCancel: false,
    modalClass: "confirm-dialog-modal",
    maskStyle: { backgroundColor: "rgba(0,0,0,0.35)" },
    onOk: async () => {
      try {
        await templateStore.deleteTemplate(tpl.id);
        Message.success("已删除模板");
      } catch (e) {
        Message.error("删除失败：" + String(e));
      }
    },
  });
}
</script>

<template>
  <div class="tpl-section">
    <!-- 上：可折叠默认设置面板 -->
    <div class="tpl-section__settings-card">
      <button
        class="tpl-section__settings-header"
        :class="{ 'tpl-section__settings-header--expanded': settingsExpanded }"
        @click="settingsExpanded = !settingsExpanded"
      >
        <span class="tpl-section__settings-title">⚙️ 默认设置</span>
        <span class="tpl-section__settings-arrow">
          {{ settingsExpanded ? "▾" : "▸" }}
        </span>
      </button>
      <div v-if="settingsExpanded" class="tpl-section__settings-body">
        <div class="tpl-section__settings-row">
          <div>
            <div class="tpl-section__settings-label">应用模板时创建到</div>
            <div class="tpl-section__settings-hint">
              所有模板应用此默认清单（可在清单管理中新建更多）
            </div>
          </div>
          <SelectPopover
            :model-value="settings.templateDefaultListId"
            :options="listOptions"
            :width="160"
            @update:model-value="onListChange"
          />
        </div>
      </div>
    </div>

    <!-- 下：模板区标题栏 + 卡片网格 -->
    <div class="tpl-section__templates-header">
      <span class="tpl-section__templates-title">
        模板 · {{ templateStore.templates.length }}
      </span>
      <a-button type="text" size="small" @click="openCreate">
        <template #icon>+</template>
        新建
      </a-button>
    </div>

    <div v-if="templateStore.templates.length === 0" class="tpl-section__empty">
      暂无模板，点击右上「新建」创建一个
    </div>
    <div v-else class="tpl-section__grid">
      <TemplateCard
        v-for="tpl in templateStore.sortedTemplates"
        :key="tpl.id"
        :template="tpl"
        @edit="openEdit"
        @rename="openRename"
        @delete="confirmDelete"
      />
    </div>

    <!-- 弹窗（统一管理） -->
    <TemplateEditModal
      v-model:visible="editModalVisible"
      :template="editingTemplate"
    />
    <TemplateRenameModal
      v-model:visible="renameModalVisible"
      :template="renamingTemplate"
    />
  </div>
</template>

<style scoped>
.tpl-section {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

/* 上：默认设置卡片 */
.tpl-section__settings-card {
  background: var(--jt-surface);
  border: 1px solid var(--jt-border);
  border-radius: 8px;
  overflow: hidden;
}
.tpl-section__settings-header {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  background: transparent;
  border: none;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
  color: var(--jt-text-primary);
  text-align: left;
}
.tpl-section__settings-header:hover {
  background: var(--jt-surface-hover);
}
.tpl-section__settings-arrow {
  font-size: 11px;
  color: var(--jt-text-tertiary);
}
.tpl-section__settings-body {
  padding: 4px 14px 12px;
  border-top: 1px solid var(--jt-border);
}
.tpl-section__settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 0 4px;
}
.tpl-section__settings-label {
  font-size: 13px;
  color: var(--jt-text-primary);
}
.tpl-section__settings-hint {
  font-size: 11px;
  color: var(--jt-text-tertiary);
  margin-top: 2px;
}

/* 下：模板网格 */
.tpl-section__templates-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 0;
}
.tpl-section__templates-title {
  font-size: 11px;
  color: var(--jt-text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-weight: 500;
}
.tpl-section__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 12px;
}
.tpl-section__empty {
  padding: 32px 16px;
  text-align: center;
  font-size: 13px;
  color: var(--jt-text-tertiary);
  border: 1px dashed var(--jt-border);
  border-radius: 8px;
}
</style>
