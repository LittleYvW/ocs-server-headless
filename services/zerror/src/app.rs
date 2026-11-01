use crate::{
    answers,
    database::{hash, Database, QuestionInput},
    matching::QuestionMatch,
    provider,
    secrets::SettingsFile,
    types::{Error, QueryData, QueryRequest, Settings},
};
use futures_util::{
    future::{BoxFuture, Shared},
    FutureExt,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    path::Path,
    sync::Arc,
    time::Duration,
};
use subtle::ConstantTimeEq;
use tokio::{
    sync::{Mutex, OwnedSemaphorePermit, RwLock, Semaphore},
    time::Instant,
};

type QueryJob = Shared<BoxFuture<'static, Result<QueryData, Error>>>;
struct Bucket {
    starts: VecDeque<Instant>,
    slots: Arc<Semaphore>,
}
pub struct App {
    pub db: Database,
    pub settings: RwLock<Settings>,
    settings_file: SettingsFile,
    admin_hash: String,
    client: reqwest::Client,
    slots: Arc<Semaphore>,
    database_slots: Arc<Semaphore>,
    max_concurrent: usize,
    clients: Mutex<HashMap<String, Bucket>>,
    jobs: Mutex<HashMap<String, QueryJob>>,
}

impl App {
    pub fn open(
        dir: &Path,
        admin_token: &str,
        max_concurrent: usize,
    ) -> Result<Arc<Self>, Box<dyn std::error::Error>> {
        let (settings_file, settings) = SettingsFile::open(dir)?;
        let db = Database::open(dir)
            .map_err(|_| std::io::Error::other("Question bank initialization failed"))?;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .build()?;
        Ok(Arc::new(Self {
            db,
            settings: RwLock::new(settings),
            settings_file,
            admin_hash: hash(admin_token),
            client,
            slots: Arc::new(Semaphore::new(max_concurrent)),
            database_slots: Arc::new(Semaphore::new(16)),
            max_concurrent,
            clients: Mutex::new(HashMap::new()),
            jobs: Mutex::new(HashMap::new()),
        }))
    }
    pub fn is_admin(&self, token: &str) -> bool {
        bool::from(self.admin_hash.as_bytes().ct_eq(hash(token).as_bytes()))
    }
    pub async fn blocking<T: Send + 'static>(
        &self,
        run: impl FnOnce(Database) -> Result<T, Error> + Send + 'static,
    ) -> Result<T, Error> {
        let db = self.db.clone();
        let permit = self
            .database_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::new(503, "STORAGE_BUSY", "Question bank storage is busy"))?;
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            run(db)
        })
        .await
        .map_err(|_| Error::internal())?
    }
    async fn admit(&self, id: &str) -> Result<(OwnedSemaphorePermit, OwnedSemaphorePermit), Error> {
        let busy = || {
            Error::new(
                429,
                "QUERY_LIMIT",
                "Query rate or concurrency limit reached",
            )
        };
        let mut clients = self.clients.lock().await;
        clients.retain(|_, b| {
            b.slots.available_permits() != 2
                || b.starts
                    .back()
                    .is_some_and(|last| last.elapsed() < Duration::from_secs(60))
        });
        let bucket = clients.entry(id.to_string()).or_insert_with(|| Bucket {
            starts: VecDeque::new(),
            slots: Arc::new(Semaphore::new(2)),
        });
        while bucket
            .starts
            .front()
            .is_some_and(|t| t.elapsed() >= Duration::from_secs(60))
        {
            bucket.starts.pop_front();
        }
        if bucket.starts.len() >= 60 {
            return Err(busy());
        }
        let local = bucket
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| busy())?;
        let global = self.slots.clone().try_acquire_owned().map_err(|_| busy())?;
        bucket.starts.push_back(Instant::now());
        Ok((local, global))
    }
    pub async fn query(
        self: &Arc<Self>,
        token: &str,
        request: QueryRequest,
    ) -> Result<QueryData, Error> {
        request.validate()?;
        let token = token.to_string();
        let id = self.blocking(move |db| db.authenticate(&token)).await?;
        let settings = self.settings.read().await.clone();
        if !settings.enabled {
            return Err(Error::new(
                503,
                "SERVICE_PAUSED",
                "Question bank queries are paused",
            ));
        }
        let mut permits = Some(self.admit(&id).await?);
        let key =
            hash(&serde_json::to_string(&(&request, &settings)).map_err(|_| Error::internal())?);
        let mut jobs = self.jobs.lock().await;
        let job = if let Some(job) = jobs.get(&key) {
            job.clone()
        } else {
            let app = self.clone();
            let job = async move {
                let deadline = Instant::now() + Duration::from_secs(settings.timeout_seconds);
                tokio::time::timeout_at(deadline, app.resolve(request, settings, deadline))
                    .await
                    .unwrap_or_else(|_| Err(provider::timeout()))
            }
            .boxed()
            .shared();
            jobs.insert(key.clone(), job.clone());
            let driver = job.clone();
            let app = self.clone();
            let key = key.clone();
            let owned_permits = permits.take();
            tokio::spawn(async move {
                // Keep admission permits until the bounded job finishes, even after a disconnect.
                let _permits = owned_permits;
                let _ = driver.await;
                app.jobs.lock().await.remove(&key);
            });
            job
        };
        drop(jobs);
        let started = Instant::now();
        let result = job.await;
        let log_id = uuid::Uuid::new_v4().to_string();
        let status = result.as_ref().map(|_| 200).unwrap_or_else(|e| e.status);
        let source = result
            .as_ref()
            .map(|d| if d.is_ai { "ai-or-cache" } else { "local" })
            .unwrap_or("error");
        let error = result.as_ref().err().map(|e| e.code);
        let duration = started.elapsed().as_millis() as u64;
        // Logging failure never changes a successfully produced answer. No bodies, keys or headers are logged.
        if self
            .blocking(move |db| db.log(&log_id, &id, status, duration, source, error))
            .await
            .is_err()
        {
            eprintln!("Question bank metadata log write failed");
        }
        result
    }
    pub async fn close(&self) {
        let jobs: Vec<_> = self.jobs.lock().await.values().cloned().collect();
        futures_util::future::join_all(jobs).await;
    }
    async fn resolve(
        &self,
        request: QueryRequest,
        settings: Settings,
        deadline: Instant,
    ) -> Result<QueryData, Error> {
        let request_clone = request.clone();
        let scan_deadline =
            std::time::Instant::now() + deadline.saturating_duration_since(Instant::now());
        let (exact, candidates) = self
            .blocking(move |db| db.matches(&request_clone, scan_deadline))
            .await?;
        if let Some(mut matched) = exact {
            matched.answer = answers::normalize_answer_against_options(
                &matched.answer,
                request.options.as_deref(),
            );
            return Ok(matched.into());
        }
        if !settings.ai_enabled {
            return Err(Error::new(
                404,
                "NO_MATCH",
                "No matching question was found and AI fallback is disabled",
            ));
        }
        if request.title.contains("<img")
            || request.title.contains("data:image/")
            || request
                .options
                .as_deref()
                .is_some_and(|s| s.contains("<img") || s.contains("data:image/"))
        {
            return Err(Error::new(
                422,
                "TEXT_ONLY",
                "This service currently accepts text questions only",
            ));
        }
        if settings.same_question_check && !candidates.is_empty() {
            let items: Vec<Value> = candidates
                .iter()
                .map(|c| json!({"id":c.id,"question":c.question,"options":c.options}))
                .collect();
            let prompt=format!("判断题目及选项是否与候选中的某一题语义完全一致。不同实体或不同条件不是同题。只输出 JSON：{{\"same\":true,\"matched_id\":候选ID}} 或 {{\"same\":false}}。数据：{}",json!({"title":request.title,"options":request.options,"candidates":items}));
            let judge_deadline = (Instant::now() + Duration::from_secs(10)).min(deadline);
            if let Ok(text) =
                provider::generate(&self.client, &settings.model, &prompt, judge_deadline, 0).await
            {
                if let Some(value) = provider::parse_object(&text) {
                    if value["same"] == true {
                        if let Some(matched) = candidates
                            .into_iter()
                            .find(|c| Some(c.id) == value["matched_id"].as_i64())
                        {
                            let answer = answers::normalize_answer_against_options(
                                &matched.answer,
                                request.options.as_deref(),
                            );
                            return self
                                .finish(
                                    request,
                                    answer,
                                    matched.is_ai,
                                    settings.auto_cache,
                                    Some(matched),
                                )
                                .await;
                        }
                    }
                }
            }
        }
        let prompt = answers::build_model_query_prompt(
            &request.title,
            request.options.as_deref(),
            request.query_type.as_deref(),
        );
        let text = provider::generate(
            &self.client,
            &settings.model,
            &prompt,
            deadline,
            settings.retry_count,
        )
        .await?;
        let answer = answers::normalize_answer_against_options(
            &provider::answer(&text)?,
            request.options.as_deref(),
        );
        self.finish(request, answer, true, settings.auto_cache, None)
            .await
    }
    async fn finish(
        &self,
        request: QueryRequest,
        answer: String,
        is_ai: bool,
        cache: bool,
        matched: Option<QuestionMatch>,
    ) -> Result<QueryData, Error> {
        if answer.trim().is_empty() {
            return Err(Error::new(
                502,
                "EMPTY_ANSWER",
                "Model did not produce an answer",
            ));
        }
        let id = if cache {
            let req = request.clone();
            let ans = answer.clone();
            self.blocking(move |db| db.cache(&req, &ans, is_ai)).await?
        } else {
            matched.map(|m| m.id).unwrap_or(0)
        };
        Ok(QueryData {
            id,
            question: request.title,
            answer,
            is_ai,
            is_pending_correction: false,
        })
    }
    pub async fn admin(
        self: &Arc<Self>,
        method: &str,
        path: &str,
        query: &str,
        body: Value,
    ) -> Result<Value, Error> {
        let parts: Vec<_> = path.trim_matches('/').split('/').collect();
        let id = || {
            parts
                .get(2)
                .ok_or_else(Error::invalid)?
                .parse::<i64>()
                .map_err(|_| Error::invalid())
        };
        match (method, parts.as_slice()) {
            ("GET", ["admin", "status"]) => {
                let stats = self.blocking(|db| db.status()).await?;
                let settings = self.settings.read().await;
                Ok(
                    json!({"service":"zerror-headless","version":env!("CARGO_PKG_VERSION"),"enabled":settings.enabled,"aiEnabled":settings.ai_enabled,"stats":stats,"limits":{"maxConcurrent":self.max_concurrent,"perTokenConcurrent":2,"perTokenPerMinute":60,"timeoutSeconds":settings.timeout_seconds},"capabilities":["text-query","local-bank","ai-fallback","same-question-check","query-tokens","questions","folders","metadata-logs"]}),
                )
            }
            ("GET", ["admin", "settings"]) => Ok(self.settings.read().await.redacted()),
            ("PATCH", ["admin", "settings"]) => {
                let patch = body.as_object().ok_or_else(Error::invalid)?;
                let mut settings = self.settings.write().await;
                let mut value = serde_json::to_value(&*settings).map_err(|_| Error::internal())?;
                for (key, item) in patch {
                    if key == "model" {
                        for (k, v) in item.as_object().ok_or_else(Error::invalid)? {
                            if k == "apiKey" && v == "***" {
                                continue;
                            }
                            value["model"][k] = v.clone();
                        }
                    } else {
                        value[key] = item.clone();
                    }
                }
                let next: Settings = serde_json::from_value(value).map_err(|_| Error::invalid())?;
                next.validate()?;
                self.settings_file.save(&next)?;
                *settings = next;
                Ok(settings.redacted())
            }
            ("GET", ["admin", "tokens"]) => self.blocking(|db| db.tokens()).await,
            ("POST", ["admin", "tokens"]) => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Input {
                    name: String,
                }
                let input: Input = serde_json::from_value(body).map_err(|_| Error::invalid())?;
                self.blocking(move |db| db.create_token(&input.name)).await
            }
            ("DELETE", ["admin", "tokens", token_id]) => {
                let token_id = token_id.to_string();
                self.blocking(move |db| db.delete_token(&token_id)).await?;
                Ok(json!(null))
            }
            ("GET", ["admin", "questions"]) => {
                #[derive(Deserialize)]
                #[serde(default, rename_all = "camelCase", deny_unknown_fields)]
                struct Page {
                    page: u32,
                    limit: u32,
                    folder_id: Option<i64>,
                    q: String,
                }
                impl Default for Page {
                    fn default() -> Self {
                        Self {
                            page: 1,
                            limit: 20,
                            folder_id: None,
                            q: String::new(),
                        }
                    }
                }
                let page: Page = serde_urlencoded::from_str(query).map_err(|_| Error::invalid())?;
                self.blocking(move |db| {
                    db.questions(page.page, page.limit, page.folder_id, &page.q)
                })
                .await
            }
            ("GET", ["admin", "questions", _]) => {
                let id = id()?;
                self.blocking(move |db| db.question(id)).await
            }
            ("POST", ["admin", "questions"]) => {
                let q: QuestionInput =
                    serde_json::from_value(body).map_err(|_| Error::invalid())?;
                self.blocking(move |db| db.save_question(None, q)).await
            }
            ("PUT", ["admin", "questions", _]) => {
                let id = id()?;
                let q: QuestionInput =
                    serde_json::from_value(body).map_err(|_| Error::invalid())?;
                self.blocking(move |db| db.save_question(Some(id), q)).await
            }
            ("DELETE", ["admin", "questions", _]) => {
                let id = id()?;
                self.blocking(move |db| db.delete_question(id)).await?;
                Ok(json!(null))
            }
            ("POST", ["admin", "questions", "import"]) => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Input {
                    questions: Vec<QuestionInput>,
                }
                let input: Input = serde_json::from_value(body).map_err(|_| Error::invalid())?;
                self.blocking(move |db| db.import_questions(input.questions))
                    .await
            }
            ("GET", ["admin", "folders"]) => self.blocking(|db| db.folders()).await,
            ("POST", ["admin", "folders"]) | ("PUT", ["admin", "folders", _]) => {
                #[derive(Deserialize)]
                #[serde(rename_all = "camelCase", deny_unknown_fields)]
                struct Input {
                    name: String,
                    #[serde(default)]
                    parent_id: i64,
                }
                let input: Input = serde_json::from_value(body).map_err(|_| Error::invalid())?;
                let id = if method == "PUT" { Some(id()?) } else { None };
                self.blocking(move |db| db.save_folder(id, &input.name, input.parent_id))
                    .await
            }
            ("DELETE", ["admin", "folders", _]) => {
                let id = id()?;
                self.blocking(move |db| db.delete_folder(id)).await?;
                Ok(json!(null))
            }
            ("GET", ["admin", "logs"]) => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Input {
                    limit: Option<u32>,
                }
                let input: Input =
                    serde_urlencoded::from_str(query).map_err(|_| Error::invalid())?;
                self.blocking(move |db| db.logs(input.limit.unwrap_or(100)))
                    .await
            }
            _ => Err(Error::missing()),
        }
    }
}
