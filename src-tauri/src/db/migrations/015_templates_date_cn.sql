-- 015: 升级内置模板占位符 {{date}} → {{date_cn}}
-- 背景：014 用 INSERT OR IGNORE 插入内置模板后，占位符语义未实现。
-- 现在前端 utils/template.ts 支持 {{date_cn}}（中文日期格式），
-- 需把 4 个内置模板 title 里的 {{date}} 升级为 {{date_cn}}。
--
-- 注意：只动 title，不动 name/note（保留用户对内置模板内容的修改）。
-- 幂等：WHERE title LIKE '%{{date}}%' 条件保证只升级含旧占位符的记录，
-- 已升级过（无 {{date}}）的不会再被改。

UPDATE templates SET title = REPLACE(title, '{{date}}', '{{date_cn}}'), updated_at = updated_at
WHERE id IN ('tpl-meeting', 'tpl-weekly') AND title LIKE '%{{date}}%';
