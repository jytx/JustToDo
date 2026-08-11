<script setup lang="ts">
// 标签选择 chip + popover —— 添加任务栏 / 快速添加弹窗 共用
// 点击触发下拉：可选标签列表（已选自动过滤）+ 底部「+ 新建标签」输入框。
// 已选标签以小 chip 收纳在 popover 顶部（可点 × 移除）；
// 属性行仅显示「标签 +N」汇总，避免多选时 chip 撑爆输入栏（参考滴答清单）。
// 对外仅暴露 v-model:selectedTagIds（string[]），关联/落库由上层（createTask）统一处理，
// 这里只负责收集 ID —— 包括"输入新标签名 → getByName/createTag 拿到 id 后加入数组"。
import { ref, computed, nextTick, watch } from "vue";
import { useTagStore } from "@/stores/tag";
import { LIST_COLORS } from "@/utils/colors";
import Popover from "./Popover.vue";

const props = defineProps<{
  /** 已选标签 ID 数组（v-model） */
  selectedTagIds: string[];
  /** 弹层位置：bottom-* 默认（添加栏在顶部用）；top-* 用于弹窗底部属性行（朝上开避免超窗） */
  placement?:
    | "bottom-left"
    | "bottom-right"
    | "bottom-center"
    | "top-left"
    | "top-right"
    | "top-center";
  /** 触发器外观：'text' = 文字按钮（与 AddTaskBar 优先级/模板按钮一致）；
   *  'chip' = 胶囊按钮（与 QuickAddDialog 属性行一致） */
  variant?: "text" | "chip";
}>();

const emit = defineEmits<{
  "update:selectedTagIds": [value: string[]];
  /** 弹层显隐变化 —— 供宿主感知（如 AddTaskBar 据此在标签下拉打开时保持输入框聚焦） */
  "open-change": [visible: boolean];
}>();

const tagStore = useTagStore();

const visible = ref(false);
/** 搜索/新建输入框引用 —— 打开弹层后自动聚焦 */
const searchInputRef = ref<HTMLInputElement | null>(null);
/** 搜索关键词 —— 实时过滤标签列表；回车时作为新标签名或精确匹配已有标签 */
const searchQuery = ref("");

/** 弹层显隐变化时通知宿主（宿主据此决定是否保持输入框聚焦等） */
watch(visible, (v) => emit("open-change", v));

/** 已选标签对象（按 id 从全局标签列表映射；含被建出来的新标签） */
const selectedTags = computed(() => {
  const ids = new Set(props.selectedTagIds);
  return tagStore.tags.filter((t) => ids.has(t.id));
});

/** 标签选项（含已选，多选模式靠 active 态区分）；按搜索关键词模糊匹配名称 */
const tagOptions = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  const all = tagStore.tags.map((t) => ({ id: t.id, name: t.name, color: t.color }));
  if (!q) return all;
  return all.filter((t) => t.name.toLowerCase().includes(q));
});

/** 判断某标签是否已选（列表项 active 态 + ✓ 显示用） */
function isTagSelected(tagId: string): boolean {
  return props.selectedTagIds.includes(tagId);
}

/** 触发器显示文案 */
const triggerLabel = computed(() => {
  if (selectedTags.value.length === 0) return "标签";
  if (selectedTags.value.length === 1) return selectedTags.value[0].name;
  return `${selectedTags.value[0].name} +${selectedTags.value.length - 1}`;
});

/** 产生新数组引用，触发 v-model 更新（纯函数：不改入参） */
function emitIds(next: string[]): void {
  emit("update:selectedTagIds", next);
}

/** 新建标签后加入已选（新建的标签必然未选，直接加入） */
function addTag(tagId: string): void {
  if (props.selectedTagIds.includes(tagId)) return;
  emitIds([...props.selectedTagIds, tagId]);
}

/** 标签 toggle（多选模式核心）：已选 → 移除；未选 → 添加。不关弹层，可连续操作。 */
function toggleTag(tagId: string): void {
  if (isTagSelected(tagId)) {
    emitIds(props.selectedTagIds.filter((id) => id !== tagId));
  } else {
    emitIds([...props.selectedTagIds, tagId]);
  }
}

/** 提交新建标签：trim → getByName 命中则复用，否则 createTag；拿到 id 后加入已选。
 *  与 TaskDetailPanel.createNewTag 同一路径，保证标签全局唯一。 */
async function submitNewTag(): Promise<void> {
  const name = searchQuery.value.trim();
  if (!name) return;
  // 精确匹配已有标签则复用，否则以输入文本新建
  let tag = tagStore.getByName(name);
  if (!tag) {
    tag = await tagStore.createTag(name, LIST_COLORS[0]);
  }
  addTag(tag.id);
  // 清空搜索，弹窗保持打开便于连续添加多个标签
  searchQuery.value = "";
}

/** 打开弹层时聚焦新建输入框 */
function onAfterOpen(): void {
  nextTick(() => {
    searchInputRef.value?.focus();
  });
}
</script>

<template>
  <Popover
    v-model:visible="visible"
    :placement="placement ?? 'bottom-left'"
    @update:visible="(v) => v && onAfterOpen()"
  >
    <template #trigger>
      <!-- 文字按钮变体（AddTaskBar 属性行，与优先级/模板按钮同款） -->
      <button
        v-if="variant === 'text'"
        type="button"
        class="tag-select__trigger tag-select__trigger--text"
        :class="{ 'tag-select__trigger--active': selectedTagIds.length > 0 }"
        @click="visible = !visible"
      >
        <icon-tag :size="14" />
        <span>{{ triggerLabel }}</span>
      </button>
      <!-- 胶囊按钮变体（QuickAddDialog 属性行） -->
      <button
        v-else
        type="button"
        class="tag-select__trigger"
        :class="{ 'tag-select__trigger--active': selectedTagIds.length > 0 }"
        @click="visible = !visible"
      >
        <icon-tag :size="14" />
        <span>{{ triggerLabel }}</span>
      </button>
    </template>

    <div class="tag-select__popup">
      <!-- 搜索/新建输入框（置顶，实时过滤下方标签列表） -->
      <input
        ref="searchInputRef"
        v-model="searchQuery"
        class="tag-select__new-input"
        placeholder="搜索或新建标签"
        @keydown.enter.prevent="submitNewTag"
      />

      <!-- 标签列表（按搜索过滤；多选模式：已选项高亮 + ✓，点击 toggle） -->
      <div v-if="tagOptions.length > 0" class="tag-select__list">
        <button
          v-for="opt in tagOptions"
          :key="opt.id"
          type="button"
          class="tag-select__option"
          :class="{ 'tag-select__option--active': isTagSelected(opt.id) }"
          @mousedown.prevent
          @click="toggleTag(opt.id)"
        >
          <span class="tag-select__dot" :style="{ backgroundColor: opt.color }" />
          <span>{{ opt.name }}</span>
          <icon-check v-if="isTagSelected(opt.id)" :size="12" class="tag-select__check" />
        </button>
      </div>
      <!-- 无结果：有搜索词提示回车新建，无搜索词提示输入 -->
      <div v-else class="tag-select__empty">
        {{ searchQuery.trim() ? `没有匹配的标签，回车新建「${searchQuery.trim()}」` : "还没有标签，输入名称新建" }}
      </div>
    </div>
  </Popover>
</template>

<style scoped>
/* 文字按钮变体：复刻 AddTaskBar 里 a-button(type=text, mini) 的外观 */
.tag-select__trigger--text {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 8px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--jt-text-secondary);
  font-size: 12px;
  font-family: var(--font-body);
  line-height: 1;
  white-space: nowrap;
  flex-shrink: 0;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}

/* 胶囊按钮变体：复刻 QuickAddDialog quick-add__trigger 的外观 */
.tag-select__trigger {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  padding: 0 10px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--jt-text-secondary);
  font-family: var(--font-body);
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
  flex-shrink: 0;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}

.tag-select__trigger:hover,
.tag-select__trigger--text:hover {
  background-color: var(--jt-surface-sunken);
  color: var(--jt-text-primary);
}

.tag-select__trigger--active {
  color: var(--jt-text-primary);
}

/* 弹层容器 */
.tag-select__popup {
  min-width: 168px;
  max-width: 220px;
  background: var(--jt-surface);
  border-radius: 8px;
  box-shadow:
    0 6px 20px rgba(0, 0, 0, 0.08),
    0 2px 6px rgba(0, 0, 0, 0.05);
  padding: 4px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.tag-select__list {
  max-height: 240px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* 可选列表项的色点（标识标签颜色） */
.tag-select__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  display: inline-block;
}

/* 弹层内的可选标签项 */
.tag-select__option {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--jt-text-primary);
  font-family: var(--font-body);
  font-size: 13px;
  line-height: 1.4;
  text-align: left;
  cursor: pointer;
  transition: background-color 0.1s ease;
}

.tag-select__option:hover {
  background-color: var(--jt-surface-sunken);
}

/* 已选标签项高亮（多选模式 active 态，与详情面板一致） */
.tag-select__option--active {
  background-color: var(--jt-accent-soft);
  color: var(--jt-primary);
}

/* 已选标签的 ✓ 勾（靠右对齐） */
.tag-select__check {
  margin-left: auto;
  color: var(--jt-primary);
  flex-shrink: 0;
}

.tag-select__empty {
  padding: 8px 10px;
  font-size: 12px;
  color: var(--jt-text-tertiary);
  text-align: center;
}

/* 新建标签输入框 */
.tag-select__new-input {
  width: 100%;
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--jt-border);
  border-radius: 5px;
  background: var(--jt-surface);
  color: var(--jt-text-primary);
  font-size: 13px;
  font-family: var(--font-body);
  outline: none;
  box-sizing: border-box;
}

.tag-select__new-input:focus {
  border-color: color-mix(in srgb, var(--jt-primary) 50%, transparent);
}

.tag-select__new-input::placeholder {
  color: var(--jt-text-tertiary);
}

/* 深色模式弹层阴影加深 */
body[arco-theme="dark"] .tag-select__popup {
  box-shadow:
    0 6px 20px rgba(0, 0, 0, 0.4),
    0 2px 6px rgba(0, 0, 0, 0.3);
}
</style>
