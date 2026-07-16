<script setup lang="ts">
// SlashCommandMenu —— Tiptap @tiptap/suggestion 配套菜单
// 由父级 suggestion plugin 控制 open / close；当前菜单的所有键盘交互由本组件内部处理
// （↑↓ 改选中、Enter/Tab 执行、Esc 关闭）。
//
// 注意：本组件**不用 trigger 槽**，MenuPopover 用受控 visible 模式，
// 避免与编辑器外的点击关闭产生冲突。
import { ref, computed, watch, onMounted, onBeforeUnmount } from "vue";
import type { Editor } from "@tiptap/vue-3";
import { exitSuggestion, SuggestionPluginKey } from "@tiptap/suggestion";
import MenuPopoverItem from "./MenuPopoverItem.vue";

export type SlashCommandItem = {
  /** 唯一 key */
  key: string;
  /** 列表显示文字 */
  title: string;
  /** 副标题（提示这个 block 是干嘛的） */
  description?: string;
  /** Arco icon 名（暂留位：目前 v1 不在菜单项内显示图标） */
  icon?: string;
  /** 用于过滤的关键词（默认包含 title） */
  keywords?: string[];
};

const props = defineProps<{
  items: SlashCommandItem[];
  query: string;
  editor: Editor | null;
  /** 是否打开（受父级 suggestion 控制） */
  open: boolean;
  /** 弹层 anchor rect（来自 suggestion utility 的 clientRect） */
  rect?: { left: number; top: number; bottom: number } | null;
  /**
   * 选中某项时调用。由 RichTextEditor 注入，本质是
   * `props.command({editor, range, props: item})`。
   * 命令负责删除已输入的 "/xxx" 范围并切换 block 类型。
   */
  onSelectCommand?: (item: SlashCommandItem) => void;
}>();

const emit = defineEmits<{
  close: [];
}>();

const selectedIndex = ref(0);

/** 过滤 + 大小写不敏感的匹配 */
const filteredItems = computed(() => {
  const q = props.query.trim().toLowerCase();
  if (!q) return props.items;
  return props.items.filter((it) => {
    const hay = [it.title, it.description ?? "", ...(it.keywords ?? [])]
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });
});

watch(
  () => props.query,
  () => {
    selectedIndex.value = 0;
  },
);

watch(
  () => filteredItems.value.length,
  (n) => {
    if (selectedIndex.value >= n) selectedIndex.value = Math.max(0, n - 1);
  },
);

function selectItem(item: SlashCommandItem) {
  // 由 RichTextEditor 注入：内含 props.command(item) 调用，
  // Suggestion utility 会 dispatch 我们在外层 Suggestion({command}) 配置里
  // 给出的回调（deleteRange + runSlashCommand）。
  props.onSelectCommand?.(item);
  emit("close");
}

/** 全局键盘：↑↓ Enter Esc（捕获 suggestion 期间的按键） */
function onKeyDown(e: KeyboardEvent) {
  if (!props.open) return;
  // Backspace / Delete / 任何字符键：关弹窗 + exitSuggestion 让 Suggestion utility 退出，
  // 让 Tiptap 自己处理字符输入/删除（用户可正常退格删除已输入的 "/xxx"）。
  if (
    e.key === "Backspace" ||
    e.key === "Delete" ||
    (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey)
  ) {
    if (props.editor) {
      try {
        // 让 Suggestion plugin 主动退出，下次 update 触发 onExit。
        exitSuggestion(props.editor.view, SuggestionPluginKey);
      } catch {
        /* 无 view 时忽略 */
      }
    }
    emit("close");
    return; // 不要 preventDefault，让键走到 ProseMirror
  }
  if (filteredItems.value.length === 0) {
    if (e.key === "Escape") {
      e.preventDefault();
      emit("close");
    }
    return;
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    selectedIndex.value = (selectedIndex.value + 1) % filteredItems.value.length;
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    selectedIndex.value =
      (selectedIndex.value - 1 + filteredItems.value.length) %
      filteredItems.value.length;
  } else if (e.key === "Enter" || e.key === "Tab") {
    e.preventDefault();
    const item = filteredItems.value[selectedIndex.value];
    if (item) selectItem(item);
  } else if (e.key === "Escape") {
    e.preventDefault();
    emit("close");
  }
}

onMounted(() => {
  window.addEventListener("keydown", onKeyDown, true);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeyDown, true);
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open && rect"
      class="slash-menu"
      :style="{
        position: 'fixed',
        left: rect.left + 'px',
        top: rect.bottom + 6 + 'px',
        zIndex: 9999,
      }"
    >
      <div class="slash-menu__container">
        <div
          v-if="filteredItems.length === 0"
          class="slash-menu__empty"
        >
          无匹配项
        </div>
        <MenuPopoverItem
          v-for="(item, i) in filteredItems"
          :key="item.key"
          :active="i === selectedIndex"
          @click="selectItem(item)"
        >
          <span class="slash-menu__title">{{ item.title }}</span>
          <span v-if="item.description" class="slash-menu__desc">{{ item.description }}</span>
        </MenuPopoverItem>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.slash-menu__container {
  width: max-content;
  min-width: 200px;
  max-width: 280px;
  background: var(--jt-surface);
  border-radius: 12px;
  box-shadow:
    0 8px 32px rgba(0, 0, 0, 0.08),
    0 2px 8px rgba(0, 0, 0, 0.04);
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.slash-menu__empty {
  padding: 12px 14px;
  font-size: 12px;
  color: var(--jt-text-tertiary);
  font-family: var(--font-body);
}

.slash-menu__title {
  font-weight: 500;
  font-size: 13px;
}

.slash-menu__desc {
  margin-left: auto;
  font-size: 11px;
  color: var(--jt-text-tertiary);
  font-family: var(--font-body);
}
</style>
