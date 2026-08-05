<script setup lang="ts">
// 代码块自定义 NodeView —— 给 CodeBlockLowlight 加：
//   - 左上角语言标签（点击下拉切换语言）
//   - 右上角复制按钮（复制代码内容到系统剪贴板）
//   - 右上角折叠按钮（持久化折叠/展开，存进 node.attrs.folded）
//
// 关键：必须保留 <pre><code class="language-xxx"> 结构，且 code 用 <NodeViewContent />
// 这样 CodeBlockLowlight 的 LowlightPlugin（Decoration.inline 注入 .hljs-* span）
// 才能继续作用在 code 内容上，语法高亮不丢失。
import { computed, ref } from "vue";
import { NodeViewContent, NodeViewWrapper, nodeViewProps } from "@tiptap/vue-3";
import { Message } from "@arco-design/web-vue";
import { copyText } from "@/api/db";
import { LANGUAGES } from "@/extensions/lowlight";
import MenuPopover from "./MenuPopover.vue";
import MenuPopoverItem from "./MenuPopoverItem.vue";

const props = defineProps(nodeViewProps);

/** 语言下拉开关 */
const langMenuOpen = ref(false);

/** 当前语言（attrs.language，可能为 null/空 = 自动检测） */
const currentLang = computed(() => (props.node.attrs.language as string) || "");

/** 语言显示文案：无语言时显示「自动」 */
const langLabel = computed(() => currentLang.value || "自动");

/** 复制按钮状态：复制后短暂显示「已复制」 */
const copied = ref(false);
let copyTimer: ReturnType<typeof setTimeout> | null = null;

/** 复制代码块纯文本内容到系统剪贴板 */
async function onCopy(): Promise<void> {
  const text = props.node.textContent;
  try {
    await copyText(text);
    copied.value = true;
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      copied.value = false;
    }, 1500);
    Message.success("已复制到剪贴板");
  } catch {
    Message.error("复制失败");
  }
}

/** 切换语言：传空字符串表示清除语言（回到自动检测） */
function onSelectLang(lang: string): void {
  props.updateAttributes({ language: lang || null });
  langMenuOpen.value = false;
}

/** 切换折叠态（持久化到 node.attrs.folded） */
function toggleFold(): void {
  props.updateAttributes({ folded: !props.node.attrs.folded });
}
</script>

<template>
  <NodeViewWrapper
    as="div"
    class="code-block"
    :class="{ 'code-block--folded': node.attrs.folded }"
  >
    <!-- 工具条：左语言标签 + 右复制/折叠（hover 代码块时显示） -->
    <div class="code-block__bar">
      <MenuPopover v-model:visible="langMenuOpen" placement="bottom-left">
        <template #trigger>
          <button
            type="button"
            class="code-block__lang"
            title="选择语言"
            @click="langMenuOpen = !langMenuOpen"
          >
            {{ langLabel }}
          </button>
        </template>
        <!-- 语言列表容器：限制最大高度 + 内部滚动，避免 35 种语言撑爆视口 -->
        <div class="code-block__lang-list">
          <MenuPopoverItem :active="!currentLang" @click="onSelectLang('')">
            自动检测
          </MenuPopoverItem>
          <MenuPopoverItem
            v-for="lang in LANGUAGES"
            :key="lang"
            :active="currentLang === lang"
            @click="onSelectLang(lang)"
          >
            {{ lang }}
          </MenuPopoverItem>
        </div>
      </MenuPopover>

      <span class="code-block__spacer" />

      <!-- 折叠按钮 -->
      <button
        type="button"
        class="code-block__btn"
        :title="node.attrs.folded ? '展开' : '折叠'"
        @click="toggleFold"
      >
        <icon-minus v-if="!node.attrs.folded" :size="14" />
        <icon-expand v-else :size="14" />
      </button>
      <!-- 复制按钮 -->
      <button
        type="button"
        class="code-block__btn"
        :title="copied ? '已复制' : '复制代码'"
        @click="onCopy"
      >
        <icon-check v-if="copied" :size="14" style="color: var(--jt-success)" />
        <icon-copy v-else :size="14" />
      </button>
    </div>

    <!-- 代码区：pre>code 结构保留。NodeViewContent as="code" 承载可编辑内容，
         lowlight 的 hljs-* 装饰作用其上；language-xxx class 挂在 code 上。 -->
    <pre class="code-block__pre"><NodeViewContent
      as="code"
      :class="currentLang ? `language-${currentLang}` : null"
    /></pre>

    <!-- 折叠态提示（点击可展开） -->
    <button
      v-if="node.attrs.folded"
      type="button"
      class="code-block__folded-hint"
      title="点击展开代码"
      @click="toggleFold"
    >
      ··· 已折叠代码（{{ node.textContent.length }} 字符）· 点击展开
    </button>
  </NodeViewWrapper>
</template>

<style scoped>
.code-block {
  position: relative;
  margin: 8px 0;
}

/* 工具条：贴在 pre 上方，仅在 hover 代码块时显示 */
.code-block__bar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 4px;
  height: 22px;
  opacity: 0;
  transition: opacity 0.12s;
}
.code-block:hover .code-block__bar {
  opacity: 1;
}
.code-block__spacer {
  flex: 1;
}

/* 语言标签按钮 */
.code-block__lang {
  border: none;
  background: transparent;
  color: var(--jt-text-tertiary);
  font-family: var(--font-mono);
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 4px;
  cursor: pointer;
  text-transform: lowercase;
  transition: background-color 0.12s, color 0.12s;
}
.code-block__lang:hover {
  background: var(--jt-surface-hover);
  color: var(--jt-text-secondary);
}

/* 右侧操作按钮（折叠/复制） */
.code-block__btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: none;
  background: transparent;
  color: var(--jt-text-tertiary);
  border-radius: 4px;
  cursor: pointer;
  flex-shrink: 0;
  transition: background-color 0.12s, color 0.12s;
}
.code-block__btn:hover {
  background: var(--jt-surface-hover);
  color: var(--jt-text-primary);
}

/* 语言下拉列表：限制最大高度 + 内部滚动，避免 35 种语言撑高文档 */
.code-block__lang-list {
  max-height: 320px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
/* 语言项比通用菜单项更宽松（不拥挤） */
.code-block__lang-list :deep(.menu-popover-item) {
  height: 36px;
}

/* 代码区（保持原 .rich-text__content pre 的视觉） */
.code-block__pre {
  background: var(--jt-surface-sunken);
  border-radius: 6px;
  padding: 10px 12px;
  font-family: var(--font-mono);
  font-size: 12px;
  overflow-x: auto;
  margin: 0;
  transition: max-height 0.2s ease, opacity 0.2s ease, padding 0.2s ease;
}
.code-block__pre :deep(code) {
  background: none;
  padding: 0;
  font-size: 12px;
  font-family: var(--font-mono);
}

/* 折叠态：隐藏代码区，显示提示 */
.code-block--folded .code-block__pre {
  max-height: 0;
  opacity: 0;
  padding-top: 0;
  padding-bottom: 0;
  overflow: hidden;
}
.code-block--folded .code-block__bar {
  /* 折叠时工具条始终显示，方便展开 */
  opacity: 1;
}

/* 折叠提示条 */
.code-block__folded-hint {
  width: 100%;
  border: none;
  background: var(--jt-surface-sunken);
  color: var(--jt-text-tertiary);
  font-family: var(--font-mono);
  font-size: 11px;
  padding: 6px 12px;
  border-radius: 6px;
  cursor: pointer;
  text-align: center;
  transition: background-color 0.12s, color 0.12s;
}
.code-block__folded-hint:hover {
  background: var(--jt-surface-hover);
  color: var(--jt-text-secondary);
}
</style>
