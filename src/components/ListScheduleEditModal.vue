<script setup lang="ts">
// 清单生成计划 —— 新建/编辑弹窗
// 字段：名称、频率、路径模板（带占位符说明）、颜色
// 回车保存；编辑模式回填现有值。
import { ref, watch, computed } from "vue";
import { Message } from "@arco-design/web-vue";
import { IconInfoCircle } from "@arco-design/web-vue/es/icon";
import type {
  ListSchedule,
  ListScheduleFreq,
  ListScheduleLeafType,
} from "@/types/listSchedule";
import {
  LIST_SCHEDULE_FREQS,
  LIST_SCHEDULE_LEAF_TYPES,
  PATH_PLACEHOLDERS,
} from "@/types/listSchedule";
import { LIST_COLORS, randomListColor } from "@/utils/colors";
import { useListScheduleStore } from "@/stores/listSchedule";
import SelectPopover from "./SelectPopover.vue";

const props = defineProps<{
  /** 是否显示（v-model:visible） */
  visible: boolean;
  /** 编辑目标；null = 新建模式 */
  schedule: ListSchedule | null;
}>();
const emit = defineEmits<{
  "update:visible": [value: boolean];
}>();

const store = useListScheduleStore();

// ─── 表单状态 ───
const name = ref("");
const freq = ref<ListScheduleFreq>("daily");
const leafType = ref<ListScheduleLeafType>("list");
const pathTemplate = ref("");
const color = ref<string>(randomListColor());
const saving = ref(false);

/** 频率下拉选项（SelectPopover 需要 string value + label） */
const freqOptions = computed(() =>
  LIST_SCHEDULE_FREQS.map((f) => ({ value: f.value, label: f.label })),
);

/** 生成类型下拉选项（目录/清单） */
const leafOptions = computed(() =>
  LIST_SCHEDULE_LEAF_TYPES.map((t) => ({ value: t.value, label: t.label })),
);

/** 弹窗打开时回填表单 */
watch(
  () => props.visible,
  (open) => {
    if (!open) return;
    if (props.schedule) {
      // 编辑模式：回填
      name.value = props.schedule.name;
      freq.value = props.schedule.freq;
      leafType.value = props.schedule.leafType;
      pathTemplate.value = props.schedule.pathTemplate;
      color.value = props.schedule.color;
    } else {
      // 新建模式：默认值
      name.value = "";
      freq.value = "daily";
      leafType.value = "list";
      pathTemplate.value = "";
      color.value = randomListColor();
    }
  },
);

function close() {
  emit("update:visible", false);
}

/** 校验 + 保存 */
async function onSave() {
  const trimmedName = name.value.trim();
  const trimmedPath = pathTemplate.value.trim();
  if (!trimmedName) {
    Message.warning("请填写计划名称");
    return;
  }
  if (!trimmedPath) {
    Message.warning("请填写路径模板");
    return;
  }

  saving.value = true;
  try {
    if (props.schedule) {
      await store.updateSchedule(props.schedule.id, {
        name: trimmedName,
        freq: freq.value,
        leafType: leafType.value,
        pathTemplate: trimmedPath,
        color: color.value,
      });
      Message.success("已保存");
    } else {
      await store.createSchedule({
        name: trimmedName,
        freq: freq.value,
        leafType: leafType.value,
        pathTemplate: trimmedPath,
        color: color.value,
      });
      Message.success("已创建计划");
    }
    close();
  } catch (e) {
    Message.error("保存失败：" + String(e));
  } finally {
    saving.value = false;
  }
}

/** 回车保存 */
function onKeydownEnter(e: KeyboardEvent) {
  // Shift+Enter 换行不触发保存（未来若改成 textarea 用）
  if (!e.shiftKey) {
    e.preventDefault();
    onSave();
  }
}
</script>

<template>
  <a-modal
    :visible="visible"
    :width="440"
    :footer="false"
    :mask-closable="true"
    :mask-style="{ backgroundColor: 'rgba(0,0,0,0.35)' }"
    modal-class="ls-edit-modal"
    :modal-style="{ maxWidth: 'calc(100vw - 32px)' }"
    @cancel="close"
  >
    <div class="ls-edit">
      <!-- 名称 -->
      <input
        v-model="name"
        class="ls-edit__input"
        placeholder="计划名称，如：每日工作清单"
        @keydown.enter="onKeydownEnter"
      />

      <div class="ls-edit__divider" />

      <!-- 属性行 -->
      <div class="ls-edit__attrs">
        <!-- 频率 -->
        <div class="ls-edit__attr">
          <span class="ls-edit__attr-label">频率</span>
          <SelectPopover
            v-model="freq"
            :options="freqOptions"
            :width="120"
          />
        </div>

        <!-- 生成类型 -->
        <div class="ls-edit__attr">
          <span class="ls-edit__attr-label">生成类型</span>
          <SelectPopover
            v-model="leafType"
            :options="leafOptions"
            :width="120"
          />
        </div>

        <!-- 路径模板（input 弹性占满剩余宽度）-->
        <div class="ls-edit__attr ls-edit__attr--path">
          <span class="ls-edit__attr-label">
            路径模板
            <a-tooltip position="right" mini>
              <IconInfoCircle :size="13" class="ls-edit__info" />
              <template #content>
                <div class="ls-edit__placeholder-table">
                  <div
                    v-for="p in PATH_PLACEHOLDERS"
                    :key="p.token"
                    class="ls-edit__placeholder-row"
                  >
                    <code>{{ p.token }}</code>
                    <span class="ls-edit__placeholder-desc">{{ p.desc }}</span>
                    <span class="ls-edit__placeholder-eg">{{ p.example }}</span>
                  </div>
                </div>
              </template>
            </a-tooltip>
          </span>
          <input
            v-model="pathTemplate"
            class="ls-edit__input ls-edit__input--path"
            placeholder="工作/日志/{{YYYY}}/{{MM}}/{{YYYY-MM-DD}}"
            @keydown.enter="onKeydownEnter"
          />
        </div>

        <!-- 颜色 -->
        <div class="ls-edit__attr">
          <span class="ls-edit__attr-label">颜色</span>
          <div class="ls-edit__colors">
            <button
              v-for="c in LIST_COLORS"
              :key="c"
              class="ls-edit__color-swatch"
              :class="{ 'ls-edit__color-swatch--active': color === c }"
              :style="{ backgroundColor: c }"
              :title="c"
              @click="color = c"
            />
          </div>
        </div>
      </div>

      <div class="ls-edit__divider" />

      <!-- 底部提示 -->
      <div class="ls-edit__footer">
        <span class="ls-edit__hint">回车保存</span>
        <a-button
          type="primary"
          size="small"
          :loading="saving"
          @click="onSave"
        >
          保存
        </a-button>
      </div>
    </div>
  </a-modal>
</template>

<style scoped>
.ls-edit {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px 0;
}

.ls-edit__input {
  width: 100%;
  border: none;
  outline: none;
  font-size: 15px;
  font-weight: 600;
  color: var(--jt-text-primary);
  background: transparent;
  padding: 4px 0;
  font-family: inherit;
}
.ls-edit__input::placeholder {
  color: var(--jt-text-tertiary);
  font-weight: 400;
}
.ls-edit__input--path {
  font-size: 13px;
  font-weight: 400;
  font-family: var(--font-mono, ui-monospace, monospace);
}

.ls-edit__divider {
  height: 1px;
  background: var(--jt-border);
  margin: 6px 0;
}

.ls-edit__attrs {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 4px 0;
}
.ls-edit__attr {
  display: flex;
  align-items: center;
  gap: 12px;
}
/* 路径模板行：label 固定宽不收缩，input 弹性占满剩余宽度 */
.ls-edit__attr--path {
  min-width: 0;
}
.ls-edit__attr--path .ls-edit__input--path {
  flex: 1;
  min-width: 0;
}
.ls-edit__attr-label {
  font-size: 13px;
  color: var(--jt-text-secondary);
  width: 64px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.ls-edit__info {
  color: var(--jt-text-tertiary);
  cursor: help;
}

.ls-edit__colors {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.ls-edit__color-swatch {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 2px solid transparent;
  padding: 0;
  cursor: pointer;
  transition: transform 0.12s;
}
.ls-edit__color-swatch:hover {
  transform: scale(1.15);
}
.ls-edit__color-swatch--active {
  border-color: var(--jt-text-primary);
  transform: scale(1.1);
}

.ls-edit__footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  padding-top: 2px;
}
.ls-edit__hint {
  font-size: 12px;
  color: var(--jt-text-tertiary);
}
</style>

<style>
/* 占位符说明表（tooltip teleport 到 body，需全局样式） */
.ls-edit__placeholder-table { display: flex; flex-direction: column; gap: 4px; font-size: 12px; max-width: 260px; }
.ls-edit__placeholder-row { display: flex; align-items: center; gap: 8px; }
.ls-edit__placeholder-row code { font-family: var(--font-mono, ui-monospace, monospace); background: rgba(255,255,255,0.15); padding: 1px 5px; border-radius: 3px; font-size: 11px; }
.ls-edit__placeholder-desc { color: rgba(255,255,255,0.85); }
.ls-edit__placeholder-eg { color: rgba(255,255,255,0.55); margin-left: auto; }
</style>
