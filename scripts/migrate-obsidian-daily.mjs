#!/usr/bin/env node
/**
 * Obsidian Daily → JustToDo 一次性数据迁移脚本
 *
 * 背景：JustToDo 完成前，每日待办记录在 Obsidian vault 的 Daily 目录
 *      （2026-01-21 ~ 2026-08-05）。本脚本将这些日记解析后迁入
 *      JustToDo：按月/按日建清单（挂在工作清单下），checkbox 转任务，
 *      NOTE 块转备注，图片附件按「YYYYMMDD/images/」规则落盘。
 *
 * 安全设计：默认 dry-run 仅预览；--apply 时先自动备份数据库，
 *          再以事务方式只做 INSERT（不改不删任何现有行），失败回滚。
 *          Daily 原文件全程只读。重跑幂等：同清单下同标题任务跳过。
 *
 * 用法：node scripts/migrate-obsidian-daily.mjs [--apply]
 */
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// ---------- 常量配置 ----------
const DAILY_DIR = "/Users/gemini/Documents/Obsidian/Gemini/Daily";
const APP_DIR = `${process.env.HOME}/Library/Application Support/com.justtodo.app`;
const DB_PATH = `${APP_DIR}/justtodo.db`;
const ATTACH_DIR = fs.readFileSync(`${APP_DIR}/attachment_path.txt`, "utf8").trim();
const WORK_LIST_NAME = "工作";
const MONTH_COLOR = "#EF4444"; // 与现有月清单一致
const DAY_COLORS = ["#10B981", "#F59E0B", "#3B82F6", "#8B5CF6", "#EC4899", "#6B7280"];
const IMG_RE = /!\[\[([^\]|]+?)(?:\|(\d+))?\]\]/g; // Obsidian 图片引用（可带宽度）
const APPLY = process.argv.includes("--apply");
const VERBOSE = process.argv.includes("-v"); // -v：逐条打印任务明细便于人工核对

// ---------- 基础工具 ----------
const escHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const iso = (date, hm) => `${date}T${hm}:00`; // 日期 + HH:mm → 本地 ISO 时间（与库内格式一致）
const msOf = (date, hm) => new Date(iso(date, hm)).getTime();
const walk = (dir, fn) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, fn);
    else fn(p);
  }
};
/** 收集图片引用（全局正则需重置 lastIndex） */
const collectImgs = (text) => {
  const out = [];
  IMG_RE.lastIndex = 0;
  for (const m of text.matchAll(IMG_RE)) out.push({ ref: m[1].trim(), width: Number(m[2] ?? 650) });
  return out;
};

// ---------- Markdown 日记解析 ----------
/** 标题净化：剥离图片后，markdown 链接取文字、首个 URL 存 title_url，去粗体标记 */
const cleanTitle = (raw) => {
  let url = null;
  const title = raw
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, href) => { if (url === null) url = href; return text; })
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
  return { title, url };
};

/** 解析单个日记文件 → { date, items: 任务有序列表, orphan: 游离正文行, orphanImgs: 无归属图片 } */
const parseDaily = (file) => {
  const date = path.basename(file).slice(0, 10);
  const items = []; // { depth, done, title, url, noteLines: [], imgs: [] }
  const orphan = [];
  const orphanImgs = [];
  let prio = 0; // 当前优先级（⏫3 / 🔼2 / 🔽1 / 运维及其他 0）
  let fmState = 0; // frontmatter 状态：0 未遇 1 内 2 完
  let noteOwner = null; // NOTE 块归属的任务
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (line === "---") { fmState = fmState === 1 ? 2 : 1; continue; }
    if (fmState === 1) continue;
    const h = line.match(/^#{1,6}\s*(.*)$/);
    if (h) {
      noteOwner = null;
      if (h[1].includes("⏫")) prio = 3;
      else if (h[1].includes("🔼")) prio = 2;
      else if (h[1].includes("🔽")) prio = 1;
      else if (!h[1].includes("计划工作")) prio = 0; // 临时运维/其他等节
      continue;
    }
    const task = line.match(/^(\s*)- \[([ xX])\]\s?(.*)$/);
    if (task) {
      const { title, url } = cleanTitle(task[3].replace(IMG_RE, ""));
      const imgs = collectImgs(task[3]);
      items.push({ depth: task[1] ? 1 : 0, done: task[2] !== " ", title, url, prio, noteLines: [], imgs, indentSrc: task[1] });
      noteOwner = null;
      continue;
    }
    if (line.startsWith(">")) {
      const body = line.replace(/^>\s?/, "");
      if (/\[!NOTE\]/.test(body)) noteOwner = items.at(-1) ?? null; // NOTE 块归属上一条任务
      else if (noteOwner) {
        const inner = collectImgs(body);
        if (inner.length) noteOwner.imgs.push(...inner);
        else if (body.trim()) noteOwner.noteLines.push(body.trim());
      }
      continue;
    }
    const solo = line.replace(IMG_RE, "").trim();
    if (IMG_RE.test(line) && !solo) { // 整行仅图片：归属上一条任务，无归属则并入游离
      IMG_RE.lastIndex = 0;
      const owner = items.at(-1);
      if (owner) owner.imgs.push(...collectImgs(line));
      else orphanImgs.push(...collectImgs(line));
      continue;
    }
    IMG_RE.lastIndex = 0;
    if (line.trim() && !/^(【当日概览】|日期：)/.test(line)) orphan.push(line.trim()); // 游离正文
  }
  return { date, items, orphan, orphanImgs };
};

// ---------- 附件索引与复制计划 ----------
/** 递归建 Daily 文件名 → 绝对路径索引（含 assets/、同名日目录等所有位置） */
const buildAssetIndex = () => {
  const idx = new Map();
  walk(DAILY_DIR, (p) => { if (!p.endsWith(".md")) idx.set(path.basename(p), p); });
  return idx;
};

/** 图片 src 的 asset 协议地址（与 save_image 落库格式一致：全路径 URL 编码） */
const assetSrc = (abs) => `asset://localhost/${encodeURIComponent(abs)}`;

// ---------- 主流程 ----------
const db = new DatabaseSync(DB_PATH, { readOnly: !APPLY });
const listByKey = new Map(); // `${parentId}|${name}` → list row
for (const r of db.prepare("SELECT id, name, parent_id FROM lists WHERE deleted_at IS NULL").all())
  listByKey.set(`${r.parent_id ?? "null"}|${r.name}`, r);
const workRow = [...listByKey.values()].find((r) => r.name === WORK_LIST_NAME && r.parent_id === null);
if (!workRow) { console.error(`未找到工作清单「${WORK_LIST_NAME}」`); process.exit(1); }

/** 月清单获取：不存在则计划新建（position 取当月最后一天毫秒时间戳，保证月份递增排序） */
const monthList = (ym, plan) => {
  const key = `${workRow.id}|${ym}`;
  const exist = listByKey.get(key);
  if (exist) return { id: exist.id, isNew: false };
  const row = { id: randomUUID(), name: ym, color: MONTH_COLOR, archived: 1,
    position: msOf(`${ym}-28`, "23:59"), created: iso(`${ym}-01`, "09:00") };
  plan.push(row); listByKey.set(key, row);
  return { id: row.id, isNew: true };
};

const files = [];
walk(DAILY_DIR, (p) => { if (/^\d{4}-\d{2}-\d{2}_星期./.test(path.basename(p))) files.push(p); });
files.sort();
const assetIdx = buildAssetIndex();
const parsed = files.map(parseDaily).sort((a, b) => a.date.localeCompare(b.date));

// ---- 生成迁移计划：清单 / 任务 / 附件复制 ----
const newLists = []; // lists INSERT 行
const newTasks = []; // tasks INSERT 行（含渲染后的 note HTML）
const copies = [];   // 附件复制 { src, dst }
const missing = [];  // 找不到的附件
const skipped = [];  // 判重跳过的任务
const assetDst = (date, ref) => {
  const ext = path.extname(ref).toLowerCase() || ".png";
  return path.join(ATTACH_DIR, date.replaceAll("-", ""), "images", `${randomUUID()}${ext}`);
};

/** 图片引用列表 → note HTML 片段（登记复制计划；源文件缺失则文字标注） */
const imgsToHtml = (date, imgs) => imgs.map((img) => {
  const src = assetIdx.get(img.ref);
  if (src) { const dst = assetDst(date, img.ref); copies.push({ src, dst }); return `<img src="${assetSrc(dst)}" width="${img.width}">`; }
  missing.push(`${date} | ${img.ref}`);
  return `<p>[图片缺失: ${escHtml(img.ref)}]</p>`;
}).join("");

for (const { date, items, orphan, orphanImgs } of parsed) {
  const ym = date.slice(0, 7);
  const month = monthList(ym, newLists);
  const dayKey = `${month.id}|${date}`;
  let day = listByKey.get(dayKey);
  const dayNew = !day;
  if (dayNew) {
    day = { id: randomUUID(), color: DAY_COLORS[Number(date.slice(8, 10)) % DAY_COLORS.length] };
    newLists.push({ id: day.id, name: date, color: day.color, archived: 1,
      position: msOf(date, "00:00"), created: iso(date, "09:00"), parent: month.id });
    listByKey.set(dayKey, day);
  }
  // 判重：该日清单下已有任务标题（覆盖复用现有清单与重跑两种场景）
  const existTitles = new Set(
    db.prepare("SELECT title FROM tasks WHERE list_id = ? AND deleted_at IS NULL").all(day.id).map((r) => r.title));
  // 复用清单时 sort_order 需接在现有最大值之后
  const maxSort = db.prepare("SELECT COALESCE(MAX(sort_order), 0) AS m FROM tasks WHERE list_id = ?").get(day.id).m;
  let sort = Math.max(msOf(date, "09:00"), maxSort + 1);
  let lastRoot = null; // 上一条根任务（缩进行挂为其子任务）
  for (const it of items) {
    if (it.depth === 0) lastRoot = null;
    if (it.title && existTitles.has(it.title)) { skipped.push(`${date} | ${it.title}`); continue; }
    // 任务行内剥离的图片 + NOTE 归属图片，统一转 note HTML
    const noteParts = [...it.noteLines.map((t) => `<p>${escHtml(t)}</p>`), imgsToHtml(date, it.imgs)];
    const id = randomUUID();
    if (it.depth === 0) lastRoot = id;
    newTasks.push({ id, title: it.title || "(空标题)", note: noteParts.join(""), list: day.id,
      parent: it.depth === 1 ? lastRoot : null, prio: it.prio, done: it.done ? 1 : 0,
      sort: sort++, created: iso(date, "09:00"), completed: it.done ? iso(date, "23:55") : null,
      url: it.url, day: date });
  }
  // 游离正文（如「周会：…」）与无归属图片：合并为一条已完成任务，不丢内容
  if (orphan.length || orphanImgs.length) {
    const title = (orphan[0] ?? "图片记录").slice(0, 40);
    if (!existTitles.has(title)) {
      newTasks.push({ id: randomUUID(), title,
        note: [...orphan.map((t) => `<p>${escHtml(t)}</p>`), imgsToHtml(date, orphanImgs)].join(""),
        list: day.id, parent: null, prio: 0, done: 1, sort: sort++, created: iso(date, "09:00"),
        completed: iso(date, "23:55"), url: null, day: date });
    } else skipped.push(`${date} | ${title}（游离正文）`);
  }
}

// ---- 报告 ----
const newDays = newLists.filter((l) => l.parent);
console.log(`日记 ${parsed.length} 个 | 新建月清单 ${newLists.length - newDays.length} / 日清单 ${newDays.length}` +
  ` | 任务 ${newTasks.length}（已完成 ${newTasks.filter((t) => t.done).length}，判重跳过 ${skipped.length}）` +
  ` | 附件复制 ${copies.length}，缺失 ${missing.length}`);
for (const { date, items, orphan, orphanImgs } of parsed) {
  const mark = newLists.some((l) => l.name === date) ? "新建" : "复用";
  const extra = `${orphan.length || orphanImgs.length ? ` + 正文 ${orphan.length} 行/图 ${orphanImgs.length}` : ""}`;
  console.log(`  ${date} [${mark}] 任务 ${items.length}${extra}`);
  if (VERBOSE) for (const t of newTasks.filter((x) => x.day === date))
    console.log(`      ${t.done ? "[x]" : "[ ]"} P${t.prio}${t.parent ? " 子" : ""} ${t.title}` +
      `${t.url ? ` | url:${t.url.slice(0, 40)}` : ""}${t.note ? ` | note(${t.note.length}字)` : ""}`);
}
for (const s of skipped) console.log(`  [跳过] ${s}`);
for (const m of missing) console.log(`  [附件缺失] ${m}`);
for (const c of copies) console.log(`  [附件] ${path.basename(c.src)} → ${path.relative(ATTACH_DIR, c.dst)}`);
if (!APPLY) { console.log("\ndry-run 预览完成（未写库）。加 --apply 执行迁移。"); process.exit(0); }

// ---- 执行：检测应用退出 → 备份 → 复制附件 → 事务写库 ----
try {
  // 精确匹配应用本体（正式版 .app / dev 二进制 / tauri dev），避免误伤命令行里恰含路径的无关进程
  const running = execFileSync("pgrep", ["-if", "JustToDo.app|target/debug/justtodo|tauri dev"], { encoding: "utf8" }).trim();
  if (running) { console.error(`检测到 JustToDo 正在运行（${running.split("\n")}），请先退出应用再执行迁移。`); process.exit(1); }
} catch { /* pgrep 无匹配时退出码非 0，属正常 */ }

const ts = new Date().toISOString().replaceAll(/[-:T]/g, "").slice(0, 14);
fs.copyFileSync(DB_PATH, `${DB_PATH}.bak-${ts}`);
console.log(`已备份数据库 → justtodo.db.bak-${ts}`);

for (const c of copies) {
  fs.mkdirSync(path.dirname(c.dst), { recursive: true });
  fs.copyFileSync(c.src, c.dst);
}
console.log(`已复制附件 ${copies.length} 个 → ${ATTACH_DIR}`);

const wdb = db; // apply 模式下 db 连接本身可写，直接复用
const insList = wdb.prepare(`INSERT INTO lists (id,name,color,position,created_at,parent_id,is_folder,archived,kind)
  VALUES (?,?,?,?,?,?,0,?,'task')`);
const insTask = wdb.prepare(`INSERT INTO tasks (id, title, note, list_id, parent_id, priority, due_at,
  due_start_at, due_end_at, done, sort_order, created_at, updated_at, completed_at, checklist,
  attachments, kind, title_url)
  VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', 'task', ?)`);
try {
  wdb.exec("BEGIN");
  for (const l of newLists)
    insList.run(l.id, l.name, l.color, l.position, l.created, l.parent ?? workRow.id, l.archived);
  for (const t of newTasks) {
    insTask.run(t.id, t.title, t.note, t.list, t.parent, t.prio,
      `${t.created.slice(0, 10)}T00:00:00`, `${t.created.slice(0, 10)}T23:55:00`,
      t.done, t.sort, t.created, t.created, t.completed, t.url);
  }
  wdb.exec("COMMIT");
} catch (e) { wdb.exec("ROLLBACK"); console.error(`写库失败已回滚：${e.message}`); process.exit(1); }

// ---- 事后校验 ----
const chkLists = wdb.prepare("SELECT COUNT(*) AS c FROM lists WHERE id IN (" + newLists.map(() => "?").join(",") + ")").get(...newLists.map((l) => l.id)).c;
const chkTasks = wdb.prepare("SELECT COUNT(*) AS c FROM tasks WHERE id IN (" + newTasks.map(() => "?").join(",") + ")").get(...newTasks.map((t) => t.id)).c;
const chkFiles = copies.every((c) => fs.existsSync(c.dst));
console.log(`校验：清单 ${chkLists}/${newLists.length}，任务 ${chkTasks}/${newTasks.length}，附件文件全部落盘 ${chkFiles ? "OK" : "失败"}`);
console.log("迁移完成。");
