// Derived from Miaozeqiu/ZError @ 9a05051355c0627c5928175bc73a9afb5aada7b0 (MIT).
// Copyright (c) 2024 ZError. See ../LICENSE and UPSTREAM.md.
use jieba_rs::Jieba;
use regex::Regex;
use serde::Serialize;
use std::collections::HashSet;
use std::sync::OnceLock;
use strsim::normalized_levenshtein;

/// 提取字符串中所有 URL（http/https），返回排序后的列表
fn extract_urls(text: &str) -> Vec<String> {
    // 匹配 http(s):// 开头，到空白字符或常见中文标点结束
    let re = Regex::new(r"https?://[^\s]+").unwrap();
    let mut urls: Vec<String> = re
        .find_iter(text)
        .map(|m| {
            // 去掉末尾可能粘连的中文标点（句号、逗号等 UTF-8 多字节字符不在 \s 范围内）
            let s = m.as_str().trim_end_matches(|c: char| {
                matches!(
                    c,
                    '，' | '。' | '！' | '？' | '、' | '；' | '：' | '\u{300c}'
                        ..='\u{300f}' | '（' | '）' | '【' | '】'
                )
            });
            s.to_string()
        })
        .collect();
    urls.sort();
    urls
}

/// 将字符串中所有 URL 替换为统一占位符，用于相似度比较
fn normalize_urls(text: &str) -> String {
    let re = Regex::new(r"https?://[^\s]+").unwrap();
    // 先替换，再去掉占位符末尾可能残留的中文标点（不影响相似度计算）
    re.replace_all(text, "__URL__").to_string()
}

static JIEBA: OnceLock<Jieba> = OnceLock::new();

const QUERY_STOPWORDS: &[&str] = &[
    "的",
    "地",
    "得",
    "了",
    "着",
    "吗",
    "呢",
    "啊",
    "呀",
    "吧",
    "么",
    "嘛",
    "在",
    "是",
    "和",
    "与",
    "及",
    "或",
    "并",
    "且",
    "将",
    "把",
    "被",
    "由",
    "对",
    "于",
    "中",
    "上",
    "下",
    "请问",
    "哪里",
    "哪儿",
    "哪个",
    "哪种",
    "哪项",
    "哪些",
    "什么",
    "怎么",
    "怎样",
    "如何",
    "为何",
    "为什么",
    "多少",
    "几",
    "一下",
    "以下",
    "下列",
    "题目",
    "选项",
    "答案",
    "内容",
    "说法",
    "图片",
    "图中",
    "名字",
    "名称",
    "城市",
    "国家",
    "地区",
    "地方",
];

const QUESTION_AND_OPTIONS_MATCH_KEYWORDS: &[&str] = &["以下", "下列", "下面", "下叙"];

pub fn should_require_option_match(title: &str) -> bool {
    QUESTION_AND_OPTIONS_MATCH_KEYWORDS
        .iter()
        .any(|keyword| title.contains(keyword))
}

fn normalize_optional_query_text(text: Option<&str>) -> Option<String> {
    text.map(str::trim)
        .filter(|text| !text.is_empty())
        .map(|text| text.to_string())
}

fn is_punctuation_or_space(c: char) -> bool {
    c.is_whitespace()
        || c.is_ascii_punctuation()
        || matches!(
            c,
            '，' | '。'
                | '！'
                | '？'
                | '、'
                | '；'
                | '：'
                | '（'
                | '）'
                | '【'
                | '】'
                | '《'
                | '》'
                | '“'
                | '”'
                | '‘'
                | '’'
                | '—'
                | '…'
                | '·'
        )
}

fn is_meaningful_query_token(token: &str) -> bool {
    let trimmed = token.trim();
    if trimmed.is_empty() || QUERY_STOPWORDS.contains(&trimmed) {
        return false;
    }
    if trimmed.chars().all(is_punctuation_or_space) {
        return false;
    }

    let char_count = trimmed.chars().count();
    if trimmed.chars().all(|c| c.is_ascii_digit()) {
        return true;
    }
    if trimmed.chars().all(|c| c.is_ascii_alphabetic()) {
        return char_count > 1;
    }

    char_count > 1
}

fn extract_query_keywords(text: &str) -> HashSet<String> {
    let jieba = JIEBA.get_or_init(Jieba::new);
    let mut keywords: Vec<String> = jieba
        .cut_for_search(text, false)
        .into_iter()
        .map(|token| token.trim().to_lowercase())
        .filter(|token| is_meaningful_query_token(token))
        .collect();

    keywords.sort_by(|a, b| {
        b.chars()
            .count()
            .cmp(&a.chars().count())
            .then_with(|| a.cmp(b))
    });

    keywords.into_iter().collect()
}

fn keyword_coverage(query_keywords: &HashSet<String>, candidate_keywords: &HashSet<String>) -> f64 {
    if query_keywords.is_empty() {
        return 1.0;
    }

    let matched = query_keywords
        .iter()
        .filter(|token| candidate_keywords.contains(*token))
        .count();

    matched as f64 / query_keywords.len() as f64
}

fn min_keyword_coverage(query_keywords_len: usize, char_similarity: f64) -> f64 {
    if query_keywords_len <= 2 {
        return 1.0;
    }

    // 高字符相似但关键词数量不多时，要求所有关键词都命中，
    // 避免“题干几乎一致但核心词不同”的题目误匹配。
    if char_similarity >= 0.88 && query_keywords_len <= 8 {
        return 1.0;
    }

    if query_keywords_len <= 4 {
        return 1.0;
    }

    if query_keywords_len <= 8 {
        return 0.9;
    }

    0.75
}

fn compute_query_match_score(query: &str, candidate: &str) -> Option<f64> {
    let normalized_query = normalize_urls(query).trim().to_lowercase();
    let normalized_candidate = normalize_urls(candidate).trim().to_lowercase();

    if normalized_query.is_empty() || normalized_candidate.is_empty() {
        return None;
    }
    if normalized_query == normalized_candidate {
        return Some(1.0);
    }

    let char_similarity = normalized_levenshtein(&normalized_query, &normalized_candidate);
    if char_similarity < 0.72 {
        return None;
    }

    let query_keywords = extract_query_keywords(&normalized_query);
    if query_keywords.is_empty() {
        return Some(char_similarity);
    }

    let candidate_keywords = extract_query_keywords(&normalized_candidate);
    let coverage = keyword_coverage(&query_keywords, &candidate_keywords);
    let min_coverage = min_keyword_coverage(query_keywords.len(), char_similarity);
    if coverage + f64::EPSILON < min_coverage {
        return None;
    }

    Some(char_similarity * 0.7 + coverage * 0.3)
}

fn is_exact_match_score(score: f64) -> bool {
    (score - 1.0).abs() <= f64::EPSILON
}

#[derive(Debug, Clone, Serialize)]
pub struct QuestionMatch {
    pub id: i64,
    pub question: String,
    pub options: Option<String>,
    pub answer: String,
    pub is_ai: bool,
    pub is_pending_correction: bool,
    pub score: f64,
}

pub fn score_question_row(
    title: &str,
    query_options: &Option<String>,
    require_option_match: bool,
    candidate: QuestionMatch,
) -> Option<QuestionMatch> {
    let QuestionMatch {
        id,
        question,
        options: db_options,
        answer,
        is_ai,
        is_pending_correction,
        ..
    } = candidate;
    let query_urls = extract_urls(title);
    if !query_urls.is_empty() {
        let db_urls = extract_urls(&question);
        if query_urls != db_urls {
            return None;
        }
    }

    let title_similarity = compute_query_match_score(title, &question)?;

    let has_query_options = query_options.is_some();
    let option_similarity = match (
        query_options.as_deref(),
        normalize_optional_query_text(db_options.as_deref()),
    ) {
        (Some(query_options), Some(db_options)) => {
            compute_query_match_score(query_options, &db_options)
        }
        _ => None,
    };

    let is_exact_title_match = is_exact_match_score(title_similarity);
    if !is_exact_title_match
        && (require_option_match || has_query_options)
        && option_similarity.is_none()
    {
        return None;
    }

    let final_similarity = match option_similarity {
        Some(option_similarity) => title_similarity * 0.7 + option_similarity * 0.3,
        None => title_similarity,
    };

    Some(QuestionMatch {
        id,
        question,
        options: db_options,
        answer,
        is_ai,
        is_pending_correction,
        score: final_similarity,
    })
}

pub fn is_exact_question_match(
    title: &str,
    query_options: Option<&str>,
    matched: &QuestionMatch,
) -> bool {
    let Some(title_score) = compute_query_match_score(title, &matched.question) else {
        return false;
    };
    if !is_exact_match_score(title_score) {
        return false;
    }

    match normalize_optional_query_text(query_options) {
        None => true,
        Some(query_opts) => match normalize_optional_query_text(matched.options.as_deref()) {
            Some(db_opts) => compute_query_match_score(&query_opts, &db_opts)
                .map(is_exact_match_score)
                .unwrap_or(false),
            None => false,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn separates_entities() {
        assert!(compute_query_match_score("韩国的首都在哪里", "美国的首都在哪里").is_none());
    }
    #[test]
    fn accepts_wording_variant() {
        assert!(compute_query_match_score("韩国的首都在哪里", "韩国首都是哪里").is_some());
    }
    #[test]
    fn exact_options_must_match() {
        let m = QuestionMatch {
            id: 1,
            question: "下列哪项正确".into(),
            options: Some("A.1\nB.2".into()),
            answer: "1".into(),
            is_ai: false,
            is_pending_correction: false,
            score: 1.0,
        };
        assert!(!is_exact_question_match(
            "下列哪项正确",
            Some("A.2\nB.1"),
            &m
        ));
    }
}
