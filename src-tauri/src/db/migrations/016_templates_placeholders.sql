-- 016: 内置模板里的用户语义占位符 {{title}} / {{book}} 改为下划线占位
-- 背景：{{date_cn}} 这类系统能自动替换；但 {{title}}（PR 标题）/ {{book}}（书名）
-- 程序无法自动填，会让用户疑惑"为什么没替换"。改为与 note 里 ___ 一致的下划线
-- 占位风格，用户看到就知道这里要手动填。
--
-- 幂等：WHERE title LIKE 条件保证只升级含旧占位符的记录，
-- 已升级过的不动；只动 title 不动 note（保留用户对内容的修改）。

UPDATE templates SET title = REPLACE(title, '{{title}}', '_____'), updated_at = updated_at
WHERE id = 'tpl-codereview' AND title LIKE '%{{title}}%';

UPDATE templates SET title = REPLACE(title, '{{book}}', '_____'), updated_at = updated_at
WHERE id = 'tpl-reading' AND title LIKE '%{{book}}%';
