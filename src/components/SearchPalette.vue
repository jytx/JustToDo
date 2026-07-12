<script setup lang="ts">
// 搜索面板 —— Command Palette 风格，居中浮出
// 快捷键 Cmd+K / Ctrl+K 唤起
import { ref, watch, nextTick, computed } from "vue";
import { useRouter } from "vue-router";
import { useSearchStore } from "@/stores/search";
import { useTaskStore } from "@/stores/task";
import { useListStore } from "@/stores/list";
import { formatDueDate } from "@/utils/date";

const searchStore = useSearchStore();
const taskStore = useTaskStore();
const listStore = useListStore();
const router = useRouter();

const inputRef = ref<HTMLInputElement | null>(null);
const selectedIndex = ref(0);

const results = computed(() => searchStore.results);

watch(
  () => searchStore.open,
  async (isOpen) => {
    if (isOpen) {
      selectedIndex.value = 0;
      await nextTick();
      inputRef.value?.focus();
    }
  },
);

watch(results, () => {
  selectedIndex.value = 0;
});

function onInput(e: Event) {
  const value = (e.target as HTMLInputElement).value;
  searchStore.search(value);
}

function selectResult(index: number) {
  const task = results.value[index];
  if (!task) return;

  // 跳转到任务所在清单，并选中该任务
  router.push(`/list/${task.listId}`);
  // 等路由加载后选中任务
  setTimeout(() => {
    taskStore.selectTask(task.id);
  }, 300);

  searchStore.hide();
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    selectedIndex.value = Math.min(selectedIndex.value + 1, results.value.length - 1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    selectedIndex.value = Math.max(selectedIndex.value - 1, 0);
  } else if (e.key === "Enter") {
    e.preventDefault();
    selectResult(selectedIndex.value);
  } else if (e.key === "Escape") {
    searchStore.hide();
  }
}

function getListName(listId: string): string {
  return listStore.getById(listId)?.name ?? "";
}

function getDueInfo(dueStartAt: string | null, dueEndAt: string | null) {
  return formatDueDate(dueStartAt, dueEndAt);
}
</script>

<template>
  <a-modal
    :visible="searchStore.open"
    @update:visible="(v) => !v && searchStore.hide()"
    :width="560"
    :mask-closable="true"
    :footer="false"
    :mask-style="{ backgroundColor: 'rgba(0,0,0,0.4)' }"
    modal-class="search-palette-modal"
    wrap-class="search-palette-wrap"
  >
    <div class="search-palette">
      <!-- 搜索输入 -->
      <div class="search-palette__input-row">
        <icon-search :size="20" class="search-palette__icon" />
        <input
          ref="inputRef"
          :value="searchStore.query"
          @input="onInput"
          @keydown="onKeyDown"
          class="search-palette__input"
          placeholder="搜索任务、清单、标签..."
        />
        <span class="search-palette__esc font-mono">ESC</span>
      </div>

      <a-divider :margin="0" />

      <!-- 搜索结果 -->
      <div class="search-palette__results">
        <div v-if="searchStore.loading" class="search-palette__hint">
          搜索中...
        </div>

        <div v-else-if="results.length === 0 && searchStore.query" class="search-palette__empty">
          <icon-search :size="32" class="search-palette__empty-icon" />
          <p>没有找到相关内容</p>
          <p class="search-palette__empty-hint">试试其他关键词</p>
        </div>

        <div v-else-if="results.length === 0" class="search-palette__hint">
          输入关键词搜索任务
        </div>

        <div v-else>
          <div class="search-palette__section-title">任务</div>
          <div
            v-for="(task, i) in results"
            :key="task.id"
            class="search-palette__result"
            :class="{ 'search-palette__result--active': i === selectedIndex }"
            @click="selectResult(i)"
            @mouseenter="selectedIndex = i"
          >
            <icon-check-square :size="16" />
            <div class="search-palette__result-body">
              <span class="search-palette__result-title">{{ task.title }}</span>
              <span class="search-palette__result-meta">
                {{ getListName(task.listId) }}
                <template v-if="getDueInfo(task.dueStartAt, task.dueEndAt)">
                  · {{ getDueInfo(task.dueStartAt, task.dueEndAt)?.text }}
                </template>
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- 底部提示 -->
      <a-divider :margin="0" />
      <div class="search-palette__footer">
        <span><kbd class="font-mono">↑↓</kbd> 选择</span>
        <span><kbd class="font-mono">↵</kbd> 打开</span>
        <span><kbd class="font-mono">ESC</kbd> 关闭</span>
      </div>
    </div>
  </a-modal>
</template>

<style scoped>
.search-palette {
  overflow: hidden;
}

.search-palette__input-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 20px;
}

.search-palette__icon {
  color: var(--jt-text-tertiary);
}

.search-palette__input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  font-size: 16px;
  font-family: var(--font-body);
  color: inherit;
}

.search-palette__esc {
  font-size: 11px;
  color: var(--jt-text-tertiary);
  border: 1px solid var(--jt-border);
  border-radius: 4px;
  padding: 2px 6px;
}

.search-palette__results {
  max-height: 360px;
  overflow-y: auto;
  padding: 8px;
}

.search-palette__section-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--jt-text-tertiary);
  padding: 8px 12px 4px;
}

.search-palette__result {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 8px;
  cursor: pointer;
  transition: background-color 0.1s;
}

.search-palette__result--active {
  background-color: var(--jt-accent-soft);
}

.search-palette__result-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.search-palette__result-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--jt-text-primary);
}

.search-palette__result-meta {
  font-size: 12px;
  color: var(--jt-text-secondary);
}

.search-palette__empty,
.search-palette__hint {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 48px 20px;
  text-align: center;
  color: var(--jt-text-tertiary);
  font-size: 14px;
}

.search-palette__empty-icon {
  margin-bottom: 12px;
  opacity: 0.5;
}

.search-palette__empty-hint {
  font-size: 12px;
  margin-top: 4px;
}

.search-palette__footer {
  display: flex;
  gap: 16px;
  padding: 10px 20px;
  font-size: 12px;
  color: var(--jt-text-tertiary);
}

.search-palette__footer kbd {
  background: var(--jt-surface-sunken);
  border: 1px solid var(--jt-border);
  border-radius: 4px;
  padding: 1px 5px;
  font-size: 11px;
}
</style>

<style>
/* 顶部对齐的命令面板外观，覆盖默认居中样式 */
.search-palette-wrap .arco-modal {
  top: 80px;
  vertical-align: top;
}
.search-palette-modal .arco-modal-body {
  padding: 0;
}
</style>
