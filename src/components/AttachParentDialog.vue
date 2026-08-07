<script setup lang="ts">
// 关联主任务弹窗 —— 把当前任务挂到某个一级任务下作为子任务。
//
// 数据：打开时调 db.getRootCandidates（全部清单的未完成一级任务，排除自身），
// 本地用输入框文本过滤（标题包含，不区分大小写）。
// 选中后 emit('select', parentId)，由父组件调 store.attachToParent 持久化。
//
// 骨架参照 SearchPalette：a-modal + 输入框 + 键盘导航列表（↑↓ + Enter + ESC）。
import { ref, computed, watch, nextTick } from "vue";
import { useListStore } from "@/stores/list";
import { getRootCandidates } from "@/api/db";
import type { Task } from "@/types";

const props = defineProps<{
  /** 弹窗可见性（v-model:visible） */
  visible: boolean;
  /** 要关联的任务 id（候选列表排除它） */
  taskId: string;
  /** 当前主任务 id（若有，用于高亮当前关联） */
  currentParentId: string | null;
}>();

const emit = defineEmits<{
  "update:visible": [value: boolean];
  /** 选中一个主任务 */
  select: [parentId: string];
}>();

const listStore = useListStore();
const inputRef = ref<HTMLInputElement | null>(null);
const selectedIndex = ref(0);
const query = ref("");
/** 候选任务（打开时加载一次） */
const candidates = ref<Task[]>([]);

/** 按标题过滤后的候选列表（不区分大小写） */
const filtered = computed<Task[]>(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return candidates.value;
  return candidates.value.filter((t) => t.title.toLowerCase().includes(q));
});

/** 弹窗打开时加载候选 + 聚焦输入框；关闭时清空状态 */
watch(
  () => props.visible,
  async (isOpen) => {
    if (isOpen) {
      query.value = "";
      selectedIndex.value = 0;
      try {
        candidates.value = await getRootCandidates(props.taskId);
      } catch {
        candidates.value = [];
      }
      await nextTick();
      inputRef.value?.focus();
    } else {
      candidates.value = [];
      query.value = "";
    }
  },
);

// 过滤结果变化时重置选中项
watch(filtered, () => {
  selectedIndex.value = 0;
});

function getListName(listId: string): string {
  return listStore.getById(listId)?.name ?? "";
}

function onSelect(index: number): void {
  const task = filtered.value[index];
  if (!task) return;
  emit("select", task.id);
  emit("update:visible", false);
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    selectedIndex.value = Math.min(selectedIndex.value + 1, filtered.value.length - 1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    selectedIndex.value = Math.max(selectedIndex.value - 1, 0);
  } else if (e.key === "Enter") {
    e.preventDefault();
    onSelect(selectedIndex.value);
  } else if (e.key === "Escape") {
    emit("update:visible", false);
  }
}
</script>

<template>
  <a-modal
    :visible="visible"
    :width="600"
    :mask-closable="true"
    :footer="false"
    :mask-style="{ backgroundColor: 'rgba(0,0,0,0.35)' }"
    modal-class="attach-parent-modal"
    wrap-class="attach-parent-wrap"
    @update:visible="(v) => emit('update:visible', v)"
  >
    <div class="attach-parent">
      <!-- 标题 -->
      <div class="attach-parent__header">关联主任务</div>

      <!-- 搜索输入 -->
      <div class="attach-parent__input-row">
        <icon-search :size="18" class="attach-parent__icon" />
        <input
          ref="inputRef"
          v-model="query"
          class="attach-parent__input"
          placeholder="搜索一级任务..."
          @keydown="onKeyDown"
        />
      </div>

      <a-divider :margin="0" />

      <!-- 候选列表 -->
      <div class="attach-parent__results">
        <!-- 无候选任务 -->
        <div v-if="candidates.length === 0" class="attach-parent__empty">
          <p>暂无可关联的一级任务</p>
          <p class="attach-parent__empty-hint">一级任务（未完成的根任务）才能作为主任务</p>
        </div>

        <!-- 搜索无结果 -->
        <div v-else-if="filtered.length === 0" class="attach-parent__empty">
          <p>没有匹配的任务</p>
        </div>

        <!-- 候选列表 -->
        <div v-else>
          <div
            v-for="(task, i) in filtered"
            :key="task.id"
            class="attach-parent__result"
            :class="{
              'attach-parent__result--active': i === selectedIndex,
              'attach-parent__result--current': task.id === currentParentId,
            }"
            @click="onSelect(i)"
            @mouseenter="selectedIndex = i"
          >
            <icon-check-square :size="16" class="attach-parent__result-icon" />
            <div class="attach-parent__result-body">
              <span class="attach-parent__result-title">{{ task.title || "（无标题）" }}</span>
              <span class="attach-parent__result-meta">{{ getListName(task.listId) }}</span>
            </div>
            <!-- 当前已关联的主任务显示标记 -->
            <span v-if="task.id === currentParentId" class="attach-parent__current-tag">当前</span>
          </div>
        </div>
      </div>

      <a-divider :margin="0" />
      <div class="attach-parent__footer">
        <span><kbd class="font-mono">↑↓</kbd> 选择</span>
        <span><kbd class="font-mono">↵</kbd> 关联</span>
        <span><kbd class="font-mono">ESC</kbd> 关闭</span>
      </div>
    </div>
  </a-modal>
</template>

<style scoped>
.attach-parent {
  overflow: hidden;
}

.attach-parent__header {
  padding: 16px 20px 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--jt-text-primary);
}

.attach-parent__input-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 20px 12px;
}

.attach-parent__icon {
  color: var(--jt-text-tertiary);
  flex-shrink: 0;
}

.attach-parent__input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  font-size: 15px;
  font-family: var(--font-body);
  color: inherit;
}

.attach-parent__results {
  max-height: 280px;
  overflow-y: auto;
  padding: 6px 8px;
}

.attach-parent__result {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: 8px;
  cursor: pointer;
  transition: background-color 0.12s;
}
.attach-parent__result--active {
  background-color: var(--jt-surface-hover);
}
/* 当前已关联的主任务：主色软背景 */
.attach-parent__result--current {
  color: var(--jt-primary);
}

.attach-parent__result-icon {
  color: var(--jt-text-tertiary);
  flex-shrink: 0;
}

.attach-parent__result-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.attach-parent__result-title {
  font-size: 14px;
  color: var(--jt-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.attach-parent__result-meta {
  font-size: 12px;
  color: var(--jt-text-tertiary);
}

.attach-parent__current-tag {
  font-size: 11px;
  color: var(--jt-primary);
  background-color: var(--jt-primary-bg, rgba(79, 70, 229, 0.1));
  padding: 2px 6px;
  border-radius: 4px;
  flex-shrink: 0;
}

.attach-parent__empty {
  padding: 40px 20px;
  text-align: center;
  color: var(--jt-text-tertiary);
}
.attach-parent__empty p {
  margin: 4px 0;
  font-size: 14px;
}
.attach-parent__empty-hint {
  font-size: 12px !important;
  opacity: 0.7;
}

.attach-parent__footer {
  display: flex;
  gap: 20px;
  padding: 10px 20px;
  font-size: 12px;
  color: var(--jt-text-tertiary);
}
.attach-parent__footer kbd {
  background: var(--jt-surface-hover);
  padding: 1px 5px;
  border-radius: 3px;
  margin-right: 3px;
}
</style>
