# ZError backend extraction

Source: https://github.com/Miaozeqiu/ZError/tree/9a05051355c0627c5928175bc73a9afb5aada7b0

License: MIT, Copyright (c) 2024 ZError. The complete upstream license is retained in LICENSE.

- src/matching.rs: adapted from src-tauri/src/database.rs (Chinese token coverage, edit similarity, option-aware matching).
- src/schema.rs: adapted from src-tauri/src/database.rs (Folders / AIResponses schema migration).
- src/answers.rs: adapted from src-tauri/src/server.rs (question-type prompts and option normalization).
- HTTP lifecycle, administration, credentials, provider execution, admission control and integration are implemented for this headless service.
- No Tauri, GUI, WebView, remote model catalog or custom JavaScript runtime is required.
- Upstream request/response bodies and headers are deliberately not copied into logs.
