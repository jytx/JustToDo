<script setup lang="ts">
// 标签选择 chip + popover —— 添加任务栏 / 快速添加弹窗 共用
// 点击触发下拉：可选标签列表（已选自动过滤）+ 底部「+ 新建标签」输入框。
// 已选标签以小 chip 收纳在 popover 顶部（可点 × 移除）；
// 属性行仅显示「标签 +N」汇总，避免多选时 chip 撑爆输入栏（参考滴答清单）。
// 对外仅暴露 v-model:selectedTagIds（string[]），关联/落库由上层（createTask）统一处理，
// 这里只负责收集 ID —— 包括"输入新标签名 → getByName/createTag 拿到 id 后加入数组"。
import { ref, computed, nextTick, watch } from "vue";
import { useTagStore } from "@/stores/tag";
import { tagBg, LIST_COLORS } from "@/utils/colors";
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
/** 新建标签输入框引用 —— 打开弹层后自动聚焦 */
const newTagInputRef = ref<HTMLInputElement | null>(null);
const newTagName = ref("");

/** 弹层显隐变化时通知宿主（宿主据此决定是否保持输入框聚焦等） */
watch(visible, (v) => emit("open-change", v));

/** 已选标签对象（按 id 从全局标签列表映射；含被建出来的新标签） */
const selectedTags = computed(() => {
  const ids = new Set(props.selectedTagIds);
  return tagStore.tags.filter((t) => ids.has(t.id));
});

/** 可选标签（排除已选） */
const availableTags = computed(() => {
  const selected = new Set(props.selectedTagIds);
  return tagStore.tags.filter((t) => !selected.has(t.id));
});

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

/** 切换某标签的选中态（点可选项 = 加入；点已选 chip 的 × = 移除） */
function addTag(tagId: string): void {
  if (props.selectedTagIds.includes(tagId)) return;
  emitIds([...props.selectedTagIds, tagId]);
}

function removeTag(tagId: string): void {
  emitIds(props.selectedTagIds.filter((id) => id !== tagId));
}

/** 提交新建标签：trim → getByName 命中则复用，否则 createTag；拿到 id 后加入已选。
 *  与 TaskDetailPanel.createNewTag 同一路径，保证标签全局唯一。 */
async function submitNewTag(): Promise<void> {
  const name = newTagName.value.trim();
  if (!name) return;
  let tag = tagStore.getByName(name);
  if (!tag) {
    tag = await tagStore.createTag(name, LIST_COLORS[0]);
  }
  addTag(tag.id);
  newTagName.value = "";
  // 关闭弹层（保持与详情面板"选完即关"一致）
  visible.value = false;
}

/** 打开弹层时聚焦新建输入框 */
function onAfterOpen(): void {
  nextTick(() => {
    newTagInputRef.value?.focus();
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
      <!-- 已选标签区（有已选时置顶显示，可点 × 移除；多选自动换行） -->
      <div v-if="selectedTags.length > 0" class="tag-select__selected">
        <span
          v-for="tag in selectedTags"
          :key="tag.id"
          class="tag-select__chip"
          :style="{ backgroundColor: tagBg(tag.color) }"
        >
          <span class="tag-select__chip-name">{{ tag.name }}</span>
          <button
            type="button"
            class="tag-select__chip-close"
            title="移除标签"
            @click="removeTag(tag.id)"
          >
            <icon-close :size="10" />
          </button>
        </span>
      </div>
      <!-- 可选标签列表（空标签时显示占位） -->
      <div v-if="availableTags.length > 0" class="tag-select__list">
        <button
          v-for="tag in availableTags"
          :key="tag.id"
          type="button"
          class="tag-select__option"
          @click="addTag(tag.id)"
        >
          <span class="tag-select__dot" :style="{ backgroundColor: tag.color }" />
          <span>{{ tag.name }}</span>
        </button>
      </div>
      <div v-else class="tag-select__empty">所有标签已选中</div>

      <!-- 新建标签输入框 -->
      <input
        ref="newTagInputRef"
        v-model="newTagName"
        class="tag-select__new-input"
        placeholder="+ 新建标签"
        @keydown.enter.prevent="submitNewTag"
      />
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

/* 已选标签区（popover 内置顶，多选时自动换行；与下方可选列表用分隔线区分） */
.tag-select__selected {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  max-height: 120px;
  overflow-y: auto;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--jt-border);
}

.tag-select__chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 22px;
  padding: 0 4px 0 8px;
  border-radius: 11px;
  /* 底色由 inline style 按标签颜色控制；文字色统一灰色 */
  color: var(--jt-text-secondary);
  font-size: 11px;
  font-family: var(--font-body);
  line-height: 1;
  white-space: nowrap;
}

.tag-select__chip-name {
  max-width: 100px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tag-select__chip-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--jt-primary);
  cursor: pointer;
  transition: background-color 0.12s ease;
  flex-shrink: 0;
}

.tag-select__chip-close:hover {
  background-color: color-mix(in srgb, var(--jt-primary) 20%, transparent);
}

/* 深色模式弹层阴影加深 */
body[arco-theme="dark"] .tag-select__popup {
  box-shadow:
    0 6px 20px rgba(0, 0, 0, 0.4),
    0 2px 6px rgba(0, 0, 0, 0.3);
}
</style>
