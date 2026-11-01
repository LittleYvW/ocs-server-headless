use fs2::FileExt;
use std::{env, fs, net::SocketAddr, path::PathBuf};
use zerror_headless::{
    app::App,
    http,
    secrets::{private_file, random_token},
};

#[tokio::main]
async fn main() {
    if env::args().any(|arg| arg == "--healthcheck") {
        let port = env::var("ZERROR_PORT").unwrap_or_else(|_| "3002".into());
        let healthy = reqwest::Client::new()
            .get(format!("http://127.0.0.1:{port}/healthz"))
            .timeout(std::time::Duration::from_secs(3))
            .send()
            .await
            .is_ok_and(|r| r.status().is_success());
        std::process::exit(if healthy { 0 } else { 1 });
    }
    if let Err(error) = run().await {
        eprintln!("ZError headless startup failed: {error}");
        std::process::exit(1);
    }
}
async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let dir = PathBuf::from(env::var("ZERROR_DATA_DIR").unwrap_or_else(|_| "./data".into()));
    fs::create_dir_all(&dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
    }
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(dir.join("server.lock"))?;
    lock.try_lock_exclusive()
        .map_err(|_| std::io::Error::other("Another question bank owns this data directory"))?;
    let token_path = PathBuf::from(
        env::var("ZERROR_ADMIN_TOKEN_FILE")
            .unwrap_or_else(|_| dir.join("admin.token").to_string_lossy().into()),
    );
    if let Some(parent) = token_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let token = String::from_utf8(private_file(&token_path, random_token().as_bytes())?)?;
    let token = token.trim();
    if token.len() < 32 || token.chars().any(char::is_whitespace) {
        return Err(std::io::Error::other("Invalid internal management token").into());
    }
    let host = env::var("ZERROR_HOST").unwrap_or_else(|_| "127.0.0.1".into());
    let port = env::var("ZERROR_PORT")
        .unwrap_or_else(|_| "3002".into())
        .parse::<u16>()?;
    let max = env::var("ZERROR_MAX_CONCURRENT")
        .unwrap_or_else(|_| "8".into())
        .parse::<usize>()?;
    if !(1..=64).contains(&max) {
        return Err(std::io::Error::other("ZERROR_MAX_CONCURRENT must be between 1 and 64").into());
    }
    let address: SocketAddr = format!("{host}:{port}").parse()?;
    let app = App::open(&dir, token, max)?;
    let (bound, server) = warp::serve(http::routes(app.clone()))
        .try_bind_with_graceful_shutdown(address, shutdown())?;
    println!("ZError headless listening on {bound}");
    server.await;
    app.close().await;
    drop(lock);
    Ok(())
}
async fn shutdown() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("SIGTERM handler");
        tokio::select! {_=tokio::signal::ctrl_c()=>{},_=terminate.recv()=>{}}
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}
