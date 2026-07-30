# 清单生成计划功能实现计划

> **设计依据：** `discuss/2026-07-30-list-schedule-design.md`
> **状态：** 待执行

**Goal：** 让用户可配置"清单生成计划"（路径模板 + 频率 + 颜色），后台按规则自动创建月目录 / 日清单，工作日频率会跳过法定节假日。

**Architecture：** Rust 端新增独立模块 `src-tauri/src/list_schedule/`（4 个文件，避免污染已超长的 commands.rs），两张新表（list_schedules + holidays）走 migration 021。调度逻辑挂进 `lib.rs:84` 的现有每分钟后台循环。节假日数据用 `reqwest`（Cargo 新增依赖）启动时拉取并缓存到 holidays 表，断网降级为纯周末判断 + 通知。

**Tech Stack：** Tauri 2.x / Rust（sqlx）/ reqwest（新增）/ Vue 3.5 `<script setup>` / Pinia / Arco Design Vue

**验证手段说明（本项目无自动化测试框架）：**
- Rust 改动 → `cd src-tauri && cargo check`（src-tauri 下执行）
- 前端改动 → `npx vue-tsc --noEmit`（项目根）
- 联调验证 → `bash scripts/dev.sh` 启动应用手动测试（仅功能任务需要）

---

## 文件结构（实施前总览）

**新建文件：**

| 文件 | 职责 |
|---|---|
| `src-tauri/src/db/migrations/021_list_schedules.sql` | 建两张表（list_schedules + holidays，幂等） |
| `src-tauri/src/list_schedule/mod.rs` | 模块入口 + `list_schedule_tick` 调度主循环 + IPC commands |
| `src-tauri/src/list_schedule/models.rs` | `ListSchedule` / `Holiday` 结构体 |
| `src-tauri/src/list_schedule/generate.rs` | 路径模板渲染 + 逐级创建（纯函数为主） |
| `src-tauri/src/list_schedule/holiday.rs` | 节假日获取/缓存/工作日判断 |
| `src/types/listSchedule.ts` | `ListSchedule` / `ListScheduleFreq` 类型 + mapRow |
| `src/api/listSchedule.ts` | IPC 封装（5 个函数） |
| `src/stores/listSchedule.ts` | Pinia store：CRUD |
| `src/components/ListScheduleSection.vue` | 设置页 section 容器 |
| `src/components/ListScheduleEditModal.vue` | 新建/编辑弹窗 |
| `src/components/ListScheduleCard.vue` | 单条计划卡片 |

**修改文件：**

| 文件 | 改动点 |
|---|---|
| `src-tauri/Cargo.toml` | 加 `reqwest = { version = "0.12", features = ["json", "rustls-tls"], default-features = false }` |
| `src-tauri/src/lib.rs` | `mod list_schedule;` + `generate_handler!` 登记 5 命令 + tick 循环加一步 + setup 加节假日获取 |
| `src-tauri/src/db/mod.rs` | 注册 021 migration（`include_str!` 常量 + init_pool 调用） |
| `src/views/SettingsView.vue` | sections 加「清单生成计划」项 + section 渲染 |

---

## Task 1：Cargo 依赖 + Migration 021（两张表）

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Create: `src-tauri/src/db/migrations/021_list_schedules.sql`
- Modify: `src-tauri/src/db/mod.rs`

- [ ] **Step 1.1：Cargo.toml 新增 reqwest 依赖**

在 `[dependencies]` 末尾加（`rustls-tls` 避免引入 OpenSSL 系统依赖，跨平台更稳）：

```toml
reqwest = { version = "0.12", features = ["json", "rustls-tls"], default-features = false }
```

- [ ] **Step 1.2：创建 migration 021 SQL 文件**

`src-tauri/src/db/migrations/021_list_schedules.sql`：

```sql
-- 021: 清单生成计划 + 节假日缓存
-- 设计依据：discuss/2026-07-30-list-schedule-design.md
--
-- list_schedules：用户配置的"自动建清单"规则。
--   每条规则 = 路径模板 + 频率 + 颜色。tick 命中频率时渲染路径并逐级建清单。
-- holidays：法定节假日缓存（按年批量，来自 NateScarlet/holiday-cn）。
--   is_off_day=1 放假；is_off_day=0 调休补班。工作日频率据此判断。

CREATE TABLE IF NOT EXISTS list_schedules (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    path_template TEXT NOT NULL,
    freq          TEXT NOT NULL,              -- daily/weekly/monthly/yearly/workday
    color         TEXT NOT NULL,
    enabled       INTEGER NOT NULL DEFAULT 1,
    position      INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_list_schedules_position ON list_schedules(position);

CREATE TABLE IF NOT EXISTS holidays (
    date       TEXT PRIMARY KEY,              -- YYYY-MM-DD
    year       INTEGER NOT NULL,
    is_off_day INTEGER NOT NULL,              -- 1=放假 0=调休补班
    name       TEXT
);

CREATE INDEX IF NOT EXISTS idx_holidays_year ON holidays(year);
```

- [ ] **Step 1.3：db/mod.rs 注册 021**

在常量声明区（`MIGRATIONS_017` 旁）加：
```rust
pub const MIGRATIONS_021: &str = include_str!("migrations/021_list_schedules.sql");
```
在 `init_pool` 的 020 之后加：
```rust
// 021: 清单生成计划 + 节假日缓存
sqlx::query(MIGRATIONS_021)
    .execute(&pool)
    .await
    .map_err(|e| format!("执行迁移 021_list_schedules 失败: {}", e))?;
```

- [ ] **Step 1.4：验证**
`cd src-tauri && cargo check` 通过。

---

## Task 2：Rust 数据模型（models.rs）

**Files:**
- Create: `src-tauri/src/list_schedule/models.rs`

- [ ] **Step 2.1：定义结构体**

```rust
use serde::{Deserialize, Serialize};

/// 清单生成计划 —— 用户配置的"自动建清单"规则
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListSchedule {
    pub id: String,
    pub name: String,
    pub path_template: String,
    pub freq: String,            // daily/weekly/monthly/yearly/workday
    pub color: String,
    pub enabled: bool,
    pub position: i64,
    pub created_at: String,
}

/// 节假日缓存条目（对应 holidays 表一行）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Holiday {
    pub date: String,            // YYYY-MM-DD
    pub year: i32,
    pub is_off_day: bool,
    pub name: Option<String>,
}

/// holiday-cn 接口返回结构（仅取需要的字段）
#[derive(Debug, Deserialize)]
pub struct HolidayCnDay {
    pub date: String,
    pub is_off_day: bool,
    pub name: String,
}

#[derive(Debug, Deserialize)]
pub struct HolidayCnYear {
    pub year: i32,
    pub days: Vec<HolidayCnDay>,
}
```

- [ ] **Step 2.2：验证**（需 Task 4 的 mod.rs 声明后整体 check，此处先跳过单独验证）

---

## Task 3：路径模板渲染 + 逐级创建（generate.rs）

**Files:**
- Create: `src-tauri/src/list_schedule/generate.rs`

- [ ] **Step 3.1：占位符渲染纯函数**

```rust
use chrono::NaiveDate;

/// 渲染路径模板占位符为具体路径
/// 按占位符长度降序替换，避免短占位符误伤长占位符
pub fn render_path_template(template: &str, date: NaiveDate) -> String {
    let year4 = format!("{:04}", date.year());
    let year2 = format!("{:02}", date.year() % 100);
    let month2 = format!("{:02}", date.month());
    let month1 = format!("{}", date.month());
    let day2 = format!("{:02}", date.day());
    let day1 = format!("{}", date.day());
    let ymd = format!("{}-{}-{}", year4, month2, day2);
    let ym = format!("{}-{}", year4, month2);

    // 长度降序：先替换长占位符，避免 {{YYYY}} 吃掉 {{YYYY-MM-DD}}
    template
        .replace("{{YYYY-MM-DD}}", &ymd)
        .replace("{{YYYY-MM}}", &ym)
        .replace("{{YYYY}}", &year4)
        .replace("{{YY}}", &year2)
        .replace("{{MM}}", &month2)
        .replace("{{M}}", &month1)
        .replace("{{DD}}", &day2)
        .replace("{{D}}", &day1)
}
```

- [ ] **Step 3.2：判断"今天是否命中频率"纯函数**

```rust
/// 判断给定日期是否命中某频率（不含 workday，workday 走 holiday 模块）
pub fn is_freq_hit(freq: &str, date: NaiveDate) -> bool {
    match freq {
        "daily" => true,
        "weekly" => date.weekday() == chrono::Weekday::Mon,
        "monthly" => date.day() == 1,
        "yearly" => date.month() == 1 && date.day() == 1,
        _ => false, // workday 由调用方结合 holiday 模块单独判断
    }
}

/// 根据 freq 决定路径最后一段是否为目录
pub fn leaf_is_folder(freq: &str) -> bool {
    matches!(freq, "monthly" | "yearly")
}
```

- [ ] **Step 3.3：逐级查找/创建函数**

复用 `list_create` 的建清单逻辑（逐级 `SELECT by (parent_id, name)`，找到复用、没找到才建）。返回最末段 list_id。

```rust
use sqlx::SqlitePool;
use crate::list_schedule::models::ListSchedule;

/// 确保路径存在，逐级创建目录/清单，返回最末段 id
/// 已存在则复用（天然幂等）
pub async fn ensure_scheduled_path(
    pool: &SqlitePool,
    path: &str,
    leaf_is_folder: bool,
    color: &str,
) -> Result<String, String> {
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    if segments.is_empty() {
        return Err("路径为空".to_string());
    }
    let mut parent_id: Option<String> = None;
    let total = segments.len();
    for (i, seg) in segments.iter().enumerate() {
        let is_leaf = i == total - 1;
        let is_folder = if is_leaf { leaf_is_folder } else { true };
        // 查找已有同名同父级
        let existing: Option<(String,)> = sqlx::query_as(
            "SELECT id FROM lists WHERE parent_id IS ? AND name = ? LIMIT 1",
        )
        .bind(&parent_id)
        .bind(seg)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("查询清单失败: {}", e))?;
        match existing {
            Some((id,)) => parent_id = Some(id),
            None => {
                // 不存在则创建（复用 list_create 的 SQL）
                let id = crate::commands::uuid();
                let ts = crate::commands::now();
                let position = chrono::Utc::now().timestamp_millis();
                let folder_flag = if is_folder { 1 } else { 0 };
                sqlx::query(
                    "INSERT INTO lists (id, name, color, position, created_at, parent_id, is_folder) VALUES ($1, $2, $3, $4, $5, $6, $7)",
                )
                .bind(&id)
                .bind(seg)
                .bind(color)
                .bind(position)
                .bind(&ts)
                .bind(&parent_id)
                .bind(folder_flag)
                .execute(pool)
                .await
                .map_err(|e| format!("创建清单失败: {}", e))?;
                parent_id = Some(id);
            }
        }
    }
    Ok(parent_id.unwrap())
}

/// 执行单条计划：渲染路径 + 逐级创建
pub async fn run_schedule(
    pool: &SqlitePool,
    schedule: &ListSchedule,
    date: NaiveDate,
) -> Result<(), String> {
    let path = render_path_template(&schedule.path_template, date);
    let leaf_folder = leaf_is_folder(&schedule.freq);
    ensure_scheduled_path(pool, &path, leaf_folder, &schedule.color).await?;
    Ok(())
}
```

> **注意：** 这里复用了 `commands::uuid()` / `commands::now()`，需确认它们是 `pub`。若不是，改为在 generate.rs 内复用同样逻辑或提为 pub。实施时先 grep 确认可见性，不满足则改为 pub fn。

---

## Task 4：节假日获取/缓存/判断（holiday.rs）

**Files:**
- Create: `src-tauri/src/list_schedule/holiday.rs`

- [ ] **Step 4.1：拉取并缓存某年节假日**

```rust
use sqlx::SqlitePool;
use crate::list_schedule::models::{HolidayCnYear, Holiday};

const HOLIDAY_CN_BASE: &str = "https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master";

/// 拉取并缓存指定年份的节假日数据
/// 失败返回 Err（由调用方降级处理）
pub async fn fetch_and_cache_year(pool: &SqlitePool, year: i32) -> Result<usize, String> {
    let url = format!("{}/{}.json", HOLIDAY_CN_BASE, year);
    let resp = reqwest::get(&url).await.map_err(|e| format!("请求节假日数据失败: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("节假日接口返回 {}", resp.status()));
    }
    let data: HolidayCnYear = resp.json().await.map_err(|e| format!("解析节假日数据失败: {}", e))?;
    // 逐条 INSERT OR REPLACE
    for d in &data.days {
        sqlx::query(
            "INSERT OR REPLACE INTO holidays (date, year, is_off_day, name) VALUES ($1, $2, $3, $4)",
        )
        .bind(&d.date)
        .bind(year)
        .bind(if d.is_off_day { 1 } else { 0 })
        .bind(&d.name)
        .execute(pool)
        .await
        .map_err(|e| format!("写入节假日缓存失败: {}", e))?;
    }
    Ok(data.days.len())
}

/// 检查并补齐当年 + 明年的节假日缓存
/// 缺失则拉取；失败返回错误，由调用方决定是否通知降级
pub async fn ensure_holiday_cache(pool: &SqlitePool) -> Result<(), Vec<String>> {
    let this_year = chrono::Local::now().year();
    let years = [this_year, this_year + 1];
    let mut errors: Vec<String> = Vec::new();
    for y in years {
        let cached: Option<(i64,)> = sqlx::query_as("SELECT COUNT(*) FROM holidays WHERE year = ?")
            .bind(y)
            .fetch_optional(pool)
            .await
            .map_err(|e| format!("查询缓存失败: {}", e))?;
        let count = cached.map(|(c,)| c).unwrap_or(0);
        if count == 0 {
            match fetch_and_cache_year(pool, y).await {
                Ok(_) => {}
                Err(e) => errors.push(format!("{} 年: {}", y, e)),
            }
        }
    }
    if errors.is_empty() { Ok(()) } else { Err(errors) }
}
```

- [ ] **Step 4.2：工作日判断纯函数（A 语义）**

```rust
use chrono::{NaiveDate, Datelike, Weekday};

/// 查询某天的节假日记录
async fn get_holiday_record(pool: &SqlitePool, date: NaiveDate) -> Option<Holiday> {
    let iso = format!("{:04}-{:02}-{:02}", date.year(), date.month(), date.day());
    let row: Option<(String, i32, i32, Option<String>)> = sqlx::query_as(
        "SELECT date, year, is_off_day, name FROM holidays WHERE date = ?",
    )
    .bind(&iso)
    .fetch_optional(pool)
    .await
    .ok()?;
    row.map(|(d, y, off, name)| Holiday { date: d, year: y, is_off_day: off != 0, name })
}

/// 判断某天是否为法定工作日（A 语义：完整法定工作日）
/// - 无记录：周一~周五为工作日
/// - is_off_day=true（放假）：非工作日
/// - is_off_day=false（调休补班）：工作日
pub async fn is_workday(pool: &SqlitePool, date: NaiveDate) -> bool {
    match get_holiday_record(pool, date).await {
        Some(h) => !h.is_off_day,
        None => {
            // 无记录降级为纯周末判断
            let wd = date.weekday();
            wd != Weekday::Sat && wd != Weekday::Sun
        }
    }
}
```

> **重要细节：** `is_workday` 是 async（查 DB），所以 `is_freq_hit("workday")` 不能用纯函数，需在 tick 里直接调 `is_workday`。这是设计文档里 "workday 由调用方结合 holiday 模块单独判断" 的落地。

---

## Task 5：调度主循环 + IPC commands（mod.rs）

**Files:**
- Create: `src-tauri/src/list_schedule/mod.rs`

- [ ] **Step 5.1：模块声明 + 行查询到结构体**

```rust
pub mod models;
pub mod generate;
pub mod holiday;

use models::ListSchedule;
use sqlx::SqlitePool;
use chrono::{Datelike, Local, NaiveDate};

/// 查全部 enabled 计划
async fn get_enabled_schedules(pool: &SqlitePool) -> Result<Vec<ListSchedule>, String> {
    let rows = sqlx::query_as(
        "SELECT id, name, path_template, freq, color, enabled, position, created_at \
         FROM list_schedules WHERE enabled = 1 ORDER BY position ASC",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("查询计划失败: {}", e))?;
    // sqlx::FromRow 需 derive，或手动 map（此处用手动 map 保证字段顺序与 SQL 一致）
    // ...
    Ok(rows)
}
```

> **实施注意：** sqlx query_as 需要 `FromRow` derive 或元组解构。鉴于 holiday.rs 已用元组解构风格，此处统一用手动 map 或 derive FromRow，实施时择一保持一致。

- [ ] **Step 5.2：tick 主逻辑（核心）**

```rust
/// 每轮 tick：检查今天是否该为各计划生成清单
/// 传入 today 便于测试；生产传 Local::now().date_naive()
pub async fn list_schedule_tick_inner(pool: &SqlitePool, today: NaiveDate) -> Result<u32, String> {
    let schedules = get_enabled_schedules(pool).await?;
    let mut count = 0u32;
    for s in &schedules {
        let hit = if s.freq == "workday" {
            holiday::is_workday(pool, today).await
        } else {
            generate::is_freq_hit(&s.freq, today)
        };
        if hit {
            if let Err(e) = generate::run_schedule(pool, s, today).await {
                eprintln!("[JustToDo] 计划「{}」生成失败: {}", s.name, e);
            } else {
                count += 1;
            }
        }
        // 月/年兜底：当期目录若不存在则补建（即使今天不是命中日）
        if matches!(s.freq, "monthly" | "yearly") {
            let _ = ensure_period_folder(pool, s, today).await;
        }
    }
    Ok(count)
}

/// 月/年兜底：渲染当期路径并确保存在（已存在则 ensure 跳过）
async fn ensure_period_folder(pool: &SqlitePool, s: &ListSchedule, today: NaiveDate) -> Result<(), String> {
    let path = generate::render_path_template(&s.path_template, today);
    generate::ensure_scheduled_path(pool, &path, true, &s.color).await
}

/// 对外：给 lib.rs 调用的入口（取今天）
pub async fn list_schedule_tick(pool: &SqlitePool) -> Result<u32, String> {
    list_schedule_tick_inner(pool, Local::now().date_naive()).await
}
```

> **关键设计落地：** 月/年兜底在 tick 里**每次都跑** `ensure_period_folder`，而它内部靠 `ensure_scheduled_path` 的"已存在则跳过"实现幂等——不会重复建，但保证当月目录始终在。daily/weekly/workday 不跑兜底（过去的日清单不补）。

- [ ] **Step 5.3：IPC commands（CRUD）**

```rust
#[tauri::command]
pub async fn list_schedule_get_all(pool: State<'_, SqlitePool>) -> CmdResult<Vec<ListSchedule>> { ... }

#[tauri::command]
pub async fn list_schedule_create(pool: State<'_, SqlitePool>, input: CreateScheduleInput) -> CmdResult<ListSchedule> { ... }

#[tauri::command]
pub async fn list_schedule_update(pool: State<'_, SqlitePool>, id: String, input: UpdateScheduleInput) -> CmdResult<()> { ... }

#[tauri::command]
pub async fn list_schedule_delete(pool: State<'_, SqlitePool>, id: String) -> CmdResult<()> { ... }

#[tauri::command]
pub async fn list_schedule_run_now(pool: State<'_, SqlitePool>) -> CmdResult<u32> { ... }
```

`CreateScheduleInput` / `UpdateScheduleInput` 放 models.rs，字段 camelCase（serde rename）。`CmdResult<T> = Result<T, String>` 复用 commands.rs 的别名（确认可见性，否则在 mod.rs 内 type 别名）。

- [ ] **Step 5.4：验证**
`cd src-tauri && cargo check` 通过；`cargo clippy` 无警告。

---

## Task 6：lib.rs 接线（循环 + 节假日获取 + 命令注册）

**Files:**
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 6.1：模块声明**

顶部 `mod` 区加：`mod list_schedule;`

- [ ] **Step 6.2：setup 阶段获取节假日缓存**

在 `app.manage(pool.clone());`（约 214 行）之前，启动一条异步任务拉取节假日，失败发通知降级：

```rust
{
    let pool_clone = pool.clone();
    let app_handle = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        use tauri_plugin_notification::NotificationExt;
        match list_schedule::holiday::ensure_holiday_cache(&pool_clone).await {
            Ok(_) => println!("[JustToDo] 节假日缓存已就绪"),
            Err(errs) => {
                let msg = errs.join("; ");
                eprintln!("[JustToDo] 节假日数据获取失败: {}", msg);
                let _ = app_handle.notification().builder()
                    .title("节假日数据未更新")
                    .body(format!("已按普通工作日处理。原因：{}", msg))
                    .show();
            }
        }
    });
}
```

- [ ] **Step 6.3：tick 挂进现有每分钟循环**

在 `lib.rs:84` 的 `loop` 内、`task_check_reminders_inner` 之后、`tokio::time::sleep` 之前，加：

```rust
// 清单生成计划：按规则自动建清单/目录
match list_schedule::list_schedule_tick(&pool_clone).await {
    Ok(n) if n > 0 => println!("[JustToDo] 生成了 {} 个计划清单", n),
    Ok(_) => {}
    Err(e) => println!("[JustToDo] 清单生成计划 tick 失败: {}", e),
}
```

- [ ] **Step 6.4：注册 5 个命令**

`generate_handler!` 列表末尾加：
```rust
commands::list_schedule_get_all,    // 实际路径 list_schedule::list_schedule_get_all，需调整可见性/位置
```
（命令函数定义在 `list_schedule` 模块，注册写 `list_schedule::list_schedule_get_all` 等 5 个）

- [ ] **Step 6.5：验证**
`cd src-tauri && cargo check` + `cargo clippy` 通过。

---

## Task 7：前端类型 + API 封装

**Files:**
- Create: `src/types/listSchedule.ts`
- Create: `src/api/listSchedule.ts`

- [ ] **Step 7.1：类型定义**

`src/types/listSchedule.ts`：

```ts
/** 清单生成计划频率 */
export type ListScheduleFreq = "daily" | "weekly" | "monthly" | "yearly" | "workday";

/** 频率选项（下拉用） */
export const LIST_SCHEDULE_FREQS: ReadonlyArray<{ value: ListScheduleFreq; label: string }> = [
  { value: "daily", label: "每天" },
  { value: "weekly", label: "每周（周一）" },
  { value: "monthly", label: "每月（1号）" },
  { value: "yearly", label: "每年（1月1日）" },
  { value: "workday", label: "工作日（跳过法定节假日）" },
];

/** 清单生成计划 */
export interface ListSchedule {
  id: string;
  name: string;
  pathTemplate: string;
  freq: ListScheduleFreq;
  color: string;
  enabled: boolean;
  position: number;
  createdAt: string;
}

/** Rust 行（snake_case） */
interface ListScheduleRow {
  id: string; name: string; path_template: string; freq: string;
  color: string; enabled: number; position: number; created_at: string;
}

/** 行 → 前端接口 */
export function mapListScheduleRow(row: ListScheduleRow): ListSchedule {
  return {
    id: row.id, name: row.name, pathTemplate: row.path_template,
    freq: row.freq as ListScheduleFreq, color: row.color,
    enabled: row.enabled !== 0, position: row.position, createdAt: row.created_at,
  };
}

/** 路径模板占位符说明表（UI 悬浮提示用） */
export const PATH_PLACEHOLDERS: ReadonlyArray<{ token: string; desc: string; example: string }> = [
  { token: "{{YYYY}}", desc: "4 位年", example: "2026" },
  { token: "{{YY}}", desc: "2 位年", example: "26" },
  { token: "{{MM}}", desc: "2 位月（补零）", example: "08" },
  { token: "{{M}}", desc: "月（不补零）", example: "8" },
  { token: "{{DD}}", desc: "2 位日（补零）", example: "01" },
  { token: "{{D}}", desc: "日（不补零）", example: "1" },
  { token: "{{YYYY-MM-DD}}", desc: "完整日期", example: "2026-08-01" },
  { token: "{{YYYY-MM}}", desc: "年月", example: "2026-08" },
];
```

- [ ] **Step 7.2：API 封装**

`src/api/listSchedule.ts`：

```ts
import { invoke } from "@tauri-apps/api/core";
import type { ListSchedule } from "@/types/listSchedule";
import { mapListScheduleRow } from "@/types/listSchedule";

interface RustRow { id: string; name: string; path_template: string; freq: string; color: string; enabled: boolean; position: number; created_at: string; }

export async function getListSchedules(): Promise<ListSchedule[]> {
  const rows = await invoke<RustRow[]>("list_schedule_get_all");
  return rows.map(mapListScheduleRow);
}

export async function createListSchedule(input: { name: string; pathTemplate: string; freq: string; color: string }): Promise<ListSchedule> {
  return await invoke<RustRow>("list_schedule_create", { input }).then(mapListScheduleRow);
}

export async function updateListSchedule(id: string, input: Partial<{ name: string; pathTemplate: string; freq: string; color: string; enabled: boolean }>): Promise<void> {
  await invoke<void>("list_schedule_update", { id, input });
}

export async function deleteListSchedule(id: string): Promise<void> {
  await invoke<void>("list_schedule_delete", { id });
}

/** 立即触发一次 tick（手动测试/补生成用） */
export async function runListScheduleNow(): Promise<number> {
  return await invoke<number>("list_schedule_run_now");
}
```

- [ ] **Step 7.3：验证**
`npx vue-tsc --noEmit` 通过。

---

## Task 8：前端 Pinia store

**Files:**
- Create: `src/stores/listSchedule.ts`

- [ ] **Step 8.1：store 定义**

```ts
import { defineStore } from "pinia";
import { ref, computed } from "vue";
import type { ListSchedule } from "@/types/listSchedule";
import * as api from "@/api/listSchedule";

export const useListScheduleStore = defineStore("listSchedule", () => {
  const schedules = ref<ListSchedule[]>([]);

  /** 启动时加载 */
  async function loadSchedules(): Promise<void> {
    schedules.value = await api.getListSchedules();
  }

  /** 新建（color 缺省由调用方随机） */
  async function createSchedule(input: { name: string; pathTemplate: string; freq: string; color: string }): Promise<void> {
    const created = await api.createListSchedule(input);
    schedules.value.push(created);
  }

  async function updateSchedule(id: string, input: Partial<ListSchedule>): Promise<void> {
    await api.updateListSchedule(id, input);
    const idx = schedules.value.findIndex((s) => s.id === id);
    if (idx >= 0) schedules.value[idx] = { ...schedules.value[idx], ...input };
  }

  async function deleteSchedule(id: string): Promise<void> {
    await api.deleteListSchedule(id);
    schedules.value = schedules.value.filter((s) => s.id !== id);
  }

  return { schedules, loadSchedules, createSchedule, updateSchedule, deleteSchedule };
});
```

- [ ] **Step 8.2：验证**
`npx vue-tsc --noEmit` 通过。

---

## Task 9：UI —— 列表卡片 + 弹窗 + section（3 个组件）

**Files:**
- Create: `src/components/ListScheduleCard.vue`
- Create: `src/components/ListScheduleEditModal.vue`
- Create: `src/components/ListScheduleSection.vue`

- [ ] **Step 9.1：ListScheduleCard.vue**

单条计划卡片，显示名称、频率标签、路径预览、颜色点；右侧启用开关 + 编辑/删除按钮。沿用 `TemplateCard.vue` 的极简卡风格 + `--jt-*` token。点击卡片或编辑按钮打开 `ListScheduleEditModal`。

- [ ] **Step 9.2：ListScheduleEditModal.vue**

新建/编辑弹窗，沿用 `sidebar-create-modal` 风格（宽 440），字段：
- 名称（input）
- 频率（SelectPopover 下拉，选项来自 `LIST_SCHEDULE_FREQS`）
- 路径模板（input）+ 右侧 `<a-tooltip position="bottom">` 包 `<IconInfoCircle :size="14">`，悬浮显示 `PATH_PLACEHOLDERS` 表格
- 颜色（复用 LIST_COLORS 8 色板，缺省随机 `LIST_COLORS[Math.floor(Math.random()*8)]`）

回车保存。编辑模式回填现有值。

- [ ] **Step 9.3：ListScheduleSection.vue**

设置页 section 容器，仿 `TemplateSection.vue`：
- 顶部一行说明文字 +「新建计划」按钮（打开 EditModal 空表单）
- 下方 `v-for` 渲染 `ListScheduleCard`
- onMounted 调 `listScheduleStore.loadSchedules()`

- [ ] **Step 9.4：验证**
`npx vue-tsc --noEmit` 通过。

---

## Task 10：SettingsView 接入

**Files:**
- Modify: `src/views/SettingsView.vue`

- [ ] **Step 10.1：sections 数组加项**

在 `sections`（约 34 行）加：
```ts
{ id: "schedule", icon: IconCalendar, label: "清单生成计划" },
```
顶部 icon import 加 `IconCalendar`。

- [ ] **Step 10.2：section 渲染**

在右侧 content 区（`v-if="activeSection === 'templates'"` 旁）加：
```vue
<div v-if="activeSection === 'schedule'" class="settings-section">
  <ListScheduleSection />
</div>
```
import `ListScheduleSection`。

- [ ] **Step 10.3：验证**
`npx vue-tsc --noEmit` 通过。

---

## Task 11：启动加载 + 联调验证

**Files:**
- Modify: `src/App.vue` 或 `src/main.ts`（看 templateStore.loadTemplates 在哪）

- [ ] **Step 11.1：启动加载**

找到现有 `templateStore.loadTemplates()` 调用处，旁边加 `listScheduleStore.loadSchedules()`。

- [ ] **Step 11.2：联调验证**（`bash scripts/dev.sh`）

测试清单：
- [ ] 设置页出现「清单生成计划」section，能新建/编辑/删除/启停计划
- [ ] 新建计划1：name=月目录，path=`工作/日志/{{YYYY}}/{{YYYY-MM}}`，freq=monthly，颜色自选
- [ ] 新建计划2：name=日清单，path=`工作/日志/{{YYYY}}/{{YYYY-MM}}/{{YYYY-MM-DD}}`，freq=workday
- [ ] 点「立即运行」或等 1 分钟，侧边栏出现 `工作/日志/2026/2026-07/2026-07-30` 清单（今天）
- [ ] 把日期改到周末（或临时建个 daily 计划验证），工作日计划不在周末生成
- [ ] 节假日数据启动后缓存到 holidays 表（devtools 查询或观察日志）
- [ ] 关闭重启应用，清单不重复生成（幂等）

- [ ] **Step 11.3：代码规范检查**
- `cd src-tauri && cargo fmt && cargo clippy`（Rust 文件均 < 400 行）
- `npx vue-tsc --noEmit`
- 前端新文件均 < 300 行；单层目录文件数 ≤ 8

---

## 实施顺序与依赖

```
Task 1 (依赖+表) → Task 2 (模型) → Task 3 (生成) → Task 4 (节假日)
                                                       ↓
Task 5 (调度+CRUD) → Task 6 (lib.rs 接线)  ← Rust 侧完成，cargo check 通过
                          ↓
Task 7 (前端类型/api) → Task 8 (store) → Task 9 (UI 组件) → Task 10 (SettingsView) → Task 11 (联调)
```

Rust 侧（Task 1-6）应能独立 `cargo check` 通过后再动前端。前端 Task 7-11 依赖 Rust 命令签名稳定。

---

## 风险点与应对

1. **`commands::uuid()` / `commands::now()` 可见性**：generate.rs 需复用，若非 pub 需改为 pub（grep 确认）。应对：Task 3 实施时先 grep。
2. **sqlx query_as 与 FromRow**：手动元组解构 vs derive FromRow 两种风格，holiday.rs 已用元组，mod.rs 保持一致。
3. **reqwest 引入增大编译产物**：rustls-tls 已避开 OpenSSL；若编译时间明显增加可接受（一次性）。
4. **节假日接口偶发不可用**：已设计降级 + 通知，不阻塞功能。
5. **SQLite 占位符 `$1` vs `?`**：list_create 用 `$1`，但 sqlx 对 SQLite 支持两种，实施时统一（以 cargo check 为准）。
