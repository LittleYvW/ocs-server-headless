// Derived from Miaozeqiu/ZError @ 9a05051355c0627c5928175bc73a9afb5aada7b0 (MIT).
// Copyright (c) 2024 ZError. See ../LICENSE and UPSTREAM.md.
use regex::Regex;
use std::collections::HashMap;

#[derive(Debug, Clone, Copy)]
enum QuestionKind {
    Single,
    Multiple,
    Judgement,
    Completion,
}

impl QuestionKind {
    fn chinese_name(&self) -> &'static str {
        match self {
            QuestionKind::Single => "单选",
            QuestionKind::Multiple => "多选",
            QuestionKind::Judgement => "判断",
            QuestionKind::Completion => "填空",
        }
    }

    fn prompt_hint(&self) -> &'static str {
        match self {
            QuestionKind::Single => {
                "这是单选题，只有一个正确答案。answer 只能写正确选项的完整文字（与【选项】原文一致），禁止写 A/B/C/D，也禁止写成「B. 传动角」这种带字母前缀的形式，应直接写「传动角」。"
            }
            QuestionKind::Multiple => {
                "这是多选题，可能有多个正确答案。answer 只写各正确选项的完整文字，用 ### 连接（顺序不限）。禁止写 ABD，禁止写「A. xxx###C. yyy」这种带字母前缀的形式。"
            }
            QuestionKind::Judgement => {
                "这是判断题。answer 只能是「正确」或「错误」二字之一。禁止写 A/B，禁止写「A. 正确」。"
            }
            QuestionKind::Completion => {
                "这是填空题。answer 只填空白处应填的内容本身；若有多个空，用 ### 连接。不要加第1空/①/A. 等序号前缀。"
            }
        }
    }

    /// 题型对应的典型对答示例（写入 prompt；前端也会以多轮对话注入）
    fn few_shot_block(&self) -> &'static str {
        match self {
            QuestionKind::Single => {
                "【作答示例】\n\
题目：凸轮机构中从动件运动规律取决于（ ）。\n\
选项：A. 压力角  B. 传动角  C. 极力夹角\n\
正确输出：{\"answer\": \"传动角\"}\n\
错误输出：{\"answer\": \"B. 传动角\"} 或 {\"answer\": \"B\"}\n"
            }
            QuestionKind::Multiple => {
                "【作答示例】\n\
题目：下列属于输入设备的有（ ）。\n\
选项：A. 键盘  B. 显示器  C. 鼠标  D. 打印机\n\
正确输出：{\"answer\": \"键盘###鼠标\"}\n\
错误输出：{\"answer\": \"AC\"} 或 {\"answer\": \"A. 键盘###C. 鼠标\"}\n"
            }
            QuestionKind::Judgement => {
                "【作答示例】\n\
题目：地球绕太阳公转一周约为 365 天。\n\
正确输出：{\"answer\": \"正确\"}\n\
错误输出：{\"answer\": \"A\"} 或 {\"answer\": \"A. 正确\"}\n"
            }
            QuestionKind::Completion => {
                "【作答示例】\n\
题目：中国的首都是____，最大的城市是____。\n\
正确输出：{\"answer\": \"北京###上海\"}\n\
错误输出：{\"answer\": \"第1空：北京###第2空：上海\"}\n"
            }
        }
    }
}

fn detect_question_kind(query_type: &str) -> Option<QuestionKind> {
    let trimmed = query_type.trim();
    if trimmed.is_empty() {
        return None;
    }

    let normalized = trimmed.to_lowercase();

    if normalized.contains("single") || trimmed.contains("单选") || trimmed.contains("单项选择")
    {
        Some(QuestionKind::Single)
    } else if normalized.contains("multiple")
        || trimmed.contains("多选")
        || trimmed.contains("多项选择")
    {
        Some(QuestionKind::Multiple)
    } else if normalized.contains("judgement")
        || normalized.contains("judgment")
        || trimmed.contains("判断")
    {
        Some(QuestionKind::Judgement)
    } else if normalized.contains("completion") || trimmed.contains("填空") {
        Some(QuestionKind::Completion)
    } else {
        None
    }
}

pub fn build_model_query_prompt(
    title: &str,
    options: Option<&str>,
    query_type: Option<&str>,
) -> String {
    let mut q = String::from("你是一个专业的答题助手。请按以下要求作答：\n");

    q.push_str("1. 先在内部完成审题与推理（可简要），再给出最终答案。\n");
    q.push_str("2. 最后一行输出**唯一**一个 JSON 对象，不要用 markdown 代码块包裹，JSON 前后不要附加说明。\n");
    q.push_str("3. JSON 格式严格为：{\"answer\": \"最终答案\"}\n");
    q.push_str("4. answer 只写答案正文本身：选择题必须与【选项】中去掉「A.」「B.」后的文字完全一致；判断题只写「正确」或「错误」；填空题只写填空内容。\n");
    q.push_str("5. 严禁把选项字母写进 answer：不要写 A/B/C/D，不要写「B. 传动角」「D. meeting」，应直接写「传动角」「meeting」。不要把分析过程写进 answer。\n\n");

    if let Some(raw_type) = query_type.map(str::trim).filter(|value| !value.is_empty()) {
        if let Some(kind) = detect_question_kind(raw_type) {
            q.push_str(&format!("【题目类型：{}题】\n", kind.chinese_name()));
            q.push_str(&format!("提示：{}\n", kind.prompt_hint()));
            q.push_str(kind.few_shot_block());
            q.push('\n');
        } else {
            q.push_str(&format!("【题目类型字段：{}】\n", raw_type));
        }
    }

    q.push_str(&format!("【题目】\n{}\n", title));

    if let Some(options) = options.map(str::trim).filter(|value| !value.is_empty()) {
        q.push_str(&format!("【选项】\n{}\n", options));
    }

    q.push_str("\n请作答，并在最后输出答案 JSON：");

    q
}

fn parse_option_letter_map(options: Option<&str>) -> HashMap<char, String> {
    let mut map = HashMap::new();
    let Some(options) = options.map(str::trim).filter(|s| !s.is_empty()) else {
        return map;
    };
    let Ok(re) = Regex::new(r"^([A-Za-z])([\.、．\)])\s*(.+)$") else {
        return map;
    };
    for raw in options.replace("\r\n", "\n").lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if let Some(caps) = re.captures(line) {
            let letter = caps
                .get(1)
                .and_then(|m| m.as_str().chars().next())
                .map(|c| c.to_ascii_uppercase());
            let sep = caps.get(2).map(|m| m.as_str()).unwrap_or("");
            let text = caps.get(3).map(|m| m.as_str().trim()).unwrap_or("");
            // 避免把正文「C、H、O、N…」误当成选项标号行
            if sep == "、"
                && text
                    .chars()
                    .next()
                    .map(|c| c.is_ascii_alphabetic())
                    .unwrap_or(false)
                && text.chars().nth(1) == Some('、')
            {
                continue;
            }
            if let (Some(letter), true) = (letter, !text.is_empty()) {
                map.insert(letter, text.to_string());
            }
        }
    }
    map
}

/// 去掉行首选项字母前缀：`B. 传动角` → `传动角`
/// 有选项表时，仅当去前缀后能对应到某选项正文才剥离。
fn strip_leading_option_label(text: &str, map: &HashMap<char, String>) -> String {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    let patterns: [(&str, bool); 2] = [
        (r"^([A-Za-z])([\.、．\)])\s+(.+)$", false),
        (r"^([A-Za-z])([\.、．\)])(.+)$", true),
    ];

    for (pat, tight) in patterns {
        let Ok(re) = Regex::new(pat) else {
            continue;
        };
        let Some(caps) = re.captures(trimmed) else {
            continue;
        };
        let Some(letter) = caps
            .get(1)
            .and_then(|m| m.as_str().chars().next())
            .map(|c| c.to_ascii_uppercase())
        else {
            continue;
        };
        let sep = caps.get(2).map(|m| m.as_str()).unwrap_or("");
        let rest = caps.get(3).map(|m| m.as_str().trim()).unwrap_or("");
        if rest.is_empty() {
            continue;
        }
        // 无空格且剩余全是字母：留给纯字母映射
        if tight && rest.chars().all(|c| c.is_ascii_alphabetic()) && rest.len() <= 8 {
            continue;
        }
        if map.is_empty() {
            if sep == "、" {
                continue;
            }
            return rest.to_string();
        }
        if map.get(&letter).map(|s| s.as_str()) == Some(rest) {
            return rest.to_string();
        }
        if map.values().any(|v| v == rest) {
            return rest.to_string();
        }
    }
    trimmed.to_string()
}

/// 将模型/题库答案规范为选项正文（去字母前缀，纯字母映射）
pub fn normalize_answer_against_options(answer: &str, options: Option<&str>) -> String {
    let raw = answer.trim();
    if raw.is_empty() {
        return String::new();
    }

    let map = parse_option_letter_map(options);
    let parts: Vec<&str> = if raw.contains("###") {
        raw.split("###").collect()
    } else {
        vec![raw]
    };

    let mut normalized: Vec<String> = Vec::new();
    for part in parts {
        let mut p = strip_leading_option_label(part.trim(), &map);
        if p.is_empty() {
            continue;
        }

        let compact: String = p.chars().filter(|c| !c.is_whitespace()).collect();
        if !map.is_empty()
            && !compact.is_empty()
            && compact.chars().all(|c| c.is_ascii_alphabetic())
            && compact.len() <= 8
        {
            let letters: Vec<char> = compact.chars().map(|c| c.to_ascii_uppercase()).collect();
            let texts: Vec<String> = letters
                .iter()
                .filter_map(|ch| map.get(ch).cloned())
                .collect();
            if texts.len() == letters.len() && !texts.is_empty() {
                p = texts.join("###");
            }
        }
        normalized.push(p);
    }

    if normalized.len() == 1 && normalized[0].contains("###") && !raw.contains("###") {
        return normalized[0].clone();
    }
    normalized.join("###")
}

#[cfg(test)]
mod tests {
    use super::normalize_answer_against_options;
    #[test]
    fn maps_multiple_choice_letters_and_judgement_labels_to_option_text() {
        assert_eq!(
            normalize_answer_against_options("AC", Some("A. 键盘\nB. 显示器\nC. 鼠标")),
            "键盘###鼠标"
        );
        assert_eq!(
            normalize_answer_against_options("A. 正确", Some("A. 正确\nB. 错误")),
            "正确"
        );
    }
}
