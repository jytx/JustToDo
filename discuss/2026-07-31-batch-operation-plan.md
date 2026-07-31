# 批量操作实现计划（2026-07-31）

> 配套设计文档：`discuss/2026-07-31-batch-operation-design.md`
> 调研结论已确认（复用清单、数据源、键盘占用等），本计划是可执行的分步实现。
>
> 范围：**只做任务项的批量操作**（移动清单/加标签/改优先级/改日期/完成/删除），
> 清单树/标签树本身不做批量。

---

## 实现总览

5 个步骤，按依赖顺序推进。每步独立可验证。

| 步骤 | 内容 | 依赖 |
|------|------|------|
| 1 | Store 多选状态 + 批量 action | 无 |
| 2 | TaskListItem 修饰键点击 + 选中态 UI | 步骤1 |
| 3 | 视图层转发多选事件 + 右键菜单加「多选」入口 | 步骤1、2 |
| 4 | 批量右键菜单组件（6 项操作） | 步骤1、3 |
| 5 | 全局键盘：Esc 退多选、Cmd+A 全选 | 步骤1、3 |

---

## 步骤 1：Store 多选状态 + 批量 action

**文件**：`src/stores/task.ts`

### 新增 state（在现有 selectedTaskId 附近）

```ts
/** 批量多选：选中的任务 id 集合 */
const batchSelectedIds = ref<Set<string>>(new Set());
/** 是否处于多选模式（决定任务行是否显示勾选框） */
const batchMode = ref(false);
/** Shift 范围选的锚点任务 id */
const batchAnchorId = ref<string | null>(null);
```

### 新增 action

```ts
/** 进入多选模式（从右键菜单「多选」入口触发） */
function enterBatchMode(): void {
  batchMode.value = true;
  batchSelectedIds.value = new Set();
  batchAnchorId.value = null;
}

/** 退出多选模式，清空所有选中 */
function exitBatchMode(): void {
  batchMode.value = false;
  batchSelectedIds.value = new Set();
  batchAnchorId.value = null;
}

/** Cmd/Ctrl+点击：单任务增减选（切一个） */
function toggleBatchSelect(id: string): void {
  batchMode.value = true;
  const next = new Set(batchSelectedIds.value);
  if (next.has(id)) {
    next.delete(id);
    // 全部取消后退出多选
    if (next.size === 0) { exitBatchMode(); return; }
  } else {
    next.add(id);
  }
  batchSelectedIds.value = next;
  batchAnchorId.value = id;
}

/** Shift+点击：范围选（从锚点到当前任务，基于 openTasks 顺序） */
function rangeBatchSelect(id: string): void {
  batchMode.value = true;
  const tasks = openTasks.value;
  if (!batchAnchorId.value || !tasks.length) {
    toggleBatchSelect(id);
    return;
  }
  const startIdx = tasks.findIndex(t => t.id === batchAnchorId.value);
  const endIdx = tasks.findIndex(t => t.id === id);
  if (startIdx === -1 || endIdx === -1) {
    toggleBatchSelect(id);
    return;
  }
  const [lo, hi] = startIdx <= endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
  const next = new Set(batchSelectedIds.value);
  for (let i = lo; i <= hi; i++) next.add(tasks[i].id);
  batchSelectedIds.value = next;
  batchAnchorId.value = id;
}

/** Cmd+A 全选当前视图未完成任务 */
function selectAllBatch(): void {
  batchMode.value = true;
  batchSelectedIds.value = new Set(openTasks.value.map(t => t.id));
}

/** 选中的任务对象列表（按 currentTasks 顺序，只含当前视图可见的） */
const batchSelectedTasks = computed(() =>
  currentTasks.value.filter(t => batchSelectedIds.value.has(t.id))
);

/** 判断任务是否被批量选中 */
function isBatchSelected(id: string): boolean {
  return batchSelectedIds.value.has(id);
}
```

### 批量操作 action（循环调现有单条 API，合并刷新）

> 关键：现有 `updateTask`/`toggleTask` 每次都触发 `refreshCounts()` + `notifyTaskChanged()`，
> 批量循环会触发 N 次。这里用「先收集所有更新、最后统一刷一次」的策略优化。
> 为简单起见，第一版直接循环调 `db.*`（绕过 store action 的逐次刷新），
> 循环结束后调一次 `reload()` 重新加载 + 一次 `refreshCounts()` + 一次 `notifyTaskChanged()`。

```ts
/** 批量更新字段（清单/优先级/日期共用）。
 *  直接调 db.updateTask（绕过逐次 store 同步），结束后统一 reload。 */
async function batchUpdateFields(
  ids: string[],
  fields: Parameters<typeof db.updateTask>[1],
): Promise<void> {
  for (const id of ids) {
    await db.updateTask(id, fields);
  }
  await reload(true);            // 重新加载当前视图（keepSelection 保详情面板）
  await refreshCounts();
  notifyTaskChanged();
  exitBatchMode();
}

/** 批量标记完成/取消完成 */
async function batchToggleDone(ids: string[], done: boolean): Promise<void> {
  for (const id of ids) {
    await db.toggleTask(id, done);
  }
  await reload(true);
  await refreshCounts();
  notifyTaskChanged();
  exitBatchMode();
}

/** 批量加标签（逐个 task × tag 关联） */
async function batchAddTags(ids: string[], tagIds: string[]): Promise<void> {
  for (const taskId of ids) {
    for (const tagId of tagIds) {
      await db.addTaskTag(taskId, tagId);
    }
  }
  await preloadTaskTags();       // 刷新标签缓存
  exitBatchMode();
}

/** 批量删除 */
async function batchDelete(ids: string[]): Promise<void> {
  for (const id of ids) {
    await db.deleteTask(id);
  }
  await reload(true);
  await refreshCounts();
  notifyTaskChanged();
  exitBatchMode();
}
```

### 导出
在 store return 对象里加入所有新增的 state、computed、action。

**验证**：store 单元逻辑正确性可通过 Vue devtools 观察 `batchSelectedIds` 变化。
此步无 UI，类型检查通过即可（`npx vue-tsc --noEmit`）。

---

## 步骤 2：TaskListItem 修饰键点击 + 选中态 UI

**文件**：`src/components/TaskListItem.vue`

### 改造 emit 签名

```ts
// 旧
emit('select', [])
// 新：带出 MouseEvent，让视图层判断修饰键
emit('select', [e: MouseEvent])
```

把模板 `@click="$emit('select')"` 改为 `@click="onRowClick"`，新增方法：

```ts
function onRowClick(e: MouseEvent): void {
  emit('select', e);
}
```

### 新增 props

```ts
defineProps<{
  // ... 现有 props
  /** 是否处于批量多选模式 */
  batchMode?: boolean;
  /** 当前任务是否被批量选中 */
  batchSelected?: boolean;
}>()
```

### 选中态视觉

根 div class 加：
```vue
:class="{
  ...,
  'task-item--batch-selected': batchSelected,
}"
```

左侧（展开箭头之前）多选模式下显示勾选标记：
```vue
<span
  v-if="batchMode"
  class="task-item__batch-check"
  :class="{ 'task-item__batch-check--on': batchSelected }"
>
  <icon-check v-if="batchSelected" :size="11" style="color:#fff" />
</span>
```

样式：复用 TaskCheckbox 的视觉（16×16 圆角框，选中时主色填充 + 白勾），
但这里用**圆形**以区别于完成复选框（方形）。

```css
.task-item--batch-selected {
  background-color: var(--jt-accent-soft) !important;
}
.task-item__batch-check {
  width: 16px; height: 16px;
  border-radius: 50%;             /* 圆形，区别于方形完成框 */
  border: 2px solid var(--jt-text-tertiary);
  display: flex; align-items: center; justify-content: center;
  flex-shrink: 0;
  transition: all 0.2s ease;
}
.task-item__batch-check--on {
  background-color: var(--jt-primary);
  border-color: var(--jt-primary);
}
```

**验证**：传 `batchMode=true batchSelected=true` 时行底色变 accent-soft、左侧出现填充圆形勾。

---

## 步骤 3：视图层转发多选事件 + 右键菜单加「多选」入口

**文件**：`src/views/ListView.vue`、`SmartView.vue`、`TagView.vue`、`src/components/TaskListItem.vue`

### 视图层改 @select 绑定

三个视图的未完成区 + 已完成区 `<TaskListItem>` 都改：

```vue
<!-- 旧 -->
<TaskListItem
  @select="taskStore.selectTask(task.id)"
/>
<!-- 新 -->
<TaskListItem
  :batch-mode="taskStore.batchMode"
  :batch-selected="taskStore.isBatchSelected(task.id)"
  @select="(e) => onTaskRowSelect(task.id, e)"
/>
```

新增视图级方法（三视图相同，可抽 composable，但第一版内联即可——DRY 留给后续优化）：

```ts
function onTaskRowSelect(taskId: string, e: MouseEvent): void {
  if (e.shiftKey) {
    taskStore.rangeBatchSelect(taskId);
  } else if (e.metaKey || e.ctrlKey) {
    taskStore.toggleBatchSelect(taskId);
  } else if (taskStore.batchMode) {
    // 多选模式下普通点击 = 增减选
    taskStore.toggleBatchSelect(taskId);
  } else {
    taskStore.selectTask(taskId);
  }
}
```

### TaskListItem 右键菜单加「多选」入口

在现有 ContextMenu（3 项）顶部加一个分隔线 + 「多选」项：

```vue
<ContextMenu v-model:visible="ctxMenu.visible" :x="ctxMenu.x" :y="ctxMenu.y">
  <!-- 新增：多选入口 -->
  <MenuPopoverItem @click="onCtxEnterBatchMode">
    <icon-check-circle :size="15" />
    <span>多选</span>
  </MenuPopoverItem>
  <!-- 分隔线（MenuPopoverItem 无 divider，用现有分隔写法，或加一个 hr） -->
  ...
  <!-- 现有 3 项 -->
</ContextMenu>
```

`onCtxEnterBatchMode`：
```ts
async function onCtxEnterBatchMode(): Promise<void> {
  ctxMenu.visible = false;
  // 直接选中当前任务并进入多选模式，用户可继续勾选其他任务
  taskStore.toggleBatchSelect(props.task.id);
}
```

**验证**：
- Shift+点击多个任务 → 行高亮、左侧出圆形勾
- Cmd+点击 → 增减选
- 右键任务 → 菜单出现「多选」项 → 点击后进入多选模式，出现勾选框

---

## 步骤 4：批量右键菜单组件

**新增文件**：`src/components/BatchContextMenu.vue`

> 多选模式下右键任意选中任务时显示。

### 结构

```vue
<script setup lang="ts">
import { ref, computed } from "vue";
import { useTaskStore } from "@/stores/task";
import { useListStore } from "@/stores/list";
import { useTagStore } from "@/stores/tag";
import ContextMenu from "./ContextMenu.vue";
import MenuPopoverItem from "./MenuPopoverItem.vue";
import DatePopover from "./DatePopover.vue";
import { PRIORITY_LABELS } from "@/types";
import PriorityDot from "./PriorityDot.vue";

const props = defineProps<{
  visible: boolean;
  x: number;
  y: number;
}>();
const emit = defineEmits<{ "update:visible": [v: boolean] }>();

const taskStore = useTaskStore();
const listStore = useListStore();
const tagStore = useTagStore();

const selectedCount = computed(() => taskStore.batchSelectedTasks.length);

/** 子面板：null=主菜单 | 'list' | 'tag' | 'priority' | 'date' */
const panel = ref<null | "list" | "tag" | "priority" | "date">(null);

// ── 清单选项（扁平，仅 task kind；笔记不进入批量操作菜单） ──
const listOptions = computed(() =>
  listStore.taskLists.map(l => ({ id: l.id, name: l.name, color: l.color }))
);

// ── 标签选项（复用 tagStore.tags） ──
const tagOptions = computed(() => tagStore.tags);
const selectedTagIds = ref<string[]>([]);

// ── 各操作处理 ──
async function applyList(listId: string): Promise<void> {
  emit("update:visible", false);
  await taskStore.batchUpdateFields(
    taskStore.batchSelectedIdsArr,
    { listId },
  );
}
async function applyPriority(p: Priority): Promise<void> {
  emit("update:visible", false);
  await taskStore.batchUpdateFields(taskStore.batchSelectedIdsArr, { priority: p });
}
async function applyTags(): Promise<void> {
  emit("update:visible", false);
  await taskStore.batchAddTags(taskStore.batchSelectedIdsArr, selectedTagIds.value);
  selectedTagIds.value = [];
}
async function applyDate(start: string | null, end: string | null): Promise<void> {
  emit("update:visible", false);
  await taskStore.batchUpdateFields(
    taskStore.batchSelectedIdsArr,
    { dueStartAt: start, dueEndAt: end },
  );
}
async function applyToggleDone(done: boolean): Promise<void> {
  emit("update:visible", false);
  await taskStore.batchToggleDone(taskStore.batchSelectedIdsArr, done);
}
async function applyDelete(): Promise<void> {
  emit("update:visible", false);
  await taskStore.batchDelete(taskStore.batchSelectedIdsArr);
}
</script>
```

### 模板（二级面板：点主菜单项 → 切换 panel → 显示对应列表）

```vue
<template>
  <ContextMenu :visible="visible" :x="x" :y="y" @update:visible="emit('update:visible', $event)">
    <!-- 标题 -->
    <div class="batch-menu__title">已选 {{ selectedCount }} 个任务</div>

    <!-- 主面板 -->
    <template v-if="!panel">
      <MenuPopoverItem @click="applyToggleDone(true)">
        <icon-check :size="15" /> <span>标记完成</span>
      </MenuPopoverItem>
      <MenuPopoverItem @click="applyToggleDone(false)">
        <icon-undo :size="15" /> <span>取消完成</span>
      </MenuPopoverItem>
      <MenuPopoverItem @click="panel = 'list'">
        <icon-folder :size="15" /> <span>移到清单</span> <icon-right class="batch-menu__arrow" :size="12" />
      </MenuPopoverItem>
      <MenuPopoverItem @click="panel = 'tag'">
        <icon-tag :size="15" /> <span>加标签</span> <icon-right class="batch-menu__arrow" :size="12" />
      </MenuPopoverItem>
      <MenuPopoverItem @click="panel = 'priority'">
        <icon-fire :size="15" /> <span>改优先级</span> <icon-right class="batch-menu__arrow" :size="12" />
      </MenuPopoverItem>
      <MenuPopoverItem @click="panel = 'date'">
        <icon-calendar :size="15" /> <span>改截止日期</span> <icon-right class="batch-menu__arrow" :size="12" />
      </MenuPopoverItem>
      <div class="batch-menu__divider" />
      <MenuPopoverItem danger @click="applyDelete">
        <icon-delete :size="15" /> <span>删除（{{ selectedCount }}）</span>
      </MenuPopoverItem>
    </template>

    <!-- 二级面板：移到清单 -->
    <template v-else-if="panel === 'list'">
      <MenuPopoverItem @click="panel = null"><icon-left :size="14" /> <span>返回</span></MenuPopoverItem>
      <div class="batch-menu__divider" />
      <MenuPopoverItem v-for="l in listOptions" :key="l.id" @click="applyList(l.id)">
        <span class="batch-menu__dot" :style="{ background: l.color || '#6B7280' }" />
        <span>{{ l.name }}</span>
      </MenuPopoverItem>
    </template>

    <!-- 二级面板：改优先级 -->
    <template v-else-if="panel === 'priority'">
      <MenuPopoverItem @click="panel = null"><icon-left :size="14" /> <span>返回</span></MenuPopoverItem>
      <div class="batch-menu__divider" />
      <MenuPopoverItem v-for="(label, p) in PRIORITY_LABELS" :key="p" @click="applyPriority(Number(p) as Priority)">
        <PriorityDot :priority="Number(p) as Priority" />
        <span>{{ label }}</span>
      </MenuPopoverItem>
    </template>

    <!-- 二级面板：加标签（复用 TagSelectPopover 的数据 + checkbox 列表） -->
    <template v-else-if="panel === 'tag'">
      <MenuPopoverItem @click="panel = null"><icon-left :size="14" /> <span>返回</span></MenuPopoverItem>
      <div class="batch-menu__divider" />
      <MenuPopoverItem v-for="t in tagOptions" :key="t.id" @click="toggleTag(t.id)">
        <icon-check v-if="selectedTagIds.includes(t.id)" :size="14" />
        <span>{{ t.name }}</span>
      </MenuPopoverItem>
      <div class="batch-menu__divider" />
      <MenuPopoverItem @click="applyTags">
        <icon-check-circle :size="15" /> <span>应用到 {{ selectedCount }} 个任务</span>
      </MenuPopoverItem>
    </template>

    <!-- 二级面板：改截止日期（复用 DatePopover） -->
    <template v-else-if="panel === 'date'">
      <MenuPopoverItem @click="panel = null"><icon-left :size="14" /> <span>返回</span></MenuPopoverItem>
      <div class="batch-menu__divider" />
      <DatePopover :start-iso="null" :end-iso="null" @confirm="applyDate" @clear="() => applyDate(null, null)" />
    </template>
  </ContextMenu>
</template>
```

### store 需补充一个数组形式（方便传参）

```ts
const batchSelectedIdsArr = computed(() => Array.from(batchSelectedIds.value));
```

### 挂载位置

在三个视图里各自渲染 `<BatchContextMenu>`，由视图持有菜单的 visible/x/y 状态。

**触发逻辑**（视图层，与步骤 3 的右键分流配合）：
- TaskListItem 的 `@contextmenu` 现在是 `.prevent.stop`（不冒泡到视图）。
- 改造：多选模式下，TaskListItem 不再 stop，而是 emit 一个 `contextmenu` 事件给视图，
  视图层判断「多选模式 + 右键任务在选中集合内」→ 打开 BatchContextMenu。
- 非多选模式 → 保持现有 TaskListItem 内部 ContextMenu（含「多选」入口）。

**验证**：
- 多选 3 个任务 → 右键 → 弹批量菜单 → 标题显示「已选 3 个任务」
- 点「移到清单」→ 二级面板列出清单 → 选一个 → 3 个任务都移过去
- 点「删除（3）」→ 3 个任务删除
- 每个子面板有「返回」回到主菜单

---

## 步骤 5：全局键盘：Esc 退多选、Cmd+A 全选

**文件**：`src/layouts/AppLayout.vue`（`onNavigationKeydown`，约 131-194 行）

### Esc 优先退多选

在现有 Esc 处理（155 行）**之前**插入：

```ts
if (e.key === "Escape") {
  // 多选模式激活时，Esc 优先退出多选（不关详情面板）
  if (taskStore.batchMode) {
    e.preventDefault();
    taskStore.exitBatchMode();
    return;
  }
  // ... 现有 hasDetailOverlay / detailOpen 逻辑
}
```

### Cmd+A 全选

在输入框守卫（149 行）之后、Esc（155 行）之前插入：

```ts
const mod = e.metaKey || e.ctrlKey;
if (mod && !e.shiftKey && (e.key === "a" || e.key === "A")) {
  // 仅任务族视图（侧边栏显示时）且非输入框聚焦
  if (showTaskSidebar.value) {
    e.preventDefault();
    taskStore.selectAllBatch();
  }
  return;
}
```

> 注意：`Cmd+Shift+A` 已被快速添加占用，这里用 `!e.shiftKey` 避开冲突。

**验证**：
- 多选模式按 Esc → 退出多选
- Cmd+A → 当前视图未完成任务全选
- 输入框聚焦时 Cmd+A → 浏览器原生全选文本（不触发任务全选）

---

## 实现顺序与验证节点

1. **步骤 1**（store）→ 类型检查通过 → 提交
2. **步骤 2**（TaskListItem UI）→ 手动传 props 验证选中态 → 提交
3. **步骤 3**（视图转发 + 右键「多选」入口）→ Shift/Cmd 多选可用 → 提交
4. **步骤 4**（BatchContextMenu）→ 6 项操作全部可用 → 提交
5. **步骤 5**（键盘）→ Esc/Cmd+A → 提交

每步独立提交，便于回溯。

---

## 复用清单（避免重复造轮子）

| 需求 | 复用 | 位置 |
|------|------|------|
| 右键菜单容器 | `ContextMenu.vue` | 已有 |
| 菜单项 | `MenuPopoverItem.vue` | 已有 |
| 优先级文案 | `PRIORITY_LABELS` | `types/index.ts:25` |
| 优先级色点 | `PriorityDot.vue` | 已有 |
| 清单数据 | `listStore.taskLists` | `stores/list.ts:73` |
| 标签数据 | `tagStore.tags` | `stores/tag.ts` |
| 日期选择器 | `DatePopover.vue` | 已有（props 驱动） |
| 批量落库 | `db.updateTask` / `db.toggleTask` / `db.addTaskTag` / `db.deleteTask` | 循环调用 |

---

## 不做的事（第一版边界，呼应设计文档）

1. ❌ 任务级归档（tasks 表无 archived 字段，需 DB 改造）
2. ❌ 清单树/标签树本身的批量操作（用户明确排除）
3. ❌ hover 级联子菜单（用「点击进入二级面板」）
4. ❌ 后端批量命令（前端循环，YAGNI）
5. ❌ 跨视图多选、鼠标框选、拖拽多选
6. ❌ 批量改标题/备注（无意义）

---

## 风险与注意事项

1. **`batchUpdateFields` 绕过 store action 直接调 db**：
   绕过了 `clampDateRange`（日期钳制）。批量改日期时，需在 action 内部对 start/end 做钳制，
   或在 applyDate 里调用前钳制。**修正**：在 `batchUpdateFields` 里，若 fields 含日期，先钳制。
2. **DatePopover 在 ContextMenu 内的定位**：
   DatePopover 自带 248px 宽浮层，放在二级面板里可能超出视口。需测试边界，
   必要时给 BatchContextMenu 的 ContextMenu 加 `max-height` + 滚动。
3. **右键冒泡改造**：
   TaskListItem 现有 `@contextmenu.prevent.stop`，多选模式下需改为 emit 给视图。
   要确保非多选时行为不变（单任务菜单仍正常）。
4. **reload(true) 的副作用**：
   批量操作后 `reload(true)` 会重新查库，若详情面板打开着会保留选中。
   但若选中的任务被删除/移动，selectedTaskObj 可能失效——需测试。
