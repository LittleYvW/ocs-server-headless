use crate::{
    app::App,
    types::{Error, QueryRequest},
};
use bytes::{Buf, Bytes, BytesMut};
use futures_util::{Stream, StreamExt};
use serde_json::{json, Value};
use std::{convert::Infallible, sync::Arc};
use warp::{
    http::{Method, StatusCode},
    path::FullPath,
    Filter, Rejection, Reply,
};

#[derive(Debug)]
struct BodyError(u16);
impl warp::reject::Reject for BodyError {}
async fn bounded_body<S, B>(stream: S) -> Result<Bytes, Rejection>
where
    S: Stream<Item = Result<B, warp::Error>> + Send,
    B: Buf,
{
    let mut stream = Box::pin(stream);
    let mut bytes = BytesMut::new();
    while let Some(chunk) = stream.next().await {
        let mut chunk = chunk.map_err(|_| warp::reject::custom(BodyError(400)))?;
        if bytes.len() + chunk.remaining() > 1024 * 1024 {
            return Err(warp::reject::custom(BodyError(413)));
        }
        bytes.extend_from_slice(&chunk.copy_to_bytes(chunk.remaining()));
    }
    Ok(bytes.freeze())
}
pub fn routes(app: Arc<App>) -> impl Filter<Extract = (impl Reply,), Error = Infallible> + Clone {
    warp::path::full()
        .and(warp::method())
        .and(warp::header::optional::<String>("authorization"))
        .and(warp::header::optional::<String>("origin"))
        .and(warp::query::raw().or(warp::any().map(String::new)).unify())
        .and(warp::body::stream().and_then(bounded_body))
        .and(warp::any().map(move || app.clone()))
        .and_then(handle)
        .recover(|rejection: Rejection| async move {
            let status = if let Some(e) = rejection.find::<BodyError>() {
                e.0
            } else {
                400
            };
            let error = Error::new(status, "INVALID_REQUEST", "Invalid or oversized request");
            Ok::<_, Infallible>(reply(error.status, error.value(), false))
        })
}
fn reply(status: u16, value: Value, query: bool) -> warp::reply::Response {
    let mut res = warp::reply::with_status(
        warp::reply::json(&value),
        StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
    )
    .into_response();
    let headers = res.headers_mut();
    headers.insert("cache-control", "no-store".parse().unwrap());
    headers.insert("x-content-type-options", "nosniff".parse().unwrap());
    headers.insert(
        "content-security-policy",
        "default-src 'none'; frame-ancestors 'none'"
            .parse()
            .unwrap(),
    );
    if query {
        headers.insert("access-control-allow-origin", "*".parse().unwrap());
        headers.insert(
            "access-control-allow-headers",
            "Authorization, Content-Type".parse().unwrap(),
        );
        headers.insert(
            "access-control-allow-methods",
            "GET, POST, OPTIONS".parse().unwrap(),
        );
    }
    if status == 429 {
        headers.insert("retry-after", "60".parse().unwrap());
    }
    res
}
async fn handle(
    path: FullPath,
    method: Method,
    auth: Option<String>,
    origin: Option<String>,
    query: String,
    body: Bytes,
    app: Arc<App>,
) -> Result<warp::reply::Response, Infallible> {
    let path = path.as_str();
    if method == Method::GET && path == "/healthz" {
        return Ok(reply(200, json!({"status":"ok"}), false));
    }
    let is_query = path == "/query";
    if is_query && method == Method::OPTIONS {
        return Ok(reply(204, Value::Null, true));
    }
    let token = auth
        .as_deref()
        .and_then(|s| s.strip_prefix("Bearer "))
        .filter(|s| s.len() <= 256)
        .unwrap_or("");
    let result = if is_query && (method == Method::GET || method == Method::POST) {
        if token.is_empty() {
            Err(Error::new(
                401,
                "UNAUTHORIZED",
                "A valid query token is required",
            ))
        } else if body.len() > 64 * 1024 || query.len() > 64 * 1024 {
            Err(Error::new(413, "BODY_TOO_LARGE", "Query is too large"))
        } else {
            let request: Result<QueryRequest, _> = if method == Method::GET {
                serde_urlencoded::from_str(&query).map_err(|_| Error::invalid())
            } else {
                serde_json::from_slice(&body).map_err(|_| Error::invalid())
            };
            match request {
                Ok(req) => app.query(token, req).await.map(|mut data| {
                    data.question = data
                        .question
                        .replace('&', "&amp;")
                        .replace('<', "&lt;")
                        .replace('>', "&gt;")
                        .replace('"', "&quot;")
                        .replace('\'', "&#39;")
                        .replace('\n', "<br>");
                    json!({"code":1,"data":data})
                }),
                Err(e) => Err(e),
            }
        }
    } else if path.starts_with("/admin/") {
        if origin.is_some() || !app.is_admin(token) {
            Err(Error::new(
                401,
                "UNAUTHORIZED",
                "Internal management authentication is required",
            ))
        } else {
            let value = if body.is_empty() {
                Ok(json!({}))
            } else {
                serde_json::from_slice::<Value>(&body).map_err(|_| Error::invalid())
            };
            match value {
                Ok(value) => app
                    .admin(method.as_str(), path, &query, value)
                    .await
                    .map(|data| json!({"data":data})),
                Err(e) => Err(e),
            }
        }
    } else {
        Err(Error::missing())
    };
    Ok(match result {
        Ok(value) => reply(200, value, is_query),
        Err(error) => reply(error.status, error.value(), is_query),
    })
}
