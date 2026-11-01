use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Debug, Clone)]
pub struct Error {
    pub status: u16,
    pub code: &'static str,
    pub message: &'static str,
}

impl Error {
    pub fn new(status: u16, code: &'static str, message: &'static str) -> Self {
        Self {
            status,
            code,
            message,
        }
    }
    pub fn invalid() -> Self {
        Self::new(400, "INVALID_INPUT", "Invalid request fields")
    }
    pub fn internal() -> Self {
        Self::new(
            500,
            "STORAGE_ERROR",
            "Question bank storage operation failed",
        )
    }
    pub fn missing() -> Self {
        Self::new(404, "NOT_FOUND", "Resource not found")
    }
    pub fn value(&self) -> serde_json::Value {
        json!({"code":0,"data":null,"message":self.message,"error":{"code":self.code,"message":self.message}})
    }
}

impl From<rusqlite::Error> for Error {
    fn from(_: rusqlite::Error) -> Self {
        Self::internal()
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QueryRequest {
    pub title: String,
    pub options: Option<String>,
    #[serde(rename = "type")]
    pub query_type: Option<String>,
}

impl QueryRequest {
    pub fn validate(&self) -> Result<(), Error> {
        if self.title.trim().is_empty()
            || self.title.len() > 16000
            || self.options.as_ref().is_some_and(|v| v.len() > 24000)
            || self.query_type.as_ref().is_some_and(|v| v.len() > 100)
        {
            return Err(Error::invalid());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct QueryData {
    pub id: i64,
    pub question: String,
    pub answer: String,
    pub is_ai: bool,
    pub is_pending_correction: bool,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelConfig {
    pub protocol: String,
    pub base_url: String,
    pub model_id: String,
    pub api_key: String,
}

impl Default for ModelConfig {
    fn default() -> Self {
        Self {
            protocol: "openai-chat".into(),
            base_url: String::new(),
            model_id: String::new(),
            api_key: String::new(),
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub enabled: bool,
    pub ai_enabled: bool,
    pub auto_cache: bool,
    pub same_question_check: bool,
    pub timeout_seconds: u64,
    pub retry_count: u32,
    pub model: ModelConfig,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            enabled: true,
            ai_enabled: false,
            auto_cache: true,
            same_question_check: true,
            timeout_seconds: 50,
            retry_count: 1,
            model: ModelConfig::default(),
        }
    }
}

impl Settings {
    pub fn redacted(&self) -> serde_json::Value {
        let mut value = serde_json::to_value(self).expect("settings serialize");
        if !self.model.api_key.is_empty() {
            value["model"]["apiKey"] = json!("***");
        }
        value
    }
    pub fn validate(&self) -> Result<(), Error> {
        if !(5..=55).contains(&self.timeout_seconds)
            || self.retry_count > 2
            || !["openai-chat", "openai-response"].contains(&self.model.protocol.as_str())
            || self.model.model_id.len() > 200
            || self.model.api_key.len() > 4096
            || self.model.api_key.chars().any(char::is_control)
        {
            return Err(Error::invalid());
        }
        if !self.model.base_url.is_empty() {
            let u = reqwest::Url::parse(&self.model.base_url).map_err(|_| Error::invalid())?;
            if !["http", "https"].contains(&u.scheme())
                || u.host_str().is_none()
                || !u.username().is_empty()
                || u.password().is_some()
                || u.query().is_some()
                || u.fragment().is_some()
                || self.model.base_url.len() > 2000
            {
                return Err(Error::invalid());
            }
        }
        if self.ai_enabled
            && (self.model.base_url.is_empty() || self.model.model_id.trim().is_empty())
        {
            return Err(Error::new(
                400,
                "MODEL_NOT_CONFIGURED",
                "Configure the model URL and ID before enabling AI",
            ));
        }
        Ok(())
    }
}
