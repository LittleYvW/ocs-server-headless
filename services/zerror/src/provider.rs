use crate::types::{Error, ModelConfig};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::time::Duration;
use tokio::time::Instant;

/// Only administrator-configured endpoints are used. Query requests never supply a URL or code.
pub async fn generate(
    client: &reqwest::Client,
    model: &ModelConfig,
    prompt: &str,
    deadline: Instant,
    retries: u32,
) -> Result<String, Error> {
    for attempt in 0..=retries {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining < Duration::from_millis(100) {
            return Err(timeout());
        }
        let endpoint = if model.protocol == "openai-response" {
            "responses"
        } else {
            "chat/completions"
        };
        let body = if model.protocol == "openai-response" {
            json!({"model":model.model_id,"input":prompt,"stream":false,"store":false})
        } else {
            json!({"model":model.model_id,"messages":[{"role":"user","content":prompt}],"stream":false,"store":false})
        };
        let mut req = client
            .post(format!(
                "{}/{}",
                model.base_url.trim_end_matches('/'),
                endpoint
            ))
            .json(&body)
            .timeout(remaining.min(Duration::from_secs(30)));
        if !model.api_key.is_empty() {
            req = req.bearer_auth(&model.api_key);
        }
        let result = async {
            let response = req.send().await.map_err(|e| {
                if e.is_timeout() {
                    timeout()
                } else {
                    Error::new(502, "PROVIDER_UNAVAILABLE", "Model provider is unavailable")
                }
            })?;
            let status = response.status().as_u16();
            if status != 200 {
                return Err(match status {
                    401 | 403 => Error::new(
                        502,
                        "PROVIDER_AUTH_FAILED",
                        "Model provider rejected its credentials",
                    ),
                    429 => Error::new(
                        503,
                        "PROVIDER_RATE_LIMIT",
                        "Model provider rate limit reached",
                    ),
                    _ => Error::new(502, "PROVIDER_ERROR", "Model provider rejected the request"),
                });
            }
            if response.content_length().is_some_and(|n| n > 1024 * 1024) {
                return Err(invalid_response());
            }
            let mut stream = response.bytes_stream();
            let mut bytes = Vec::new();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|_| invalid_response())?;
                if bytes.len() + chunk.len() > 1024 * 1024 {
                    return Err(invalid_response());
                }
                bytes.extend_from_slice(&chunk);
            }
            let value: Value = serde_json::from_slice(&bytes).map_err(|_| invalid_response())?;
            let text = if model.protocol == "openai-response" {
                value["output"]
                    .as_array()
                    .map(|items| {
                        items
                            .iter()
                            .filter(|item| item["type"] == "message")
                            .flat_map(|item| item["content"].as_array().into_iter().flatten())
                            .filter(|part| part["type"] == "output_text")
                            .filter_map(|part| part["text"].as_str())
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
                    .unwrap_or_default()
            } else {
                let content = &value["choices"][0]["message"]["content"];
                content.as_str().map(str::to_string).unwrap_or_else(|| {
                    content
                        .as_array()
                        .map(|parts| {
                            parts
                                .iter()
                                .filter_map(|p| p["text"].as_str())
                                .collect::<Vec<_>>()
                                .join("\n")
                        })
                        .unwrap_or_default()
                })
            };
            if text.trim().is_empty() {
                return Err(invalid_response());
            }
            Ok(text)
        }
        .await;
        match result {
            Ok(text) => return Ok(text),
            Err(e)
                if attempt < retries
                    && [
                        "PROVIDER_UNAVAILABLE",
                        "PROVIDER_TIMEOUT",
                        "PROVIDER_RATE_LIMIT",
                        "PROVIDER_ERROR",
                    ]
                    .contains(&e.code) =>
            {
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            Err(e) => return Err(e),
        }
    }
    Err(timeout())
}

pub fn timeout() -> Error {
    Error::new(
        504,
        "PROVIDER_TIMEOUT",
        "Model request exceeded the query time budget",
    )
}
fn invalid_response() -> Error {
    Error::new(
        502,
        "INVALID_MODEL_RESPONSE",
        "Model provider returned an invalid response",
    )
}

/// Require an answer field: prose, errors and reasoning are never silently cached as answers.
pub fn answer(text: &str) -> Result<String, Error> {
    let value = parse_object(text).ok_or_else(invalid_response)?;
    let answer = value["answer"]
        .as_str()
        .or_else(|| value["anwser"].as_str())
        .ok_or_else(invalid_response)?
        .trim();
    if answer.is_empty() || answer.len() > 24000 {
        return Err(invalid_response());
    }
    Ok(answer.to_string())
}
pub fn parse_object(text: &str) -> Option<Value> {
    let clean = text
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    if let Ok(value) = serde_json::from_str::<Value>(clean) {
        return value.is_object().then_some(value);
    }
    // Find a JSON object ending on the last non-whitespace character. serde handles quoted braces.
    if !clean.ends_with('}') {
        return None;
    }
    for (index, c) in clean.char_indices().rev() {
        if c == '{' {
            if let Ok(value) = serde_json::from_str::<Value>(&clean[index..]) {
                if value.is_object() {
                    return Some(value);
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn extracts_unicode_and_quoted_braces() {
        assert_eq!(
            answer("说明\n{\"answer\":\"中文{内容}\"}").unwrap(),
            "中文{内容}"
        );
    }
    #[test]
    fn rejects_reasoning_and_empty_answer() {
        assert!(answer("模型调用失败").is_err());
        assert!(answer("{\"answer\":\"\"}").is_err());
    }
}
