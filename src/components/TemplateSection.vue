<script setup lang="ts">
// 模板设置 section 容器 —— 上下两块：
//   上：可折叠「默认设置」面板（全局默认清单选择器）
//   下：模板卡片网格（新建按钮 + TemplateCard 列表）
// 弹窗在本组件统一管理（编辑/重命名/删除确认），子组件只 emit 事件
//
// 拖拽实时让位（grid 容器级监听，不依赖进入某张卡的精确区域）：
// · dragover 在整个 grid 上监听，根据鼠标坐标 vs 所有卡片的几何中心
//   计算 dragging 应该插到哪个 index（鼠标在卡中心左/上 → 插该卡前，
//   右/下 → 插该卡后），任何位置（含间隙）都能识别落位
// · dragover 阶段实时调整 localOrder，TransitionGroup 做 FLIP 动画
// · drop 时调 templateStore.reorderTemplates 持久化
// · dragend 时若未 drop（拖出区域）则恢复快照
import { ref, computed, watch } from "vue";
import { Message } from "@arco-design/web-vue";
import { IconExclamationCircle } from "@arco-design/web-vue/es/icon";
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

// ─── 直接应用模板（不打开编辑弹窗，用模板当前内容创建任务）───
async function applyDirectly(tpl: Template) {
  try {
    await templateStore.applyTemplate({
      id: tpl.id,
      name: tpl.name,
      title: tpl.title,
      note: tpl.note,
    });
    Message.success("已创建任务");
  } catch (e) {
    Message.error("应用模板失败：" + String(e));
  }
}

// ─── 重命名弹窗 ───
const renameModalVisible = ref(false);
const renamingTemplate = ref<Template | null>(null);

function openRename(tpl: Template) {
  renamingTemplate.value = tpl;
  renameModalVisible.value = true;
}

// ─── 删除二次确认（极简卡片风，与任务详情同款）───
const deleteConfirmVisible = ref(false);
const pendingDelete = ref<Template | null>(null);
const deleting = ref(false);

function confirmDelete(tpl: Template) {
  pendingDelete.value = tpl;
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
    await templateStore.deleteTemplate(pendingDelete.value.id);
    Message.success("已删除模板");
    deleteConfirmVisible.value = false;
    pendingDelete.value = null;
  } catch (e) {
    Message.error("删除失败：" + String(e));
  } finally {
    deleting.value = false;
  }
}

// ─── 拖拽排序：实时让位（grid 容器级监听）────────────────
// localOrder：当前显示顺序的 id 数组（拖拽时本地调整，drop 后同步到 store）
const localOrder = ref<string[]>([]);
// draggingId：正在被拖动的模板 id（dragstart 设置，dragend 清空）
const draggingId = ref<string | null>(null);
// orderChangedDuringDrag：本次拖拽期间 localOrder 是否真的变化过
// （dragover 让位过 = true）。用于 dragend 判断要不要持久化。
// drop 在 Tauri WKWebView 上不可靠，改为依赖 dragend 兜底持久化。
let orderChangedDuringDrag = false;
// gridRef：grid 容器 DOM 引用（dragover/drop 监听锚点）
const gridRef = ref<HTMLElement | null>(null);

/** store 数据变化（加载/新建/删除/重命名后）时同步本地顺序 */
watch(
  () => templateStore.sortedTemplates.map((t) => t.id),
  (ids) => {
    localOrder.value = [...ids];
  },
  { immediate: true },
);

/** 按本地顺序从 store 取出模板对象（渲染用） */
const orderedTemplates = computed<Template[]>(() => {
  const map = new Map(templateStore.templates.map((t) => [t.id, t]));
  return localOrder.value
    .map((id) => map.get(id))
    .filter((t): t is Template => t !== undefined);
});

function onCardDragStart(tpl: Template, _e: DragEvent) {
  draggingId.value = tpl.id;
  // 记录 dragstart 时的顺序快照，用于判断拖拽期间顺序是否真的变化过
  orderChangedDuringDrag = false;
}

/**
 * dragend：拖拽真正结束的可靠钩子（drop 在某些 webview 不触发）
 *
 * 策略：
 * - 如果拖拽期间 localOrder 变化过（dragover 让位过）→ 直接持久化新顺序
 * - 如果完全没变化（拖出区域 / 没触发让位）→ 不做任何事
 */
async function onCardDragEnd() {
  const finalOrder = [...localOrder.value];
  const draggingIdSnapshot = draggingId.value;
  draggingId.value = null;
  if (!orderChangedDuringDrag || !draggingIdSnapshot) {
    return;
  }
  // 持久化最终顺序（drop 不触发的兜底）
  try {
    await templateStore.reorderTemplates(finalOrder);
  } catch (e) {
    Message.error("保存顺序失败：" + String(e));
    // 失败回滚
    localOrder.value = templateStore.sortedTemplates.map((t) => t.id);
  }
}

/**
 * 根据鼠标坐标计算 dragging 应该插入的目标 index
 *
 * 遍历所有非 dragging 卡片，找到第一张「鼠标在其前半段」的卡
 * （鼠标 X 在该卡左半 = 同行的左/同列的上半；鼠标 Y 在该卡上半 = 不同行的上），
 * dragging 就插到它前面；如果鼠标在所有卡的后半段，dragging 插到最后。
 *
 * 关键：用「鼠标 X 在卡中心及以前」判定，鼠标正好在中心也算"插前面"，
 * 这样从右往左/从下往上拖到卡片中心区域时也能立刻识别落位（修复从后往前
 * 拖时必须拖到卡片极左/极上才生效的问题）。
 *
 * 这个算法不依赖进入哪张卡的事件，鼠标在间隙/边缘也能识别。
 */
function computeTargetIndex(clientX: number, clientY: number): number {
  if (!gridRef.value) return -1;
  const cards = Array.from(gridRef.value.querySelectorAll<HTMLElement>(".tpl-card"));
  // dragging 自己跳过
  const otherCards = cards.filter((c) => c.getAttribute("data-id") !== draggingId.value);
  for (let i = 0; i < otherCards.length; i++) {
    const rect = otherCards[i].getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    // 判定鼠标是否在该卡"前半段"：
    // - 同一行（Y 在卡的上下界内）：X ≤ 中心 → 前面
    // - 不同行：Y < 中心 → 前面（鼠标在更上面的行）
    const sameRow = clientY >= rect.top && clientY <= rect.bottom;
    if ((sameRow && clientX <= centerX) || (!sameRow && clientY < centerY)) {
      const id = otherCards[i].getAttribute("data-id")!;
      const withoutDragging = localOrder.value.filter((x) => x !== draggingId.value);
      return withoutDragging.indexOf(id);
    }
  }
  // 鼠标在所有卡后面 → 插到末尾
  return localOrder.value.length - 1;
}

/** grid 容器级 dragover：实时调整 localOrder，触发 FLIP 让位动画 */
function onGridDragOver(e: DragEvent) {
  if (!draggingId.value) return;
  e.preventDefault();
  e.dataTransfer!.dropEffect = "move";

  const targetIdx = computeTargetIndex(e.clientX, e.clientY);
  if (targetIdx < 0) return;

  const withoutDragging = localOrder.value.filter((id) => id !== draggingId.value);
  // targetIdx 是「在 withoutDragging 中的位置」，限制范围
  const clampedIdx = Math.max(0, Math.min(targetIdx, withoutDragging.length));
  withoutDragging.splice(clampedIdx, 0, draggingId.value);

  // 仅当顺序真正变化时才赋值（避免无限 dragover 触发响应式更新）
  const changed = withoutDragging.some((id, i) => id !== localOrder.value[i]);
  if (changed) {
    localOrder.value = withoutDragging;
    orderChangedDuringDrag = true;
  }
}

/** grid 容器级 drop：标记已 drop（dragend 时优先用 drop 路径，避免双持久化） */
async function onGridDrop(e: DragEvent) {
  if (!draggingId.value) return;
  e.preventDefault();
  e.stopPropagation();
  // drop 已触发时，立刻持久化并清状态；dragend 会再次触发但 orderChangedDuringDrag
  // 此时 draggingId 已清空，会直接 return，不会重复持久化
  const newOrder = [...localOrder.value];
  draggingId.value = null;
  orderChangedDuringDrag = false; // 已 drop，dragend 不再处理
  try {
    await templateStore.reorderTemplates(newOrder);
  } catch (err) {
    Message.error("保存顺序失败：" + String(err));
    localOrder.value = templateStore.sortedTemplates.map((t) => t.id);
  }
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
    <!-- 外层 div 挂 dragover/drop（避免 TransitionGroup tag=div 事件绑定兼容问题）；
         根据鼠标坐标统一计算落位，不依赖进入某张卡的精确事件，间隙/边缘也能识别。
         内层 TransitionGroup 用 display:contents 让卡片直接参与外层 grid 布局，
         不引入多余的层级。 -->
    <div
      v-else
      ref="gridRef"
      class="tpl-section__grid"
      @dragover="onGridDragOver"
      @drop="onGridDrop"
    >
      <TransitionGroup name="tpl-flip" tag="div" class="tpl-section__grid-inner">
        <TemplateCard
          v-for="tpl in orderedTemplates"
          :key="tpl.id"
          :data-id="tpl.id"
          :template="tpl"
          @edit="openEdit"
          @apply="applyDirectly"
          @rename="openRename"
          @delete="confirmDelete"
          @dragstart="onCardDragStart"
          @dragend="onCardDragEnd"
        />
      </TransitionGroup>
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

    <!-- 删除二次确认弹窗（极简卡片风，与任务详情同款）-->
    <a-modal
      :visible="deleteConfirmVisible"
      :width="400"
      :footer="false"
      :mask-style="{ backgroundColor: 'rgba(0,0,0,0.35)' }"
      modal-class="confirm-dialog-modal"
      :modal-style="{ maxWidth: 'calc(100vw - 32px)' }"
      @cancel="cancelDelete"
    >
      <div class="confirm-dialog">
        <div class="confirm-dialog__title">
          <span class="confirm-dialog__icon">
            <IconExclamationCircle :size="16" />
          </span>
          <span>删除模板「<strong>{{ pendingDelete?.name }}</strong>」？</span>
        </div>
        <p class="confirm-dialog__desc">此操作无法撤销。</p>
        <div class="confirm-dialog__footer">
          <a-button @click="cancelDelete">取消</a-button>
          <a-button status="danger" type="primary" :loading="deleting" @click="doDelete">
            删除
          </a-button>
        </div>
      </div>
    </a-modal>
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
/* TransitionGroup 内层 wrapper：display:contents 让卡片直接进入外层 grid，
   不引入额外层级（保证 grid 自适应列数正常工作）*/
.tpl-section__grid-inner {
  display: contents;
}

/* === TransitionGroup FLIP 动画（拖拽实时让位）===
   关键：.tpl-flip-move 让位置变化的元素平滑过渡。
   ⚠️ Grid 布局下 FLIP 不工作（grid 重排会瞬间跳到新位置），
   所以这里用 transition 让所有元素同时过渡到新位置（接近 FLIP 效果）。 */
.tpl-flip-move {
  transition: transform 0.25s cubic-bezier(0.2, 0, 0, 1);
}
/* 源卡片半透明（在子组件 .tpl-card--dragging 控制），过渡更平滑 */
.tpl-flip-enter-active,
.tpl-flip-leave-active {
  transition: all 0.25s ease;
}
.tpl-flip-leave-active {
  position: absolute;
}
.tpl-flip-enter-from,
.tpl-flip-leave-to {
  opacity: 0;
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
