<script setup lang="ts">
// 标题自定义 NodeView —— 左侧折叠三角按钮（点击折叠/展开其下属内容块）
//
// 折叠的"隐藏下属块"逻辑由 HeadingFold 扩展的 ProseMirror Plugin 用
// Decoration 完成（不修改文档），本组件只负责标题本身的渲染 + 折叠按钮。
import { computed } from "vue";
import { NodeViewContent, NodeViewWrapper, nodeViewProps } from "@tiptap/vue-3";

const props = defineProps(nodeViewProps);

/** 当前标题级别 H1-H6 */
const level = computed(() => props.node.attrs.level as number);

/** 折叠态 */
const folded = computed(() => !!props.node.attrs.folded);

/** 切换折叠（持久化到 node.attrs.folded） */
function toggleFold(): void {
  props.updateAttributes({ folded: !folded.value });
}
</script>

<template>
  <NodeViewWrapper
    as="div"
    class="heading-block"
    :class="[`heading-block--h${level}`, { 'heading-block--folded': folded }]"
  >
    <!-- 折叠三角按钮（hover 标题时显示） -->
    <button
      type="button"
      class="heading-block__fold-btn"
      :title="folded ? '展开' : '折叠'"
      @click="toggleFold"
    >
      <icon-right v-if="folded" :size="10" />
      <icon-down v-else :size="10" />
    </button>
    <!-- 标题内容：NodeViewContent 渲染为对应级别的 hx，保留原生语义 -->
    <NodeViewContent :as="`h${level}`" class="heading-block__content" />
  </NodeViewWrapper>
</template>

<style scoped>
.heading-block {
  position: relative;
}

/* 折叠按钮：绝对定位在标题左侧（margin 负值，不占文档流宽度） */
.heading-block__fold-btn {
  position: absolute;
  left: -20px;
  top: 50%;
  transform: translateY(-50%);
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--jt-text-tertiary);
  border-radius: 4px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 0.12s, background-color 0.12s, color 0.12s;
}
.heading-block:hover .heading-block__fold-btn,
.heading-block--folded .heading-block__fold-btn {
  opacity: 1;
}
.heading-block__fold-btn:hover {
  background: var(--jt-surface-hover);
  color: var(--jt-text-primary);
}
</style>
