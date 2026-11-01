// Derived from Miaozeqiu/ZError @ 9a05051355c0627c5928175bc73a9afb5aada7b0 (MIT).
// Copyright (c) 2024 ZError. See ../LICENSE and UPSTREAM.md.
use rusqlite::Connection;
use std::collections::HashSet;

fn get_table_columns(conn: &Connection, table_name: &str) -> Result<HashSet<String>, String> {
    let pragma = format!("PRAGMA table_info('{table_name}')");
    let mut stmt = conn.prepare(&pragma).map_err(|e| format!("{}", e))?;
    let cols = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| format!("{}", e))?;

    let mut names = HashSet::new();
    for col in cols {
        names.insert(col.map_err(|e| format!("{}", e))?);
    }

    Ok(names)
}

fn ensure_column(
    conn: &Connection,
    table_columns: &mut HashSet<String>,
    column_name: &str,
    alter_sql: &str,
    backfill_sqls: &[&str],
) -> Result<(), String> {
    if table_columns.contains(column_name) {
        return Ok(());
    }

    conn.execute(alter_sql, []).map_err(|e| format!("{}", e))?;
    for sql in backfill_sqls {
        conn.execute(sql, []).map_err(|e| format!("{}", e))?;
    }

    table_columns.insert(column_name.to_string());
    Ok(())
}

pub fn init_database_schema(db_path: &std::path::Path) -> Result<(), String> {
    let conn = Connection::open(db_path).map_err(|e| format!("{}", e))?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS Folders (
          Id INTEGER PRIMARY KEY AUTOINCREMENT,
          Name TEXT NOT NULL,
          ParentId INTEGER DEFAULT 0,
          CreateTime DATETIME DEFAULT CURRENT_TIMESTAMP
        )",
        [],
    )
    .map_err(|e| format!("{}", e))?;

    let mut folder_columns = get_table_columns(&conn, "Folders")?;
    ensure_column(
        &conn,
        &mut folder_columns,
        "ParentId",
        "ALTER TABLE Folders ADD COLUMN ParentId INTEGER DEFAULT 0",
        &["UPDATE Folders SET ParentId = 0 WHERE ParentId IS NULL"],
    )?;
    ensure_column(
        &conn,
        &mut folder_columns,
        "CreateTime",
        "ALTER TABLE Folders ADD COLUMN CreateTime DATETIME",
        &["UPDATE Folders SET CreateTime = datetime('now') WHERE CreateTime IS NULL"],
    )?;

    let exists_default: i64 = conn
        .query_row("SELECT COUNT(1) FROM Folders WHERE Id = 0", [], |row| {
            row.get(0)
        })
        .unwrap_or(0);
    if exists_default == 0 {
        let _ = conn.execute(
            "INSERT INTO Folders (Id, Name, ParentId) VALUES (0, '默认文件夹', 0)",
            [],
        );
    }

    conn.execute(
        "CREATE TABLE IF NOT EXISTS AIResponses (
          Id INTEGER PRIMARY KEY AUTOINCREMENT,
          Question TEXT NOT NULL,
          Options TEXT,
          QuestionType TEXT,
          Answer TEXT NOT NULL,
          CreateTime DATETIME DEFAULT CURRENT_TIMESTAMP,
          FolderId INTEGER DEFAULT 0,
          FolderName TEXT DEFAULT '默认文件夹',
          IsAi BOOLEAN DEFAULT 1,
          IsPendingCorrection BOOLEAN DEFAULT 0
        )",
        [],
    )
    .map_err(|e| format!("{}", e))?;

    let mut ai_response_columns = get_table_columns(&conn, "AIResponses")?;
    let had_folder_name = ai_response_columns.contains("FolderName");

    ensure_column(
        &conn,
        &mut ai_response_columns,
        "QuestionType",
        "ALTER TABLE AIResponses ADD COLUMN QuestionType TEXT",
        &[],
    )?;
    ensure_column(
        &conn,
        &mut ai_response_columns,
        "CreateTime",
        "ALTER TABLE AIResponses ADD COLUMN CreateTime DATETIME",
        &["UPDATE AIResponses SET CreateTime = datetime('now') WHERE CreateTime IS NULL"],
    )?;
    ensure_column(
        &conn,
        &mut ai_response_columns,
        "FolderId",
        "ALTER TABLE AIResponses ADD COLUMN FolderId INTEGER DEFAULT 0",
        &["UPDATE AIResponses SET FolderId = 0 WHERE FolderId IS NULL"],
    )?;
    if had_folder_name {
        conn.execute(
            "UPDATE AIResponses
             SET FolderId = COALESCE(
               (
                 SELECT Id
                 FROM Folders
                 WHERE Folders.Name = AIResponses.FolderName
                 ORDER BY CASE WHEN Id = 0 THEN 0 ELSE 1 END, Id
                 LIMIT 1
               ),
               0
             )
             WHERE FolderId IS NULL OR FolderId = 0",
            [],
        )
        .map_err(|e| format!("{}", e))?;
    }
    ensure_column(
        &conn,
        &mut ai_response_columns,
        "FolderName",
        "ALTER TABLE AIResponses ADD COLUMN FolderName TEXT DEFAULT '默认文件夹'",
        &["UPDATE AIResponses SET FolderName = '默认文件夹' WHERE FolderName IS NULL OR trim(FolderName) = ''"],
    )?;
    conn.execute(
        "UPDATE AIResponses
         SET FolderName = COALESCE(
           (SELECT Name FROM Folders WHERE Folders.Id = AIResponses.FolderId),
           '默认文件夹'
         )
         WHERE FolderName IS NULL OR trim(FolderName) = ''",
        [],
    )
    .map_err(|e| format!("{}", e))?;
    ensure_column(
        &conn,
        &mut ai_response_columns,
        "IsAi",
        "ALTER TABLE AIResponses ADD COLUMN IsAi BOOLEAN DEFAULT 1",
        &["UPDATE AIResponses SET IsAi = 1 WHERE IsAi IS NULL"],
    )?;
    ensure_column(
        &conn,
        &mut ai_response_columns,
        "IsPendingCorrection",
        "ALTER TABLE AIResponses ADD COLUMN IsPendingCorrection BOOLEAN DEFAULT 0",
        &["UPDATE AIResponses SET IsPendingCorrection = 0 WHERE IsPendingCorrection IS NULL"],
    )?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;
    #[test]
    fn migrates_legacy_database_schema() {
        let db_path = std::env::temp_dir().join(format!("zerror-migration-{}.db", Uuid::new_v4()));
        let db_path_str = db_path.to_string_lossy().to_string();

        {
            let conn = Connection::open(&db_path_str).expect("create legacy database");
            conn.execute(
                "CREATE TABLE Folders (
                  Id INTEGER PRIMARY KEY AUTOINCREMENT,
                  Name TEXT NOT NULL
                )",
                [],
            )
            .expect("create legacy folders");
            conn.execute(
                "CREATE TABLE AIResponses (
                  Id INTEGER PRIMARY KEY AUTOINCREMENT,
                  Question TEXT NOT NULL,
                  Options TEXT,
                  Answer TEXT NOT NULL,
                  FolderName TEXT DEFAULT '默认文件夹'
                )",
                [],
            )
            .expect("create legacy ai responses");
            conn.execute(
                "INSERT INTO Folders (Id, Name) VALUES (0, '默认文件夹')",
                [],
            )
            .expect("insert default folder");
            conn.execute(
                "INSERT INTO AIResponses (Question, Options, Answer, FolderName) VALUES ('题目', NULL, '答案', '默认文件夹')",
                [],
            )
            .expect("insert legacy response");
        }

        init_database_schema(&db_path).expect("migrate legacy database");

        let conn = Connection::open(&db_path_str).expect("reopen migrated database");
        let folder_columns = get_table_columns(&conn, "Folders").expect("read folder columns");
        assert!(folder_columns.contains("ParentId"));
        assert!(folder_columns.contains("CreateTime"));

        let response_columns =
            get_table_columns(&conn, "AIResponses").expect("read ai response columns");
        assert!(response_columns.contains("QuestionType"));
        assert!(response_columns.contains("CreateTime"));
        assert!(response_columns.contains("FolderId"));
        assert!(response_columns.contains("FolderName"));
        assert!(response_columns.contains("IsAi"));
        assert!(response_columns.contains("IsPendingCorrection"));

        let (folder_id, folder_name, is_ai, is_pending): (i64, String, i64, i64) = conn
            .query_row(
                "SELECT FolderId, FolderName, IsAi, IsPendingCorrection FROM AIResponses LIMIT 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("query migrated values");
        assert_eq!(folder_id, 0);
        assert_eq!(folder_name, "默认文件夹");
        assert_eq!(is_ai, 1);
        assert_eq!(is_pending, 0);

        let _ = std::fs::remove_file(&db_path_str);
    }
}
