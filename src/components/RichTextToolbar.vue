<script setup lang="ts">
// 富文本工具条 —— 抽离自 RichTextEditor
// 由父级（TaskDetailPanel）通过 Popover 浮出，接收 editor 实例
// 支持两种模式：
//   - inline（默认）：作为面板内联工具条使用
//   - compact：详情面板 footer popover 浮窗里的小尺寸版
import { ref, computed } from "vue";
import type { Editor } from "@tiptap/vue-3";
import MenuPopover from "./MenuPopover.vue";
import MenuPopoverItem from "./MenuPopoverItem.vue";
import { uploadAndInsertImage } from "@/utils/imageUpload";

const props = withDefaults(
  defineProps<{
    editor?: Editor | null;
    /** 紧凑模式（滴答清单风格，图标较小） */
    compact?: boolean;
  }>(),
  { compact: false, editor: null },
);

/** 链接弹窗状态 */
const linkDialogVisible = ref(false);
const linkInputValue = ref("");
const linkIsEditing = ref(false);

function openLinkDialog() {
  if (!props.editor) return;
  const existing = props.editor.getAttributes("link").href as string | undefined;
  linkIsEditing.value = !!existing;
  linkInputValue.value = existing ?? "";
  linkDialogVisible.value = true;
}

function closeLinkDialog() {
  linkDialogVisible.value = false;
  linkInputValue.value = "";
  linkIsEditing.value = false;
}

function applyLink() {
  if (!props.editor) return;
  const url = linkInputValue.value.trim();
  if (!url) {
    props.editor.chain().focus().extendMarkRange("link").unsetLink().run();
    closeLinkDialog();
    return;
  }
  const normalized = /^https?:\/\//.test(url) ? url : `https://${url}`;
  props.editor
    .chain()
    .focus()
    .extendMarkRange("link")
    .setLink({ href: normalized })
    .run();
  closeLinkDialog();
}

function removeLink() {
  if (!props.editor) return;
  props.editor.chain().focus().unsetLink().run();
  closeLinkDialog();
}

function onHeadingSelect(key: string) {
  if (!props.editor) return;
  const chain = props.editor.chain().focus();
  if (key === "p") chain.setParagraph().run();
  else if (key === "h1") chain.toggleHeading({ level: 1 }).run();
  else if (key === "h2") chain.toggleHeading({ level: 2 }).run();
  else if (key === "h3") chain.toggleHeading({ level: 3 }).run();
  headingMenuOpen.value = false;
}

/** 标题级别菜单开关（仅非 compact 模式使用） */
const headingMenuOpen = ref(false);

/**
 * 缩进：支持普通列表项（listItem）和待办列表项（taskItem）。
 * 优先尝试 listItem，不行再试 taskItem（待办列表 nested=true 才能缩进）。
 */
function sinkIndent() {
  const ed = props.editor;
  if (!ed) return;
  if (ed.can().sinkListItem("listItem")) {
    ed.chain().focus().sinkListItem("listItem").run();
  } else if (ed.can().sinkListItem("taskItem")) {
    ed.chain().focus().sinkListItem("taskItem").run();
  }
}

/** 反向缩进：同上，两种 listItem 类型都支持 */
function liftIndent() {
  const ed = props.editor;
  if (!ed) return;
  if (ed.can().liftListItem("listItem")) {
    ed.chain().focus().liftListItem("listItem").run();
  } else if (ed.can().liftListItem("taskItem")) {
    ed.chain().focus().liftListItem("taskItem").run();
  }
}

/** 缩进按钮是否可用：任一 listItem 类型可缩进即可 */
const canSink = computed(() => {
  const ed = props.editor;
  return !!ed && (ed.can().sinkListItem("listItem") || ed.can().sinkListItem("taskItem"));
});
/** 反向缩进按钮是否可用 */
const canLift = computed(() => {
  const ed = props.editor;
  return !!ed && (ed.can().liftListItem("listItem") || ed.can().liftListItem("taskItem"));
});

/** 隐藏的文件选择 input（插入图片用） */
const fileInputRef = ref<HTMLInputElement | null>(null);

/**
 * 点击"插入图片"按钮 → 先 focus editor（保证有有效选区）再触发文件选择。
 * 不先 focus 的话，上传完成后 editor.chain().focus() 可能因选区丢失而插入失败。
 */
function triggerImagePicker() {
  if (!props.editor) return;
  props.editor.commands.focus();
  fileInputRef.value?.click();
}

/** 选好图片文件后上传并插入到 editor */
async function onImagePicked(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  // 重置 value 让同一文件能再次选择
  input.value = "";
  const ed = props.editor;
  if (!file || !ed) return;
  // 上传是异步的，期间用户可能切任务导致 editor 失效；用 isDestroyed 兜底
  if (ed.isDestroyed) return;
  // 用 editor 视图宽度作为最大宽度参考
  const viewDom = ed.view.dom as HTMLElement;
  await uploadAndInsertImage(file, ed, viewDom.clientWidth || 400);
}
</script>

<template>
  <div
    v-if="editor"
    class="rich-text-toolbar"
    :class="{ 'rich-text-toolbar--compact': compact }"
  >
    <!-- 文本格式组 -->
    <a-button
      :size="compact ? 'mini' : 'mini'"
      shape="circle"
      :type="editor.isActive('bold') ? 'primary' : 'text'"
      @click="editor.chain().focus().toggleBold().run()"
      title="加粗 (Cmd+B)"
    >
      <icon-bold :size="compact ? 14 : 16" />
    </a-button>
    <a-button
      size="mini"
      shape="circle"
      :type="editor.isActive('italic') ? 'primary' : 'text'"
      @click="editor.chain().focus().toggleItalic().run()"
      title="斜体 (Cmd+I)"
    >
      <icon-italic :size="compact ? 14 : 16" />
    </a-button>
    <a-button
      size="mini"
      shape="circle"
      :type="editor.isActive('underline') ? 'primary' : 'text'"
      @click="editor.chain().focus().toggleUnderline().run()"
      title="下划线 (Cmd+U)"
    >
      <icon-underline :size="compact ? 14 : 16" />
    </a-button>
    <a-button
      size="mini"
      shape="circle"
      :type="editor.isActive('strike') ? 'primary' : 'text'"
      @click="editor.chain().focus().toggleStrike().run()"
      title="删除线"
    >
      <icon-strikethrough :size="compact ? 14 : 16" />
    </a-button>
    <a-button
      size="mini"
      shape="circle"
      :type="editor.isActive('code') ? 'primary' : 'text'"
      @click="editor.chain().focus().toggleCode().run()"
      title="行内代码"
    >
      <icon-code :size="compact ? 14 : 16" />
    </a-button>
    <a-button
      size="mini"
      shape="circle"
      type="text"
      @click="editor.chain().focus().clearNodes().unsetAllMarks().run()"
      title="清除格式"
    >
      <icon-eraser :size="compact ? 14 : 16" />
    </a-button>
    <span v-if="!compact" class="rich-text-toolbar__divider" />
    <a-divider v-else direction="vertical" :margin="2" />

    <!-- 段落块组：标题下拉 -->
    <MenuPopover v-if="!compact" v-model:visible="headingMenuOpen" placement="bottom-left">
      <template #trigger>
        <a-button
          size="mini"
          shape="circle"
          :type="editor.isActive('heading') ? 'primary' : 'text'"
          title="标题级别"
          @click="headingMenuOpen = !headingMenuOpen"
        >
          <span class="rich-text-toolbar__heading-label">
            <template v-if="editor.isActive('heading', { level: 1 })">H1</template>
            <template v-else-if="editor.isActive('heading', { level: 2 })">H2</template>
            <template v-else-if="editor.isActive('heading', { level: 3 })">H3</template>
            <template v-else>¶</template>
          </span>
        </a-button>
      </template>
      <MenuPopoverItem
        key="p"
        :active="editor.isActive('paragraph')"
        @click="onHeadingSelect('p')"
      >
        ¶ 正文
      </MenuPopoverItem>
      <MenuPopoverItem
        key="h1"
        :active="editor.isActive('heading', { level: 1 })"
        @click="onHeadingSelect('h1')"
      >
        H1 标题
      </MenuPopoverItem>
      <MenuPopoverItem
        key="h2"
        :active="editor.isActive('heading', { level: 2 })"
        @click="onHeadingSelect('h2')"
      >
        H2 标题
      </MenuPopoverItem>
      <MenuPopoverItem
        key="h3"
        :active="editor.isActive('heading', { level: 3 })"
        @click="onHeadingSelect('h3')"
      >
        H3 标题
      </MenuPopoverItem>
    </MenuPopover>

    <!-- 紧凑模式：直接显示 H1/H2 按钮 -->
    <template v-else>
      <a-button
        size="mini"
        shape="circle"
        :type="editor.isActive('heading', { level: 1 }) ? 'primary' : 'text'"
        @click="onHeadingSelect('h1')"
        title="H1 标题"
      >
        <span class="rich-text-toolbar__heading-label">H1</span>
      </a-button>
      <a-button
        size="mini"
        shape="circle"
        :type="editor.isActive('heading', { level: 2 }) ? 'primary' : 'text'"
        @click="onHeadingSelect('h2')"
        title="H2 标题"
      >
        <span class="rich-text-toolbar__heading-label">H2</span>
      </a-button>
    </template>

    <a-button
      size="mini"
      shape="circle"
      :type="editor.isActive('blockquote') ? 'primary' : 'text'"
      @click="editor.chain().focus().toggleBlockquote().run()"
      title="引用"
    >
      <icon-quote :size="compact ? 14 : 16" />
    </a-button>
    <a-button
      size="mini"
      shape="circle"
      type="text"
      @click="editor.chain().focus().setHorizontalRule().run()"
      title="分隔线"
    >
      <icon-minus :size="compact ? 14 : 16" />
    </a-button>
    <a-button
      size="mini"
      shape="circle"
      type="text"
      @click="editor.chain().focus().setHardBreak().run()"
      title="硬换行 (Shift+Enter)"
    >
      <icon-refresh :size="compact ? 14 : 16" />
    </a-button>
    <span v-if="!compact" class="rich-text-toolbar__divider" />
    <a-divider v-else direction="vertical" :margin="2" />

    <!-- 列表组 -->
    <a-button
      size="mini"
      shape="circle"
      :type="editor.isActive('bulletList') ? 'primary' : 'text'"
      @click="editor.chain().focus().toggleBulletList().run()"
      title="无序列表"
    >
      <icon-list :size="compact ? 14 : 16" />
    </a-button>
    <a-button
      size="mini"
      shape="circle"
      :type="editor.isActive('orderedList') ? 'primary' : 'text'"
      @click="editor.chain().focus().toggleOrderedList().run()"
      title="有序列表"
    >
      <icon-ordered-list :size="compact ? 14 : 16" />
    </a-button>
    <a-button
      size="mini"
      shape="circle"
      :type="editor.isActive('taskList') ? 'primary' : 'text'"
      @click="editor.chain().focus().toggleTaskList().run()"
      title="待办列表"
    >
      <icon-check-square :size="compact ? 14 : 16" />
    </a-button>

    <!-- 缩进 / 反向缩进（仅对 listItem 节点生效；非列表场景 disabled） -->
    <a-button
      size="mini"
      shape="circle"
      type="text"
      :disabled="!canSink"
      title="缩进 (Tab)"
      @click="sinkIndent"
    >
      <svg
        :width="compact ? 14 : 16"
        :height="compact ? 14 : 16"
        viewBox="0 0 16 16"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <path d="M 5 3 L 10 8 L 5 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none" />
        <line x1="12" y1="3" x2="12" y2="13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
      </svg>
    </a-button>
    <a-button
      size="mini"
      shape="circle"
      type="text"
      :disabled="!canLift"
      title="反向缩进 (Shift+Tab)"
      @click="liftIndent"
    >
      <svg
        :width="compact ? 14 : 16"
        :height="compact ? 14 : 16"
        viewBox="0 0 16 16"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <path d="M 11 3 L 6 8 L 11 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none" />
        <line x1="4" y1="3" x2="4" y2="13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
      </svg>
    </a-button>

    <span v-if="!compact" class="rich-text-toolbar__divider" />
    <a-divider v-else direction="vertical" :margin="2" />

    <!-- 代码块 + 链接 + 图片 -->
    <a-button
      size="mini"
      shape="circle"
      :type="editor.isActive('codeBlock') ? 'primary' : 'text'"
      @click="editor.chain().focus().toggleCodeBlock().run()"
      title="代码块"
    >
      <icon-code-square :size="compact ? 14 : 16" />
    </a-button>
    <a-button
      size="mini"
      shape="circle"
      :type="editor.isActive('link') ? 'primary' : 'text'"
      @click="openLinkDialog"
      title="插入 / 编辑链接"
    >
      <icon-link :size="compact ? 14 : 16" />
    </a-button>
    <a-button
      type="text"
      size="mini"
      shape="circle"
      @click="triggerImagePicker"
      title="插入图片"
    >
      <icon-image :size="compact ? 14 : 16" />
    </a-button>
  </div>

  <!-- 链接弹窗 -->
  <a-modal
    :visible="linkDialogVisible"
    :title="linkIsEditing ? '编辑链接' : '插入链接'"
    :ok-text="linkIsEditing ? '更新' : '插入'"
    :cancel-text="'取消'"
    :width="380"
    :modal-style="{ maxWidth: 'calc(100vw - 32px)' }"
    @cancel="closeLinkDialog"
    @ok="applyLink"
  >
    <a-input
      v-model="linkInputValue"
      placeholder="https://example.com"
      allow-clear
      @keydown.enter.prevent="applyLink"
      @keydown.esc="closeLinkDialog"
    />
    <template #footer>
      <a-button v-if="linkIsEditing" status="danger" type="outline" size="small" @click="removeLink">
        移除链接
      </a-button>
      <a-button size="small" @click="closeLinkDialog">取消</a-button>
      <a-button type="primary" size="small" @click="applyLink">
        {{ linkIsEditing ? "更新" : "插入" }}
      </a-button>
    </template>
  </a-modal>

  <!-- 隐藏的文件选择 input（插入图片） -->
  <input
    ref="fileInputRef"
    type="file"
    accept="image/*"
    class="rich-text-toolbar__file-input"
    @change="onImagePicked"
  />
</template>

<style scoped>
.rich-text-toolbar__file-input {
  position: absolute;
  width: 0;
  height: 0;
  opacity: 0;
  pointer-events: none;
}

.rich-text-toolbar {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-wrap: wrap;
}

.rich-text-toolbar--compact {
  flex-wrap: nowrap;
  gap: 2px;
}

.rich-text-toolbar__divider {
  width: 1px;
  height: 16px;
  background-color: var(--jt-border);
  margin: 0 4px;
}

.rich-text-toolbar__heading-label {
  font-size: 12px;
  font-weight: 600;
  font-family: var(--font-mono, monospace);
  letter-spacing: 0.5px;
}
</style>
