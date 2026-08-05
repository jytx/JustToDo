<script setup lang="ts">
// 块操作菜单 —— 由块拖拽手柄「纯点击」唤起（非 Suggestion）。
//
// 两层结构：
//   一级：把当前块「转为」XXX + 「在上方添加 ▸」/「在下方添加 ▸」
//   二级（上/下方添加展开）：同款块类型列表，选中后在对应位置插入新空块
//
// 命令执行后菜单自动关闭。点外部 / Esc 也关闭。
import { computed, onMounted, onBeforeUnmount, ref } from "vue";
import type { Editor } from "@tiptap/vue-3";

/** 单个块类型定义：显示文案 + 如何「转换」当前块 + 如何「新建」一个空块 */
interface BlockType {
  key: string;
  title: string;
  /** 转换当前块：在已聚焦到目标块的 editor 上执行切换命令 */
  convert: (editor: Editor) => void;
  /** 新建空块的内容（用于 insertContentAt，列表类需带 listItem 骨架） */
  newNode: Record<string, unknown>;
}

/** 「转为」和「添加」共用的块类型列表 */
const BLOCK_TYPES: BlockType[] = [
  {
    key: "text",
    title: "正文",
    convert: (editor) => {
      editor.chain().focus().setParagraph().run();
    },
    newNode: { type: "paragraph" },
  },
  ...([1, 2, 3, 4, 5, 6] as const).map((level) => ({
    key: `h${level}`,
    title: `H${level} 标题`,
    convert: (editor: Editor) => {
      editor.chain().focus().toggleHeading({ level }).run();
    },
    newNode: { type: "heading", attrs: { level } },
  })),
  {
    key: "bullet",
    title: "无序列表",
    convert: (editor) => {
      editor.chain().focus().toggleBulletList().run();
    },
    newNode: {
      type: "bulletList",
      content: [{ type: "listItem", content: [{ type: "paragraph" }] }],
    },
  },
  {
    key: "ordered",
    title: "有序列表",
    convert: (editor) => {
      editor.chain().focus().toggleOrderedList().run();
    },
    newNode: {
      type: "orderedList",
      content: [{ type: "listItem", content: [{ type: "paragraph" }] }],
    },
  },
  {
    key: "todo",
    title: "待办列表",
    convert: (editor) => {
      editor.chain().focus().toggleTaskList().run();
    },
    newNode: {
      type: "taskList",
      content: [{ type: "taskItem", content: [{ type: "paragraph" }] }],
    },
  },
  {
    key: "quote",
    title: "引用",
    convert: (editor) => {
      editor.chain().focus().toggleBlockquote().run();
    },
    newNode: { type: "blockquote", content: [{ type: "paragraph" }] },
  },
  {
    key: "code",
    title: "代码块",
    convert: (editor) => {
      editor.chain().focus().toggleCodeBlock().run();
    },
    newNode: { type: "codeBlock" },
  },
  {
    key: "hr",
    title: "分隔线",
    convert: (editor) => {
      editor.chain().focus().setHorizontalRule().run();
    },
    newNode: { type: "horizontalRule" },
  },
];

const props = defineProps<{
  editor: Editor;
  /** 当前块在文档中的起始 pos */
  blockPos: number;
  /** 当前块节点的 size（用于算「下方添加」的插入 pos） */
  blockSize: number;
  /** 菜单定位锚点（手柄的视口坐标） */
  anchorRect: { left: number; top: number; bottom: number };
}>();

const emit = defineEmits<{ close: [] }>();

/** 当前展开的二级菜单方向：null / 'above' / 'below' */
const submenu = ref<null | "above" | "below">(null);

/** 菜单根的 fixed 定位（锚在手柄右侧，略下移让菜单不贴着手柄顶部） */
const menuStyle = computed(() => ({
  left: `${props.anchorRect.left + 22}px`,
  top: `${props.anchorRect.top + 8}px`,
}));

/** 二级菜单展开方向：右侧空间不足时改向左展开，避免溢出视口被裁切。
 *  一级菜单约 220px、二级约 180px，估算总需 400px 右侧空间。 */
const submenuSide = computed<"left" | "right">(() => {
  // 一级菜单左缘 + 估计一级宽度，得到一级右缘；再留 180px 给二级
  const menuRightEdge = props.anchorRect.left + 22 + 240;
  const viewportWidth = window.innerWidth;
  return menuRightEdge + 180 > viewportWidth ? "left" : "right";
});

/** 把当前块转换为指定类型 */
function onConvert(t: BlockType): void {
  // 先聚焦并把光标放进当前块（toggle 类命令依赖当前选区所在块）
  props.editor.chain().focus().setTextSelection(props.blockPos + 1).run();
  t.convert(props.editor);
  emit("close");
}

/** 在上方/下方插入指定类型的新空块，光标落进新块方便立即输入 */
function onInsert(t: BlockType, where: "above" | "below"): void {
  const insertPos =
    where === "above" ? props.blockPos : props.blockPos + props.blockSize;
  props.editor
    .chain()
    .focus()
    .insertContentAt(insertPos, t.newNode)
    .run();
  // 新块起始 pos = insertPos（上方）或对应下方位置；光标落进新块开头
  props.editor.chain().focus().setTextSelection(insertPos + 1).run();
  emit("close");
}

/** 展开/切换二级菜单（hover 和 click 都用这个）。
 *  不做 mouseleave 自动隐藏 —— submenu 一旦展开，只有「点别的项/外部/Esc」才关闭，
 *  避免鼠标移动路径导致的抖动和无法点中二级项的问题。 */
function showSubmenu(which: "above" | "below"): void {
  submenu.value = which;
}

/** 点外部关闭：冒泡阶段监听 document mousedown。
 *  菜单根元素 @mousedown.stop 阻止冒泡，所以只有外部点击会到达 document。 */
function onOutsideDown(): void {
  emit("close");
}
/** Esc 关闭 */
function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    e.preventDefault();
    emit("close");
  }
}

onMounted(() => {
  // 冒泡阶段（非 capture）：配合根元素 @mousedown.stop，菜单内点击不冒泡，
  // 只有外部点击到达 document → 关闭
  document.addEventListener("mousedown", onOutsideDown);
  window.addEventListener("keydown", onKeydown, true);
});
onBeforeUnmount(() => {
  document.removeEventListener("mousedown", onOutsideDown);
  window.removeEventListener("keydown", onKeydown, true);
});
</script>

<template>
  <Teleport to="body">
    <div class="block-handle-menu" :style="menuStyle" @mousedown.stop>
      <!-- 一级：转为 -->
      <div class="block-handle-menu__group-label">转为</div>
      <button
        v-for="t in BLOCK_TYPES"
        :key="t.key"
        type="button"
        class="block-handle-menu__item"
        @click="onConvert(t)"
      >
        {{ t.title }}
      </button>

      <div class="block-handle-menu__divider" />

      <!-- 一级：添加（hover 或 click 展开二级；不自动隐藏，点别处/外部/Esc 才关） -->
      <div
        class="block-handle-menu__item block-handle-menu__item--has-sub"
        @mouseenter="showSubmenu('above')"
        @click="showSubmenu('above')"
      >
        <span>在上方添加</span>
        <component
          :is="submenuSide === 'left' ? 'icon-left' : 'icon-right'"
          :size="12"
          class="block-handle-menu__arrow"
        />
        <!-- 二级：上方 -->
        <div
          v-if="submenu === 'above'"
          class="block-handle-menu__submenu block-handle-menu__submenu--above"
          :class="{ 'block-handle-menu__submenu--left': submenuSide === 'left' }"
        >
          <button
            v-for="t in BLOCK_TYPES"
            :key="t.key"
            type="button"
            class="block-handle-menu__item"
            @click="onInsert(t, 'above')"
          >
            {{ t.title }}
          </button>
        </div>
      </div>
      <div
        class="block-handle-menu__item block-handle-menu__item--has-sub"
        @mouseenter="showSubmenu('below')"
        @click="showSubmenu('below')"
      >
        <span>在下方添加</span>
        <component
          :is="submenuSide === 'left' ? 'icon-left' : 'icon-right'"
          :size="12"
          class="block-handle-menu__arrow"
        />
        <!-- 二级：下方 -->
        <div
          v-if="submenu === 'below'"
          class="block-handle-menu__submenu block-handle-menu__submenu--below"
          :class="{ 'block-handle-menu__submenu--left': submenuSide === 'left' }"
        >
          <button
            v-for="t in BLOCK_TYPES"
            :key="t.key"
            type="button"
            class="block-handle-menu__item"
            @click="onInsert(t, 'below')"
          >
            {{ t.title }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.block-handle-menu {
  position: fixed;
  z-index: 1100;
  min-width: 180px;
  max-width: 240px;
  background: var(--jt-surface);
  border-radius: 12px;
  box-shadow:
    0 8px 32px rgba(0, 0, 0, 0.08),
    0 2px 8px rgba(0, 0, 0, 0.04);
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.block-handle-menu__group-label {
  font-size: 11px;
  color: var(--jt-text-tertiary);
  padding: 6px 12px 2px;
  user-select: none;
}

.block-handle-menu__item {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  width: 100%;
  height: 34px;
  padding: 0 12px;
  border: none;
  background: transparent;
  color: var(--jt-text-primary);
  font-size: 13px;
  font-family: var(--font-body);
  border-radius: 6px;
  cursor: pointer;
  text-align: left;
  transition: background-color 0.12s, color 0.12s;
}
.block-handle-menu__item:hover {
  background: var(--jt-surface-hover);
}
.block-handle-menu__item--has-sub {
  justify-content: space-between;
}
.block-handle-menu__arrow {
  color: var(--jt-text-tertiary);
  flex-shrink: 0;
}

.block-handle-menu__divider {
  height: 1px;
  background: var(--jt-border);
  margin: 4px 8px;
}

/* 二级菜单：浮在一级右侧。
 *  absolute 锚到 .block-handle-menu（fixed，是定位上下文；item 的 relative 已去掉） */
.block-handle-menu__submenu {
  position: absolute;
  left: 100%;
  /* 无 margin-left 间隙：避免鼠标从 item 移向 submenu 时穿过间隙触发 mouseleave */
  min-width: 160px;
  max-height: calc(100vh - 32px);
  overflow-y: auto;
  background: var(--jt-surface);
  border-radius: 12px;
  box-shadow:
    0 8px 32px rgba(0, 0, 0, 0.08),
    0 2px 8px rgba(0, 0, 0, 0.04);
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
/* 「在上方添加」的二级：位置靠上，对齐该一级项附近 */
.block-handle-menu__submenu--above {
  top: 40px;
}
/* 「在下方添加」的二级：位置靠下，对齐该一级项附近（两个二级位置明显错开） */
.block-handle-menu__submenu--below {
  top: 90px;
}
/* 左展开变体：右侧视口空间不足时，改向一级左侧展开 */
.block-handle-menu__submenu--left {
  left: auto;
  right: 100%;
  margin-left: 0;
  margin-right: 4px;
}
</style>
