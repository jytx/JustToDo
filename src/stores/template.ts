// 模板 store —— 管理"任务参数预设"的 CRUD + applyTemplate 编排
// 模板独立存 templates 表（加 kind 字段区分 task/note）；应用模板时由本 store
// 调用 taskStore + db 完成条目创建（任务走默认清单，笔记走当前笔记本/默认笔记本）。
// 遵循 AGENTS.md：store 作为唯一数据源，组件只读取不缓存

import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { useRoute } from "vue-router";
import type { Template, TemplateForm, Task, TaskKind } from "@/types";
import * as db from "@/api/db";
import { useTaskStore } from "@/stores/task";
import { useSettingsStore } from "@/stores/settings";
import { useListStore } from "@/stores/list";
import { replacePlaceholders } from "@/utils/template";

export const useTemplateStore = defineStore("template", () => {
  const templates = ref<Template[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  /** 按 position 升序（与 Rust 端 ORDER BY 一致；computed 仅为保持引用稳定） */
  const sortedTemplates = computed(() =>
    [...templates.value].sort((a, b) => a.position - b.position),
  );

  /** 任务模板子集（kind='task'）—— AddTaskBar/QuickAddDialog 任务模式用 */
  const taskTemplates = computed(() =>
    sortedTemplates.value.filter((t) => t.kind !== "note"),
  );
  /** 笔记模板子集（kind='note'）—— AddTaskBar/QuickAddDialog 笔记模式用 */
  const noteTemplates = computed(() =>
    sortedTemplates.value.filter((t) => t.kind === "note"),
  );

  /** 从 DB 加载全部模板（App 初始化时调用） */
  async function loadTemplates(): Promise<void> {
    loading.value = true;
    error.value = null;
    try {
      templates.value = await db.getTemplates();
    } catch (e) {
      error.value = String(e);
      console.error("[templateStore] loadTemplates 失败:", e);
    } finally {
      loading.value = false;
    }
  }

  /** 新建模板 */
  async function createTemplate(params: {
    name: string;
    title: string;
    note: string;
    /** 实体类型：不传默认 'task'；'note' = 笔记模板 */
    kind?: TaskKind;
  }): Promise<Template> {
    const tpl = await db.createTemplate(params);
    templates.value.push(tpl);
    return tpl;
  }

  /** 更新模板（partial fields；不传的字段不动） */
  async function updateTemplate(
    id: string,
    fields: { name?: string; title?: string; note?: string; kind?: TaskKind },
  ): Promise<void> {
    await db.updateTemplate(id, fields);
    // 同步本地
    const idx = templates.value.findIndex((t) => t.id === id);
    if (idx >= 0) {
      const cur = templates.value[idx];
      templates.value[idx] = {
        ...cur,
        name: fields.name ?? cur.name,
        title: fields.title ?? cur.title,
        note: fields.note ?? cur.note,
        kind: fields.kind ?? cur.kind,
        updatedAt: new Date().toISOString(),
      };
    }
  }

  /** 重命名（封装 updateTemplate 仅传 name） */
  async function renameTemplate(id: string, name: string): Promise<void> {
    await updateTemplate(id, { name });
  }

  /** 删除 */
  async function deleteTemplate(id: string): Promise<void> {
    await db.deleteTemplate(id);
    templates.value = templates.value.filter((t) => t.id !== id);
  }

  /**
   * 重排模板：接收新的 id 顺序数组，写回本地 + 持久化
   *
   * position 用 1000 的间隔重排（避免频繁拖拽后浮点累积）。
   * 调用方通常传拖拽后的完整新顺序 ids。
   */
  async function reorderTemplates(newOrderIds: string[]): Promise<void> {
    if (newOrderIds.length !== templates.value.length) return;
    // 1. 本地：按新顺序重排 + 重新分配 position
    const idToNewPos = new Map<string, number>();
    const items: [string, number][] = [];
    newOrderIds.forEach((id, idx) => {
      const pos = (idx + 1) * 1000;
      idToNewPos.set(id, pos);
      items.push([id, pos]);
    });
    // 重建 templates 数组（保持新顺序，更新 position）
    const newTemplates: Template[] = newOrderIds
      .map((id) => templates.value.find((t) => t.id === id))
      .filter((t): t is Template => t !== undefined)
      .map((t) => ({ ...t, position: idToNewPos.get(t.id) ?? t.position }));
    templates.value = newTemplates;
    // 2. 持久化
    try {
      await db.reorderTemplates(items);
    } catch (e) {
      console.error("[templateStore] reorderTemplates 持久化失败:", e);
      // 失败时重新加载，恢复服务端真实顺序
      await loadTemplates();
    }
  }

  /**
   * 应用模板：先保存表单 → 创建条目（任务/笔记）→ 写 note → 打开详情面板
   *
   * 入参 form.id === null 表示新建模式（先创建模板拿到 id）
   * 返回新建的 Task 对象（笔记也是 Task 类型，kind='note'），供调用方做后续 UI 反馈
   *
   * 落地清单策略：
   * - 任务模板（kind='task'）→ 全局默认清单（settings.templateDefaultListId || 'inbox'）
   * - 笔记模板（kind='note'）→ 当前笔记本（/notebook/:id）或默认笔记本（default-notebook）
   */
  async function applyTemplate(form: TemplateForm): Promise<Task> {
    if (!form.name.trim()) {
      throw new Error("模板名称不能为空");
    }
    const kind: TaskKind = form.kind ?? "task";

    // 1. 落库模板（新建模式先创建；编辑模式直接更新）
    // 编辑模式不传 kind —— 模板创建后 kind 不可改，避免误操作改变模板语义。
    if (form.id === null) {
      await createTemplate({
        name: form.name,
        title: form.title,
        note: form.note,
        kind,
      });
    } else {
      await updateTemplate(form.id, {
        name: form.name,
        title: form.title,
        note: form.note,
      });
    }

    // 2. 解析落地清单
    const settings = useSettingsStore();
    const route = useRoute();
    let listId: string;
    if (kind === "note") {
      // 笔记：当前笔记本（/notebook/:id）优先；否则默认笔记本
      const routeName = route.name as string;
      const routeId = route.params.id as string | undefined;
      const listStore = useListStore();
      const cur =
        routeName === "notebook" && routeId
          ? listStore.getById(routeId)
          : undefined;
      listId = cur && cur.kind === "note" ? cur.id : "default-notebook";
    } else {
      // 任务：全局默认清单
      listId = settings.templateDefaultListId || "inbox";
    }

    // 2.5 占位符替换：{{date_cn}} 等替换为实际值（仅作用于新建条目，不改模板本身）
    const resolvedTitle = replacePlaceholders(form.title || form.name);
    const resolvedNote = replacePlaceholders(form.note);

    // 3. 创建条目（任务/笔记统一走 taskStore.createTask，按 kind 区分）
    const taskStore = useTaskStore();
    const task = await taskStore.createTask({
      title: resolvedTitle,
      listId,
      kind,
    });

    // 4. 写 note（task_create 不接受 note，必须二次 update）
    // 用 taskStore.updateTask 而非 db.updateTask —— 这样能同步 selectedTaskObj，
    // 否则详情面板读到的还是 createTask 返回的 note='' 快照
    if (resolvedNote) {
      await taskStore.updateTask(task.id, { note: resolvedNote });
    }

    // 5. 打开详情面板
    await taskStore.selectTask(task.id);

    return { ...task, note: resolvedNote };
  }

  return {
    templates,
    sortedTemplates,
    taskTemplates,
    noteTemplates,
    loading,
    error,
    loadTemplates,
    createTemplate,
    updateTemplate,
    renameTemplate,
    deleteTemplate,
    reorderTemplates,
    applyTemplate,
  };
});
