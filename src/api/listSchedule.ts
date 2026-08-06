// 清单生成计划 —— IPC 封装
// 调用 Rust 的 list_schedule_* 命令（src-tauri/src/list_schedule/mod.rs）

import { invoke } from "@tauri-apps/api/core";
import {
  type ListSchedule,
  type ListScheduleFreq,
  type ListScheduleLeafType,
  type ListScheduleRow,
  mapListScheduleRow,
} from "@/types/listSchedule";

/** 新建计划入参 */
export interface CreateScheduleInput {
  name: string;
  pathTemplate: string;
  freq: ListScheduleFreq;
  leafType: ListScheduleLeafType;
  color: string;
}

/** 更新计划入参（所有字段可选） */
export type UpdateScheduleInput = Partial<{
  name: string;
  pathTemplate: string;
  freq: ListScheduleFreq;
  leafType: ListScheduleLeafType;
  color: string;
  enabled: boolean;
}>;

/** 查全部计划 */
export async function getListSchedules(): Promise<ListSchedule[]> {
  const rows = await invoke<ListScheduleRow[]>("list_schedule_get_all");
  return rows.map(mapListScheduleRow);
}

/** 新建计划 */
export async function createListSchedule(
  input: CreateScheduleInput,
): Promise<ListSchedule> {
  // Rust 的 CreateScheduleInput 用 serde camelCase，直接传
  const row = await invoke<ListScheduleRow>("list_schedule_create", { input });
  return mapListScheduleRow(row);
}

/** 更新计划（支持部分字段） */
export async function updateListSchedule(
  id: string,
  input: UpdateScheduleInput,
): Promise<void> {
  await invoke<void>("list_schedule_update", { id, input });
}

/** 删除计划 */
export async function deleteListSchedule(id: string): Promise<void> {
  await invoke<void>("list_schedule_delete", { id });
}

/** 立即触发一次 tick（手动测试 / 补生成用） */
export async function runListScheduleNow(): Promise<number> {
  return await invoke<number>("list_schedule_run_now");
}

/** 手动运行单个计划（跳过 enabled 过滤，返回是否生成了新清单/目录） */
export async function runListScheduleOne(id: string): Promise<number> {
  return await invoke<number>("list_schedule_run_one", { id });
}

/** 预览结果（某条计划在指定日期的模拟运行） */
export interface SchedulePreview {
  name: string;
  freq: string;
  /** 该日是否命中 */
  hit: boolean;
  /** 渲染后的完整路径 */
  path: string;
  /** 最末段是否为目录 */
  is_folder: boolean;
}

/**
 * 预览：模拟某一天运行会生成哪些路径（不实际创建）
 * date 格式 YYYY-MM-DD，如 "2026-08-01"
 */
export async function previewListSchedule(
  date: string,
): Promise<SchedulePreview[]> {
  return await invoke<SchedulePreview[]>("list_schedule_preview", { date });
}
