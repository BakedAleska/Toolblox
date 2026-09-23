//! Read-only custom protocol for installed widget web assets.

use std::path::{Component, Path};

use tauri::Manager;

use crate::app_commands::Runtime;

pub fn response(
    context: tauri::UriSchemeContext<'_, tauri::Wry>,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    if context.webview_label() != crate::lifecycle::MAIN_WINDOW_LABEL {
        return error(
            tauri::http::StatusCode::FORBIDDEN,
            "Widget assets aren't available here.",
        );
    }
    let path = request.uri().path().trim_start_matches('/');
    let mut parts = Path::new(path).components();
    let Some(Component::Normal(widget_id)) = parts.next() else {
        return error(
            tauri::http::StatusCode::BAD_REQUEST,
            "The widget path isn't valid.",
        );
    };
    let widget_id = widget_id.to_string_lossy();
    if widget_id.is_empty()
        || !widget_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return error(
            tauri::http::StatusCode::BAD_REQUEST,
            "The widget ID isn't valid.",
        );
    }
    let relative: std::path::PathBuf = parts.collect();
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return error(
            tauri::http::StatusCode::BAD_REQUEST,
            "The widget file path isn't valid.",
        );
    }
    let runtime = context.app_handle().state::<Runtime>();
    let root = runtime.widgets_root.join(widget_id.as_ref());
    let Ok(root) = root.canonicalize() else {
        return error(
            tauri::http::StatusCode::NOT_FOUND,
            "The widget isn't installed.",
        );
    };
    let file = root.join(relative);
    let Ok(file) = file.canonicalize() else {
        return error(
            tauri::http::StatusCode::NOT_FOUND,
            "The widget file wasn't found.",
        );
    };
    if !file.starts_with(&root) || !file.is_file() {
        return error(
            tauri::http::StatusCode::FORBIDDEN,
            "The widget file path isn't allowed.",
        );
    }
    let Ok(bytes) = std::fs::read(&file) else {
        return error(
            tauri::http::StatusCode::INTERNAL_SERVER_ERROR,
            "The widget file couldn't be read.",
        );
    };
    let content_type = match file
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
    {
        "html" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    };
    tauri::http::Response::builder()
        .status(tauri::http::StatusCode::OK)
        .header("Content-Type", content_type)
        .header("X-Content-Type-Options", "nosniff")
        .header("Cache-Control", "no-store")
        .header("Access-Control-Allow-Origin", "*")
        .header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'",
        )
        .body(bytes)
        .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
}

fn error(status: tauri::http::StatusCode, message: &str) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .header("Content-Type", "text/plain; charset=utf-8")
        .header("X-Content-Type-Options", "nosniff")
        .body(message.as_bytes().to_vec())
        .unwrap_or_else(|_| tauri::http::Response::new(Vec::new()))
}
