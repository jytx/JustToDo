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
import TableSizePicker from "./TableSizePicker.vue";

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
  /** 表格项专用：hover 二级选 N×N 后调用（由 RichTextEditor 注入，
   *  负责删除 "/表格" 范围 + insertTable(rows, cols)） */
  onPickTable?: (rows: number, cols: number) => void;
}>();

/** 斜杠菜单表格项的 hover 二级菜单开关 */
const tableSubmenuOpen = ref(false);

/** 表格二级选中行列：调父级注入的 onPickTable（删 /表格 + 插表格） */
function onPickTableFromSlash(rows: number, cols: number): void {
  props.onPickTable?.(rows, cols);
  tableSubmenuOpen.value = false;
  emit("close");
}
const emit = defineEmits<{
  close: [];
}>();

const selectedIndex = ref(0);

/** 菜单最大高度（px）—— 与 CSS .slash-menu__container 的 max-height 保持一致 */
const MENU_MAX_HEIGHT = 380;
/** 菜单与光标的垂直间距 */
const MENU_GAP = 6;

/**
 * 计算菜单位置：
 * - 默认在光标下方（top = rect.bottom + gap）
 * - 当下方空间不足（rect.bottom + gap + MENU_MAX_HEIGHT > 视口高度），
 *   且上方空间更大时，改到光标上方（bottom = 视口高度 - rect.top + gap）
 * - left 对齐光标左缘
 */
const menuStyle = computed(() => {
  const base: Record<string, string> = {
    position: "fixed",
    zIndex: "9999",
  };
  const r = props.rect;
  if (!r) {
    base.opacity = "0";
    return base;
  }
  base.left = `${r.left}px`;
  const vh = window.innerHeight;
  const spaceBelow = vh - r.bottom - MENU_GAP;
  const spaceAbove = r.top - MENU_GAP;
  // 下方放不下且上方更宽裕 → 上方弹出
  if (spaceBelow < MENU_MAX_HEIGHT && spaceAbove > spaceBelow) {
    base.bottom = `${vh - r.top + MENU_GAP}px`;
  } else {
    base.top = `${r.bottom + MENU_GAP}px`;
  }
  return base;
});

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

/** 拦截菜单内部的 pointerdown，阻止 Tiptap Suggestion 的「点击外部关闭」误判。
 *
 * 背景：Suggestion 在 document 上用 capture 阶段监听 pointerdown，判断
 * e.target 是否在它的 element 容器内；本菜单 Teleport 到 body，DOM 不在
 * Suggestion 的 element 内，点击会被误判为「点击外部」→ 关闭菜单 →
 * selectItem 还没执行组件就卸载了，鼠标点击不生效。
 *
 * 方案：window 的 capture 早于 document 的 capture，在 window 阶段拦截：
 * 若 pointerdown 落在菜单内，stopImmediatePropagation 阻止 Suggestion 收到。 */
function onPointerDownCapture(e: PointerEvent): void {
  if (!props.open) return;
  const target = e.target as Node | null;
  if (!target) return;
  // 菜单 DOM（Teleport 到 body，根元素 .slash-menu）
  const menuEl = document.querySelector(".slash-menu");
  if (menuEl && menuEl.contains(target)) {
    e.stopImmediatePropagation();
  }
}

/** 选中项变化后，把它滚入菜单可视区（键盘 ↑↓ 连按时跟随滚动）。
 *  watch 回调在 DOM 更新后执行，能拿到最新的 item 元素位置。 */
watch(selectedIndex, () => {
  const container = document.querySelector(".slash-menu__container");
  if (!container) return;
  const items = container.querySelectorAll<HTMLElement>(".menu-popover-item");
  const el = items[selectedIndex.value];
  if (!el) return;
  const cRect = container.getBoundingClientRect();
  const eRect = el.getBoundingClientRect();
  // 选中项在可视区上方 → 向上滚到刚好露出项顶
  if (eRect.top < cRect.top) {
    container.scrollTop -= cRect.top - eRect.top;
  } else if (eRect.bottom > cRect.bottom) {
    // 选中项在可视区下方 → 向下滚到刚好露出项底
    container.scrollTop += eRect.bottom - cRect.bottom;
  }
});

onMounted(() => {
  window.addEventListener("keydown", onKeyDown, true);
  // window capture 早于 document capture，赶在 Suggestion 之前拦截菜单内点击
  window.addEventListener("pointerdown", onPointerDownCapture, true);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeyDown, true);
  window.removeEventListener("pointerdown", onPointerDownCapture, true);
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open && rect"
      class="slash-menu"
      :style="menuStyle"
    >
      <div class="slash-menu__container">
        <div
          v-if="filteredItems.length === 0"
          class="slash-menu__empty"
        >
          无匹配项
        </div>
        <template v-for="(item, i) in filteredItems" :key="item.key">
          <!-- 表格项特殊：hover 展开行列选择器二级菜单 -->
          <div
            v-if="item.key === 'table'"
            class="slash-menu__table-item"
            @mouseenter="tableSubmenuOpen = true"
            @mouseleave="tableSubmenuOpen = false"
          >
            <MenuPopoverItem :active="i === selectedIndex" @click="selectItem(item)">
              <span class="slash-menu__title">{{ item.title }}</span>
              <span v-if="item.description" class="slash-menu__desc">{{ item.description }}</span>
            </MenuPopoverItem>
            <!-- 二级：行列选择器 -->
            <div v-if="tableSubmenuOpen" class="slash-menu__table-submenu">
              <TableSizePicker :on-pick="onPickTableFromSlash" />
            </div>
          </div>
          <!-- 普通项 -->
          <MenuPopoverItem
            v-else
            :active="i === selectedIndex"
            @click="selectItem(item)"
          >
            <span class="slash-menu__title">{{ item.title }}</span>
            <span v-if="item.description" class="slash-menu__desc">{{ item.description }}</span>
          </MenuPopoverItem>
        </template>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.slash-menu__container {
  width: max-content;
  min-width: 200px;
  max-width: 320px;
  /* 限制最大高度，超出滚动（与 JS MENU_MAX_HEIGHT 一致） */
  max-height: 380px;
  overflow-y: auto;
  background: var(--jt-surface);
  border-radius: 12px;
  box-shadow:
    0 8px 32px rgba(0, 0, 0, 0.08),
    0 2px 8px rgba(0, 0, 0, 0.04);
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* 菜单项：H1-H6 扩展后项数增多，原 32px 固定高度过密。
   通过加大垂直 padding 撑开 item，给视觉呼吸空间 */
.slash-menu__container :deep(.menu-popover-item) {
  height: auto;
  padding-top: 10px;
  padding-bottom: 10px;
}

.slash-menu__empty {
  padding: 12px 14px;
  font-size: 12px;
  color: var(--jt-text-tertiary);
  font-family: var(--font-body);
}

/* 表格项容器（hover 展开二级，relative 锚定二级菜单） */
.slash-menu__table-item {
  position: relative;
}
/* 表格二级菜单：浮在一级右侧，背景浮层 */
.slash-menu__table-submenu {
  position: absolute;
  left: 100%;
  top: 0;
  margin-left: 4px;
  background: var(--jt-surface);
  border-radius: 12px;
  box-shadow:
    0 8px 32px rgba(0, 0, 0, 0.08),
    0 2px 8px rgba(0, 0, 0, 0.04);
  z-index: 10;
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
