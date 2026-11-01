use crate::{
    matching::{self, QuestionMatch},
    secrets::random_token,
    types::{Error, QueryData, QueryRequest},
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
use uuid::Uuid;

pub fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

#[derive(Clone)]
pub struct Database {
    path: PathBuf,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuestionInput {
    pub question: String,
    #[serde(default)]
    pub options: Option<String>,
    pub answer: String,
    #[serde(default)]
    pub question_type: Option<String>,
    #[serde(default)]
    pub folder_id: i64,
    #[serde(default)]
    pub is_ai: bool,
    #[serde(default)]
    pub is_pending_correction: bool,
}

impl QuestionInput {
    pub fn validate(&self) -> Result<(), Error> {
        QueryRequest {
            title: self.question.clone(),
            options: self.options.clone(),
            query_type: self.question_type.clone(),
        }
        .validate()?;
        if self.answer.trim().is_empty() || self.answer.len() > 24000 || self.folder_id < 0 {
            return Err(Error::invalid());
        }
        Ok(())
    }
}

fn row_question(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(
        json!({"id":row.get::<_,i64>(0)?,"question":row.get::<_,String>(1)?,"options":row.get::<_,Option<String>>(2)?,
        "answer":row.get::<_,String>(3)?,"questionType":row.get::<_,Option<String>>(4)?,"folderId":row.get::<_,i64>(5)?,
        "isAi":row.get::<_,bool>(6)?,"isPendingCorrection":row.get::<_,bool>(7)?,"createdAt":row.get::<_,Option<String>>(8)?}),
    )
}
const QUESTION_SELECT: &str = "SELECT Id,Question,Options,Answer,QuestionType,COALESCE(FolderId,0),COALESCE(IsAi,0),COALESCE(IsPendingCorrection,0),CreateTime FROM AIResponses";

impl Database {
    pub fn open(dir: &Path) -> Result<Self, Error> {
        let path = dir.join("airesponses.db");
        crate::schema::init_database_schema(&path).map_err(|_| Error::internal())?;
        let db = Self { path };
        db.conn()?.execute_batch("PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS HeadlessTokens(Id TEXT PRIMARY KEY,Name TEXT NOT NULL,Hash TEXT UNIQUE NOT NULL,Prefix TEXT NOT NULL,CreatedAt TEXT NOT NULL,LastUsedAt TEXT);
            CREATE TABLE IF NOT EXISTS HeadlessLogs(Id TEXT PRIMARY KEY,Timestamp TEXT NOT NULL,TokenId TEXT NOT NULL,Status INTEGER NOT NULL,DurationMs INTEGER NOT NULL,Source TEXT NOT NULL,ErrorCode TEXT);")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&db.path, std::fs::Permissions::from_mode(0o600))
                .map_err(|_| Error::internal())?;
        }
        Ok(db)
    }
    fn conn(&self) -> Result<Connection, Error> {
        let conn = Connection::open(&self.path)?;
        conn.busy_timeout(Duration::from_secs(3))?;
        Ok(conn)
    }
    pub fn status(&self) -> Result<Value, Error> {
        let conn = self.conn()?;
        let questions: i64 =
            conn.query_row("SELECT COUNT(*) FROM AIResponses", [], |r| r.get(0))?;
        let tokens: i64 =
            conn.query_row("SELECT COUNT(*) FROM HeadlessTokens", [], |r| r.get(0))?;
        Ok(json!({"questions":questions,"tokens":tokens}))
    }
    pub fn authenticate(&self, token: &str) -> Result<String, Error> {
        let conn = self.conn()?;
        let id: Option<String> = conn
            .query_row(
                "SELECT Id FROM HeadlessTokens WHERE Hash=?",
                [hash(token)],
                |r| r.get(0),
            )
            .optional()?;
        let id =
            id.ok_or_else(|| Error::new(401, "UNAUTHORIZED", "A valid query token is required"))?;
        conn.execute(
            "UPDATE HeadlessTokens SET LastUsedAt=datetime('now') WHERE Id=?",
            [&id],
        )?;
        Ok(id)
    }
    pub fn create_token(&self, name: &str) -> Result<Value, Error> {
        if name.trim().is_empty() || name.len() > 100 {
            return Err(Error::invalid());
        }
        let mut connection = self.conn()?;
        let conn =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM HeadlessTokens", [], |r| r.get(0))?;
        if count >= 256 {
            return Err(Error::new(409, "TOKEN_LIMIT", "Query token limit reached"));
        }
        let id = Uuid::new_v4().to_string();
        let token = random_token();
        conn.execute("INSERT INTO HeadlessTokens(Id,Name,Hash,Prefix,CreatedAt) VALUES(?,?,?,?,datetime('now'))", params![id,name.trim(),hash(&token),&token[..12]])?;
        conn.commit()?;
        Ok(json!({"id":id,"name":name.trim(),"prefix":&token[..12],"token":token}))
    }
    pub fn tokens(&self) -> Result<Value, Error> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            "SELECT Id,Name,Prefix,CreatedAt,LastUsedAt FROM HeadlessTokens ORDER BY CreatedAt,Id",
        )?;
        let rows = stmt.query_map([], |r| Ok(json!({"id":r.get::<_,String>(0)?,"name":r.get::<_,String>(1)?,"prefix":r.get::<_,String>(2)?,"createdAt":r.get::<_,String>(3)?,"lastUsedAt":r.get::<_,Option<String>>(4)?})))?.collect::<Result<Vec<_>,_>>()?;
        Ok(json!(rows))
    }
    pub fn delete_token(&self, id: &str) -> Result<(), Error> {
        if self
            .conn()?
            .execute("DELETE FROM HeadlessTokens WHERE Id=?", [id])?
            == 0
        {
            return Err(Error::missing());
        }
        Ok(())
    }
    pub fn matches(
        &self,
        request: &QueryRequest,
        deadline: std::time::Instant,
    ) -> Result<(Option<QuestionMatch>, Vec<QuestionMatch>), Error> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare("SELECT Id,Question,Options,Answer,COALESCE(IsAi,0),COALESCE(IsPendingCorrection,0) FROM AIResponses WHERE COALESCE(IsPendingCorrection,0)=0 AND trim(Answer)<>''")?;
        let mut rows = stmt.query([])?;
        let opts = request
            .options
            .as_ref()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let mut candidates = Vec::new();
        let mut exact = None;
        while let Some(row) = rows.next()? {
            if std::time::Instant::now() >= deadline {
                return Err(crate::provider::timeout());
            }
            let question: String = row.get(1)?;
            let options: Option<String> = row.get(2)?;
            if question.len() > 16000 || options.as_ref().is_some_and(|s| s.len() > 24000) {
                continue;
            }
            let matched = matching::score_question_row(
                &request.title,
                &opts,
                matching::should_require_option_match(&request.title),
                QuestionMatch {
                    id: row.get(0)?,
                    question,
                    options,
                    answer: row.get(3)?,
                    is_ai: row.get(4)?,
                    is_pending_correction: row.get(5)?,
                    score: 0.0,
                },
            );
            if let Some(m) = matched {
                if matching::is_exact_question_match(&request.title, opts.as_deref(), &m) {
                    if exact.as_ref().is_none_or(|v: &QuestionMatch| m.id > v.id) {
                        exact = Some(m);
                    }
                } else {
                    candidates.push(m);
                    candidates.sort_by(|a, b| b.score.total_cmp(&a.score).then(b.id.cmp(&a.id)));
                    candidates.truncate(5);
                }
            }
        }
        candidates.sort_by(|a, b| b.score.total_cmp(&a.score).then(b.id.cmp(&a.id)));
        candidates.truncate(5);
        Ok((exact, candidates))
    }
    pub fn cache(&self, request: &QueryRequest, answer: &str, is_ai: bool) -> Result<i64, Error> {
        let mut conn = self.conn()?;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let old: Option<i64> = tx.query_row("SELECT Id FROM AIResponses WHERE Question=? AND COALESCE(Options,'')=? AND COALESCE(IsPendingCorrection,0)=0 ORDER BY Id DESC LIMIT 1",params![request.title,request.options.as_deref().unwrap_or("")],|r|r.get(0)).optional()?;
        if let Some(id) = old {
            return Ok(id);
        }
        tx.execute("INSERT INTO AIResponses(Question,Options,QuestionType,Answer,FolderId,IsAi,IsPendingCorrection) VALUES(?,?,?,?,0,?,0)",params![request.title,request.options,request.query_type,answer,is_ai])?;
        let id = tx.last_insert_rowid();
        tx.commit()?;
        Ok(id)
    }
    pub fn question(&self, id: i64) -> Result<Value, Error> {
        self.conn()?
            .query_row(&format!("{QUESTION_SELECT} WHERE Id=?"), [id], row_question)
            .optional()?
            .ok_or_else(Error::missing)
    }
    pub fn questions(
        &self,
        page: u32,
        limit: u32,
        folder: Option<i64>,
        search: &str,
    ) -> Result<Value, Error> {
        if page == 0 || page > 100000 || !(1..=100).contains(&limit) || search.len() > 200 {
            return Err(Error::invalid());
        }
        let conn = self.conn()?;
        let predicate = " WHERE (?1 IS NULL OR FolderId=?1) AND (?2='' OR instr(Question,?2)>0)";
        let total: i64 = conn.query_row(
            &format!("SELECT COUNT(*) FROM AIResponses{predicate}"),
            params![folder, search],
            |r| r.get(0),
        )?;
        let mut stmt = conn.prepare(&format!(
            "{QUESTION_SELECT}{predicate} ORDER BY Id DESC LIMIT ?3 OFFSET ?4"
        ))?;
        let items = stmt
            .query_map(
                params![folder, search, limit, (page - 1) * limit],
                row_question,
            )?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(json!({"items":items,"total":total,"page":page,"limit":limit}))
    }
    fn check_folder(conn: &Connection, id: i64) -> Result<(), Error> {
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM Folders WHERE Id=?)",
            [id],
            |r| r.get(0),
        )?;
        if !exists {
            return Err(Error::new(400, "INVALID_FOLDER", "Folder does not exist"));
        }
        Ok(())
    }
    pub fn save_question(&self, id: Option<i64>, input: QuestionInput) -> Result<Value, Error> {
        input.validate()?;
        let mut connection = self.conn()?;
        let conn =
            connection.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        Self::check_folder(&conn, input.folder_id)?;
        let id = if let Some(id) = id {
            if conn.execute("UPDATE AIResponses SET Question=?,Options=?,Answer=?,QuestionType=?,FolderId=?,IsAi=?,IsPendingCorrection=? WHERE Id=?",params![input.question,input.options,input.answer,input.question_type,input.folder_id,input.is_ai,input.is_pending_correction,id])?==0 { return Err(Error::missing()); }
            id
        } else {
            conn.execute("INSERT INTO AIResponses(Question,Options,Answer,QuestionType,FolderId,IsAi,IsPendingCorrection) VALUES(?,?,?,?,?,?,?)",params![input.question,input.options,input.answer,input.question_type,input.folder_id,input.is_ai,input.is_pending_correction])?;
            conn.last_insert_rowid()
        };
        conn.commit()?;
        self.question(id)
    }
    pub fn delete_question(&self, id: i64) -> Result<(), Error> {
        if self
            .conn()?
            .execute("DELETE FROM AIResponses WHERE Id=?", [id])?
            == 0
        {
            return Err(Error::missing());
        }
        Ok(())
    }
    pub fn import_questions(&self, items: Vec<QuestionInput>) -> Result<Value, Error> {
        if items.is_empty() || items.len() > 500 {
            return Err(Error::invalid());
        }
        let mut conn = self.conn()?;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let mut inserted = 0;
        for q in &items {
            q.validate()?;
            Self::check_folder(&tx, q.folder_id)?;
            let exists:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM AIResponses WHERE Question=? AND COALESCE(Options,'')=? AND Answer=?)",params![q.question,q.options.as_deref().unwrap_or(""),q.answer],|r|r.get(0))?;
            if exists {
                continue;
            }
            tx.execute("INSERT INTO AIResponses(Question,Options,Answer,QuestionType,FolderId,IsAi,IsPendingCorrection) VALUES(?,?,?,?,?,?,?)",params![q.question,q.options,q.answer,q.question_type,q.folder_id,q.is_ai,q.is_pending_correction])?;
            inserted += 1;
        }
        tx.commit()?;
        Ok(json!({"inserted":inserted,"skipped":items.len()-inserted}))
    }
    pub fn folders(&self) -> Result<Value, Error> {
        let conn = self.conn()?;
        let mut stmt=conn.prepare("SELECT f.Id,f.Name,COALESCE(f.ParentId,0),(SELECT COUNT(*) FROM AIResponses a WHERE a.FolderId=f.Id) FROM Folders f ORDER BY f.Id")?;
        let items=stmt.query_map([],|r|Ok(json!({"id":r.get::<_,i64>(0)?,"name":r.get::<_,String>(1)?,"parentId":r.get::<_,i64>(2)?,"questionCount":r.get::<_,i64>(3)?})))?.collect::<Result<Vec<_>,_>>()?;
        Ok(json!(items))
    }
    pub fn save_folder(&self, id: Option<i64>, name: &str, parent: i64) -> Result<Value, Error> {
        if name.trim().is_empty() || name.len() > 200 || parent < 0 || id == Some(0) {
            return Err(Error::invalid());
        }
        let mut conn = self.conn()?;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        Self::check_folder(&tx, parent)?;
        if let Some(id) = id {
            let mut cursor = parent;
            let mut seen = std::collections::HashSet::new();
            loop {
                if cursor == id || !seen.insert(cursor) {
                    return Err(Error::invalid());
                }
                if cursor == 0 {
                    break;
                }
                cursor = tx.query_row(
                    "SELECT COALESCE(ParentId,0) FROM Folders WHERE Id=?",
                    [cursor],
                    |r| r.get(0),
                )?;
            }
            if tx.execute(
                "UPDATE Folders SET Name=?,ParentId=? WHERE Id=?",
                params![name.trim(), parent, id],
            )? == 0
            {
                return Err(Error::missing());
            }
            tx.commit()?;
            Ok(json!({"id":id,"name":name.trim(),"parentId":parent}))
        } else {
            tx.execute(
                "INSERT INTO Folders(Name,ParentId) VALUES(?,?)",
                params![name.trim(), parent],
            )?;
            let id = tx.last_insert_rowid();
            tx.commit()?;
            Ok(json!({"id":id,"name":name.trim(),"parentId":parent}))
        }
    }
    pub fn delete_folder(&self, id: i64) -> Result<(), Error> {
        if id == 0 {
            return Err(Error::invalid());
        }
        let mut conn = self.conn()?;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        let used:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM Folders WHERE ParentId=?) OR EXISTS(SELECT 1 FROM AIResponses WHERE FolderId=?)",params![id,id],|r|r.get(0))?;
        if used {
            return Err(Error::new(
                409,
                "FOLDER_NOT_EMPTY",
                "Move or delete the folder contents first",
            ));
        }
        if tx.execute("DELETE FROM Folders WHERE Id=?", [id])? == 0 {
            return Err(Error::missing());
        }
        tx.commit()?;
        Ok(())
    }
    pub fn log(
        &self,
        id: &str,
        token: &str,
        status: u16,
        duration: u64,
        source: &str,
        error: Option<&str>,
    ) -> Result<(), Error> {
        let mut conn = self.conn()?;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        tx.execute(
            "INSERT INTO HeadlessLogs VALUES(?,datetime('now'),?,?,?,?,?)",
            params![id, token, status, duration, source, error],
        )?;
        tx.execute("DELETE FROM HeadlessLogs WHERE rowid NOT IN(SELECT rowid FROM HeadlessLogs ORDER BY rowid DESC LIMIT 1000)",[])?;
        tx.commit()?;
        Ok(())
    }
    pub fn logs(&self, limit: u32) -> Result<Value, Error> {
        if !(1..=200).contains(&limit) {
            return Err(Error::invalid());
        }
        let conn = self.conn()?;
        let mut stmt=conn.prepare("SELECT Id,Timestamp,TokenId,Status,DurationMs,Source,ErrorCode FROM HeadlessLogs ORDER BY rowid DESC LIMIT ?")?;
        let items=stmt.query_map([limit],|r|Ok(json!({"id":r.get::<_,String>(0)?,"timestamp":r.get::<_,String>(1)?,"tokenId":r.get::<_,String>(2)?,"status":r.get::<_,u16>(3)?,"durationMs":r.get::<_,u64>(4)?,"source":r.get::<_,String>(5)?,"errorCode":r.get::<_,Option<String>>(6)?})))?.collect::<Result<Vec<_>,_>>()?;
        Ok(json!(items))
    }
}

impl From<QuestionMatch> for QueryData {
    fn from(m: QuestionMatch) -> Self {
        Self {
            id: m.id,
            question: m.question,
            answer: m.answer,
            is_ai: m.is_ai,
            is_pending_correction: m.is_pending_correction,
        }
    }
}
