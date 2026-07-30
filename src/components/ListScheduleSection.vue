<script setup lang="ts">
// 清单生成计划 —— 设置页 section 容器
// 顶部：标题 + 新建按钮 + 立即运行按钮
// 下方：计划卡片列表（ListScheduleCard）
// 弹窗在本组件统一管理（编辑/删除确认）
import { onMounted, ref } from "vue";
import { Message } from "@arco-design/web-vue";
import type { ListSchedule } from "@/types/listSchedule";
import { useListScheduleStore } from "@/stores/listSchedule";
import { useListStore } from "@/stores/list";
import ConfirmDialog from "@/components/ConfirmDialog.vue";
import ListScheduleCard from "./ListScheduleCard.vue";
import ListScheduleEditModal from "./ListScheduleEditModal.vue";

const store = useListScheduleStore();
const listStore = useListStore();

onMounted(() => {
  store.loadSchedules();
});

// ─── 编辑弹窗 ───
const editModalVisible = ref(false);
const editingSchedule = ref<ListSchedule | null>(null);

function openCreate() {
  editingSchedule.value = null;
  editModalVisible.value = true;
}
function openEdit(s: ListSchedule) {
  editingSchedule.value = s;
  editModalVisible.value = true;
}

// ─── 启用/停用切换 ───
async function onToggleEnabled(s: ListSchedule) {
  try {
    await store.updateSchedule(s.id, { enabled: s.enabled });
  } catch (e) {
    Message.error("切换失败：" + String(e));
  }
}

// ─── 删除二次确认 ───
const deleteConfirmVisible = ref(false);
const pendingDelete = ref<ListSchedule | null>(null);
const deleting = ref(false);

function confirmDelete(s: ListSchedule) {
  pendingDelete.value = s;
  deleteConfirmVisible.value = true;
}
function cancelDelete() {
  deleteConfirmVisible.value = false;
  pendingDelete.value = null;
}
async function doDelete() {
  if (!pendingDelete.value) return;
  deleting.value = true;
  try {
    await store.removeSchedule(pendingDelete.value.id);
    Message.success("已删除计划");
    deleteConfirmVisible.value = false;
    pendingDelete.value = null;
  } catch (e) {
    Message.error("删除失败：" + String(e));
  } finally {
    deleting.value = false;
  }
}

// ─── 立即运行一次（手动测试 / 补生成）───
const running = ref(false);
async function onRunNow() {
  running.value = true;
  try {
    const n = await store.runNow();
    // 生成后刷新侧边栏清单
    await listStore.loadLists();
    Message.success(n > 0 ? `已生成 ${n} 项（清单/目录）` : "当前无需生成（目标项均已存在）");
  } catch (e) {
    Message.error("运行失败：" + String(e));
  } finally {
    running.value = false;
  }
}

// ─── 模拟预览（不写入数据，只看某天会生成什么）───
import type { SchedulePreview } from "@/api/listSchedule";
const previewDate = ref(""); // YYYY-MM-DD
const previewVisible = ref(false);
const previewResult = ref<SchedulePreview[]>([]);
const previewing = ref(false);

/** 默认填明天，便于测试"次日生成" */
function initPreviewDate() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  previewDate.value = tomorrow.toISOString().slice(0, 10);
}
initPreviewDate();

async function onPreview() {
  if (!previewDate.value) {
    Message.warning("请填写日期");
    return;
  }
  previewing.value = true;
  try {
    previewResult.value = await store.preview(previewDate.value);
    previewVisible.value = true;
  } catch (e) {
    Message.error("预览失败：" + String(e));
  } finally {
    previewing.value = false;
  }
}
</script>

<template>
  <div class="ls-section">
    <!-- 标题栏 -->
    <div class="ls-section__header">
      <span class="ls-section__title">
        计划 · {{ store.schedules.length }}
      </span>
      <div class="ls-section__actions">
        <a-button
          type="text"
          size="small"
          :loading="running"
          @click="onRunNow"
        >
          立即运行
        </a-button>
        <a-button type="text" size="small" @click="openCreate">
          <template #icon>+</template>
          新建
        </a-button>
      </div>
    </div>

    <!-- 说明 -->
    <p class="ls-section__desc">
      按规则自动创建清单/目录。工作日频率会跳过法定节假日。
    </p>

    <!-- 预览工具：模拟某天的生成结果（不写入数据） -->
    <div class="ls-section__preview-bar">
      <span class="ls-section__preview-label">模拟日期</span>
      <input
        v-model="previewDate"
        type="date"
        class="ls-section__preview-date"
      />
      <a-button
        type="outline"
        size="mini"
        :loading="previewing"
        @click="onPreview"
      >
        预览
      </a-button>
    </div>

    <!-- 空状态 -->
    <div v-if="store.schedules.length === 0" class="ls-section__empty">
      暂无计划，点击右上「新建」创建一个
    </div>

    <!-- 卡片列表 -->
    <div v-else class="ls-section__list">
      <ListScheduleCard
        v-for="s in store.schedules"
        :key="s.id"
        :schedule="s"
        @edit="openEdit"
        @delete="confirmDelete"
        @toggle-enabled="onToggleEnabled"
      />
    </div>

    <!-- 编辑弹窗 -->
    <ListScheduleEditModal
      v-model:visible="editModalVisible"
      :schedule="editingSchedule"
    />

    <!-- 删除确认 -->
    <ConfirmDialog
      :visible="deleteConfirmVisible"
      :loading="deleting"
      @update:visible="(v) => { if (!v) cancelDelete(); }"
      @confirm="doDelete"
    >
      <template #title>删除计划「<strong>{{ pendingDelete?.name }}</strong>」？</template>
      已生成的清单不会被删除。
    </ConfirmDialog>

    <!-- 预览结果弹窗 -->
    <a-modal
      :visible="previewVisible"
      :width="520"
      :footer="false"
      :mask-style="{ backgroundColor: 'rgba(0,0,0,0.35)' }"
      @cancel="previewVisible = false"
    >
      <div class="ls-preview">
        <h3 class="ls-preview__title">模拟 {{ previewDate }} 的生成结果</h3>
        <p class="ls-preview__hint">（仅预览，不会实际创建清单）</p>
        <div v-if="previewResult.length === 0" class="ls-preview__empty">
          暂无计划
        </div>
        <div v-else class="ls-preview__list">
          <div
            v-for="(item, idx) in previewResult"
            :key="idx"
            class="ls-preview__row"
          >
            <span
              class="ls-preview__status"
              :class="{ 'ls-preview__status--hit': item.hit }"
            >
              {{ item.hit ? "✓ 命中" : "✗ 不命中" }}
            </span>
            <span class="ls-preview__name">{{ item.name }}</span>
            <span class="ls-preview__path">{{ item.path }}</span>
            <span class="ls-preview__type">{{ item.is_folder ? "目录" : "清单" }}</span>
          </div>
        </div>
      </div>
    </a-modal>
  </div>
</template>

<style scoped>
.ls-section {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.ls-section__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 0 0;
}
.ls-section__title {
  font-size: 11px;
  color: var(--jt-text-tertiary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-weight: 500;
}
.ls-section__actions {
  display: flex;
  gap: 4px;
}

.ls-section__desc {
  font-size: 12px;
  color: var(--jt-text-tertiary);
  margin: 0;
  line-height: 1.5;
}

.ls-section__empty {
  padding: 32px 16px;
  text-align: center;
  font-size: 13px;
  color: var(--jt-text-tertiary);
  border: 1px dashed var(--jt-border);
  border-radius: 8px;
}

.ls-section__list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* 预览工具行 */
.ls-section__preview-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 0;
}
.ls-section__preview-label {
  font-size: 12px;
  color: var(--jt-text-tertiary);
}
.ls-section__preview-date {
  border: 1px solid var(--jt-border);
  border-radius: 4px;
  padding: 2px 6px;
  font-size: 12px;
  color: var(--jt-text-primary);
  background: var(--jt-surface);
  outline: none;
}

/* 预览结果弹窗 */
.ls-preview {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px 0;
}
.ls-preview__title {
  font-size: 14px;
  font-weight: 600;
  color: var(--jt-text-primary);
  margin: 0;
}
.ls-preview__hint {
  font-size: 12px;
  color: var(--jt-text-tertiary);
  margin: 0 0 8px;
}
.ls-preview__empty {
  padding: 24px;
  text-align: center;
  font-size: 13px;
  color: var(--jt-text-tertiary);
}
.ls-preview__list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.ls-preview__row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  background: var(--jt-surface-sunken);
  border-radius: 6px;
  font-size: 12px;
}
.ls-preview__status {
  color: var(--jt-text-tertiary);
  flex-shrink: 0;
  width: 64px;
}
.ls-preview__status--hit {
  color: var(--jt-success);
  font-weight: 600;
}
.ls-preview__name {
  color: var(--jt-text-primary);
  font-weight: 500;
  flex-shrink: 0;
}
.ls-preview__path {
  flex: 1;
  font-family: var(--font-mono, ui-monospace, monospace);
  color: var(--jt-text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ls-preview__type {
  color: var(--jt-text-tertiary);
  flex-shrink: 0;
}
</style>
