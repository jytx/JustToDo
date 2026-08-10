// 网页标题解析 —— 详情面板「解析 URL 标题」功能
// 通过 reqwest 抓取页面 HTML，提取 <title> 标签文本。
// 刻意不引入 HTML 解析依赖：title 标签内容简单，字符串提取足够（KISS）。
// 纯函数式实现：不持有全局状态，每次调用独立创建 HTTP 客户端。

use futures_util::StreamExt;

/// 单个请求的最大响应体：512KB（标题位于文档头部，此限制绰绰有余）
const MAX_BODY_BYTES: usize = 512 * 1024;

/// 抓取 URL 并解析网页标题
///
/// - 仅接受 http/https 链接（防御性校验，前端判定已过滤）
/// - 超时 8 秒；响应体超过 512KB 截断（不影响取标题）
/// - 成功返回 `<title>` 文本（去除内部标签 + 基础 HTML 实体解码 + trim）
/// - 请求失败 / 页面无标题 / 标题为空 均返回 Err，前端弹错误提示
#[tauri::command]
pub async fn fetch_url_title(url: String) -> Result<String, String> {
    let trimmed = url.trim();
    if !trimmed.starts_with("http://") && !trimmed.starts_with("https://") {
        return Err("仅支持 http/https 链接".to_string());
    }

    // 独立客户端：超时 + 完整浏览器 UA。
    // 注意：简化 UA（如 "JustToDo/2.0"）会被部分站点（如 baidu）识别为爬虫，
    // 返回无 <title> 的降级/重定向页，导致解析失败
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let resp = client
        .get(trimmed)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", e))?;
    if !resp.status().is_success() {
        return Err(format!("页面返回状态码 {}", resp.status()));
    }

    // 流式读取并截断到 MAX_BODY_BYTES，防超大页面拖垮内存
    let mut body: Vec<u8> = Vec::new();
    let mut stream = resp.bytes_stream();
    while body.len() < MAX_BODY_BYTES {
        match stream.next().await {
            Some(Ok(chunk)) => body.extend_from_slice(&chunk),
            Some(Err(e)) => return Err(format!("读取响应失败: {}", e)),
            None => break,
        }
    }

    let html = String::from_utf8_lossy(&body);
    let title = extract_title(&html).ok_or_else(|| "页面中没有找到标题".to_string())?;
    Ok(title)
}

/// 从 HTML 中提取 `<title>` 标签文本（大小写不敏感）
fn extract_title(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    // 定位 <title ...> 与 </title>（允许 title 带属性）
    let tag_start = lower.find("<title")?;
    let after_gt = lower[tag_start..].find('>')? + tag_start + 1;
    let tag_end = lower[after_gt..].find("</title>")? + after_gt;

    let raw = &html[after_gt..tag_end];
    // 去掉可能内嵌的标签（极少见，防御处理）
    let text = strip_tags(raw);
    let decoded = decode_entities(&text).trim().to_string();
    if decoded.is_empty() {
        None
    } else {
        Some(decoded)
    }
}

/// 去掉片段中的 HTML 标签（纯函数：不改入参）
fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out
}

/// 基础 HTML 实体解码（覆盖标题常见实体）
fn decode_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
}
