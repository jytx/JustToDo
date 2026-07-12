<script setup lang="ts">
// 任务复选框 —— 圆形复选框，勾选时有缩放动效
defineProps<{
  done: boolean;
}>();

defineEmits<{
  toggle: [];
}>();
</script>

<template>
  <button
    class="task-checkbox"
    :class="{ 'task-checkbox--done': done }"
    @click.stop="$emit('toggle')"
  >
    <icon-check v-if="done" :size="14" style="color: #fff" />
  </button>
</template>

<style scoped>
.task-checkbox {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 2px solid var(--jt-text-tertiary);
  background: transparent;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: all 0.2s ease;
  padding: 0;
}

.task-checkbox:hover {
  border-color: var(--jt-primary);
}

.task-checkbox--done {
  background-color: var(--jt-success);
  border-color: var(--jt-success);
  animation: pop 0.2s ease;
}

@keyframes pop {
  0% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.2);
  }
  100% {
    transform: scale(1);
  }
}
</style>
