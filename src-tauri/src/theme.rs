//! The custom theme, which is custom CSS. It's applied after the theme tokens in `src/theme.css`,
//! so a theme changes colors and radii by setting those tokens.
//!
//! The saved `theme.css` and exported theme files are the same plain CSS. Nothing in a theme may
//! load from outside this device: it can reference only embedded data URLs, so a shared theme
//! can't reveal anything to a remote server. The CSS editor can name local files, which are
//! embedded before the theme is saved.

use base64::Engine;
use std::path::{Path, PathBuf};

/// Room for images and fonts embedded as data URLs.
const MAX_CSS_BYTES: usize = 16 * 1024 * 1024;
/// How deeply local CSS files can import each other.
const MAX_IMPORT_DEPTH: usize = 8;

/// Embeds the local files that theme CSS names. Each `@import` of a local CSS file is replaced
/// with that file's contents, and each `url()` naming a local file becomes a data URL. Absolute
/// paths and `file:` URLs are local, and inside an imported file, relative paths resolve against
/// its folder. Other URLs are left for `validate` to reject.
pub fn embed_files(css: &str) -> Result<String, String> {
    embed(css, None, 0)
}

fn embed(css: &str, folder: Option<&Path>, depth: usize) -> Result<String, String> {
    let css = inline_imports(css, folder, depth)?;
    embed_urls(&css, folder)
}

/// Replaces each unconditional `@import` of a local CSS file with the file's embedded contents.
fn inline_imports(css: &str, folder: Option<&Path>, depth: usize) -> Result<String, String> {
    let lower = css.to_ascii_lowercase();
    let mut output = String::with_capacity(css.len());
    let mut rest = css;
    while let Some(start) = lower[css.len() - rest.len()..].find("@import") {
        output.push_str(&rest[..start]);
        let rule = &rest[start + 7..];
        let target =
            import_target(rule).and_then(|(value, end)| Some((local_path(value, folder)?, end)));
        let Some((path, end)) = target else {
            output.push_str(&rest[start..start + 7]);
            rest = rule;
            continue;
        };
        let name = path.display();
        if depth == MAX_IMPORT_DEPTH {
            return Err(format!(
                "{name} is imported too many times in a row. Does a file import itself?"
            ));
        }
        let text = String::from_utf8(read_file(&path)?)
            .map_err(|_| format!("{name} isn't a text file. Is it the right CSS file?"))?;
        output.push_str(&embed(&text, path.parent(), depth + 1)?);
        check_size(&output)?;
        rest = &rule[end..];
    }
    output.push_str(rest);
    Ok(output)
}

/// The path an `@import` names as a string or `url()`, when only `;` follows it, and the length
/// of the rule after `@import`.
fn import_target(rule: &str) -> Option<(&str, usize)> {
    let trimmed = rule.trim_start();
    let (value, tail) = if trimmed
        .get(..4)
        .is_some_and(|function| function.eq_ignore_ascii_case("url("))
    {
        let (_, value, tail) = split_url(&trimmed[4..]);
        let tail = tail.strip_prefix(['"', '\'']).unwrap_or(tail);
        (value, tail.trim_start().strip_prefix(')')?)
    } else {
        let quote = trimmed.chars().next().filter(|c| *c == '"' || *c == '\'')?;
        let body = &trimmed[1..];
        let end = body.find(quote)?;
        (&body[..end], &body[end + 1..])
    };
    let after = tail.trim_start().strip_prefix(';')?;
    Some((value, rule.len() - after.len()))
}

/// Replaces each `url()` that names a local file with the file as a data URL.
fn embed_urls(css: &str, folder: Option<&Path>) -> Result<String, String> {
    let lower = css.to_ascii_lowercase();
    let mut output = String::with_capacity(css.len());
    let mut rest = css;
    while let Some(start) = lower[css.len() - rest.len()..].find("url(") {
        let (before, after) = rest.split_at(start + 4);
        output.push_str(before);
        let (opening, value, tail) = split_url(after);
        output.push_str(opening);
        match local_path(value, folder) {
            Some(path) => {
                output.push_str(&data_url(&path)?);
                check_size(&output)?;
            }
            None => output.push_str(value),
        }
        rest = tail;
    }
    output.push_str(rest);
    Ok(output)
}

/// Splits the text after `url(` into the whitespace and opening quote, the value, and the rest,
/// which starts at the closing quote or parenthesis.
fn split_url(text: &str) -> (&str, &str, &str) {
    let start = text.len() - text.trim_start().len();
    let quote = text[start..]
        .chars()
        .next()
        .filter(|c| *c == '"' || *c == '\'');
    let start = start + quote.map_or(0, char::len_utf8);
    let body = &text[start..];
    let end = match quote {
        Some(quote) => body.find(quote),
        None => body.find(|c: char| c == ')' || c.is_whitespace()),
    }
    .unwrap_or(body.len());
    (&text[..start], &body[..end], &body[end..])
}

/// The local file a value names: an absolute path, a `file:` URL, or a path relative to
/// `folder`. Network paths and other URLs aren't local.
fn local_path(value: &str, folder: Option<&Path>) -> Option<PathBuf> {
    if value.is_empty()
        || value.starts_with(['#', '?'])
        || value.starts_with("//")
        || value.starts_with("\\\\")
    {
        return None;
    }
    if value
        .get(..5)
        .is_some_and(|scheme| scheme.eq_ignore_ascii_case("file:"))
    {
        let url = url::Url::parse(value).ok()?;
        if url.host_str().is_some_and(|host| !host.is_empty()) {
            return None;
        }
        return url.to_file_path().ok();
    }
    let path = PathBuf::from(value);
    if path.is_absolute() {
        return Some(path);
    }
    if url::Url::parse(value).is_ok() {
        return None;
    }
    folder.map(|folder| folder.join(path))
}

fn check_size(css: &str) -> Result<(), String> {
    if css.len() > MAX_CSS_BYTES {
        return Err("The theme is larger than 16 MB. Can its files be smaller?".into());
    }
    Ok(())
}

fn read_file(path: &Path) -> Result<Vec<u8>, String> {
    let name = path.display();
    let size = std::fs::metadata(path)
        .map_err(|_| format!("{name} couldn't be read. Does the file exist?"))?
        .len();
    if size > MAX_CSS_BYTES as u64 {
        return Err(format!("{name} is larger than 16 MB. Can it be smaller?"));
    }
    std::fs::read(path).map_err(|_| format!("{name} couldn't be read. Is it readable?"))
}

/// Reads an image or font file as a data URL, typed by its extension.
fn data_url(path: &Path) -> Result<String, String> {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let mime = match extension.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "ico" | "cur" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        _ => {
            return Err(format!(
                "{} isn't an image or font file. Can it be converted?",
                path.display()
            ));
        }
    };
    let data = base64::engine::general_purpose::STANDARD.encode(read_file(path)?);
    Ok(format!("data:{mime};base64,{data}"))
}

/// Checks that theme CSS is within the size limit and loads nothing from outside this device.
pub fn validate(css: &str) -> Result<(), String> {
    if css.len() > MAX_CSS_BYTES {
        return Err("The theme is larger than 16 MB. Can its images be smaller?".into());
    }
    if !css_is_local(css) {
        return Err(
            "The theme loads something from outside this device. Can it use local files or data URLs instead?"
                .into(),
        );
    }
    Ok(())
}

/// True when the CSS can't load anything except embedded data URLs. `url(#id)` refers to an
/// element in the same document.
///
/// Escapes are decoded and comments removed first, the way the CSS tokenizer reads them, so
/// `u\72l(` and `ur/**/l(` can't hide a URL. Text inside strings is kept, which can only make
/// the check stricter.
pub fn css_is_local(css: &str) -> bool {
    let text = normalize_css(css);
    if ["@import", "image-set(", "src("]
        .iter()
        .any(|pattern| text.contains(pattern))
    {
        return false;
    }
    text.match_indices("url(").all(|(index, _)| {
        let value = text[index + 4..]
            .trim_start_matches(|c: char| c.is_whitespace() || c == '"' || c == '\'');
        value.starts_with("data:") || value.starts_with('#')
    })
}

/// Lowercases CSS, decodes escapes, and drops comments outside strings.
fn normalize_css(css: &str) -> String {
    let mut output = String::with_capacity(css.len());
    let mut chars = css.chars().peekable();
    let mut quote: Option<char> = None;
    while let Some(c) = chars.next() {
        match c {
            '\\' => {
                let mut hex = String::new();
                while hex.len() < 6 && chars.peek().is_some_and(char::is_ascii_hexdigit) {
                    hex.extend(chars.next());
                }
                if hex.is_empty() {
                    output.extend(chars.next().map(|c| c.to_ascii_lowercase()));
                } else {
                    if chars.peek().is_some_and(|c| c.is_whitespace()) {
                        chars.next();
                    }
                    let decoded = u32::from_str_radix(&hex, 16)
                        .ok()
                        .and_then(char::from_u32)
                        .unwrap_or('\u{fffd}');
                    output.push(decoded.to_ascii_lowercase());
                }
            }
            '/' if quote.is_none() && chars.peek() == Some(&'*') => {
                chars.next();
                let mut previous = '\0';
                for c in chars.by_ref() {
                    if previous == '*' && c == '/' {
                        break;
                    }
                    previous = c;
                }
            }
            '"' | '\'' if quote.is_none() => {
                quote = Some(c);
                output.push(c);
            }
            '\n' if quote.is_some() => {
                quote = None;
                output.push(c);
            }
            _ if quote == Some(c) => {
                quote = None;
                output.push(c);
            }
            _ => output.push(c.to_ascii_lowercase()),
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    const PIXEL: &str = "data:image/png;base64,iVBORw0KGgo=";

    #[test]
    fn local_css_is_allowed() {
        assert!(css_is_local(""));
        assert!(css_is_local(":root { --radius: 12px; }"));
        assert!(css_is_local(&format!(
            "main {{ background: url({PIXEL}); }} a {{ background: URL( '{PIXEL}' ) }}"
        )));
        assert!(css_is_local("[data-page=\"dashboard\"] { color: red }"));
        assert!(css_is_local("a { mask: url('#shape') }"));
    }

    #[test]
    fn css_that_loads_remote_content_is_rejected() {
        for css in [
            "a { background: url(https://example.com/a.png) }",
            "a { background: url( \"//example.com/a.png\" ) }",
            "a { background: url(a.png) }",
            "@import 'https://example.com/a.css';",
            "@IMPORT url(a.css);",
            "a { background: image-set('https://example.com/a.png' 1x) }",
            "a { background: -webkit-image-set('a.png' 1x) }",
            "a { background: src('https://example.com/a.png') }",
            "a { background: u\\72l(https://example.com/a.png) }",
            "a { background: u\\000072 l(https://example.com/a.png) }",
            "a { background: \\75 rl(https://example.com/a.png) }",
            "a { background: ur\\l(https://example.com/a.png) }",
            "@imp/**/ort 'a.css';",
            "a { content: '/*' } b { background: url(https://example.com) } c { content: '*/' }",
            "a { background: url(data:image/png;base64,AA), url(https://example.com) }",
        ] {
            assert!(!css_is_local(css), "{css}");
        }
    }

    #[test]
    fn css_is_validated() {
        assert!(validate(&format!("main {{ background: url({PIXEL}) }}")).is_ok());
        assert!(validate("a { background: url(https://example.com) }").is_err());
        let large = format!(
            "main {{ background: url(data:image/png;base64,{}) }}",
            "A".repeat(MAX_CSS_BYTES)
        );
        assert!(validate(&large).is_err());
    }

    fn temp_folder() -> PathBuf {
        let folder = std::env::temp_dir().join(format!(
            "toolblox-theme-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&folder).unwrap();
        folder
    }

    fn data(mime: &str, bytes: &[u8]) -> String {
        let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
        format!("data:{mime};base64,{encoded}")
    }

    #[test]
    fn local_files_are_embedded() {
        let folder = temp_folder();
        let image = folder.join("bg.png");
        std::fs::write(&image, b"png").unwrap();
        let font = folder.join("Face.WOFF2");
        std::fs::write(&font, b"font").unwrap();
        let png = data("image/png", b"png");
        let woff2 = data("font/woff2", b"font");
        let file_url = url::Url::from_file_path(&image).unwrap();
        let (image, font) = (image.display(), font.display());
        let css = format!(
            "a {{ background: url(\"{image}\") }} b {{ background: URL( '{file_url}' ) }} c {{ background: url({image}) }} d {{ background: url({PIXEL}) }} @font-face {{ src: url(\"{font}\") }}"
        );
        let embedded = embed_files(&css).unwrap();
        assert_eq!(
            embedded,
            format!(
                "a {{ background: url(\"{png}\") }} b {{ background: URL( '{png}' ) }} c {{ background: url({png}) }} d {{ background: url({PIXEL}) }} @font-face {{ src: url(\"{woff2}\") }}"
            )
        );
        assert!(validate(&embedded).is_ok());
    }

    #[test]
    fn local_css_files_are_inlined() {
        let folder = temp_folder();
        std::fs::create_dir_all(folder.join("parts")).unwrap();
        std::fs::write(folder.join("parts/bg.svg"), b"<svg/>").unwrap();
        std::fs::write(
            folder.join("parts/colors.css"),
            ":root { --primary: red; }\nmain { background: url(bg.svg) }",
        )
        .unwrap();
        std::fs::write(
            folder.join("theme.css"),
            "@import \"parts/colors.css\";\na { mask: url('#shape') }",
        )
        .unwrap();
        let svg = data("image/svg+xml", b"<svg/>");
        let theme = folder.join("theme.css");
        for css in [
            format!("@import \"{}\";", theme.display()),
            format!("@IMPORT url( '{}' ) ;", theme.display()),
            format!(
                "@import url({});",
                url::Url::from_file_path(&theme).unwrap()
            ),
        ] {
            let embedded = embed_files(&format!("{css}\nb {{ color: blue }}")).unwrap();
            assert_eq!(
                embedded,
                format!(
                    ":root {{ --primary: red; }}\nmain {{ background: url({svg}) }}\na {{ mask: url('#shape') }}\nb {{ color: blue }}"
                )
            );
            assert!(validate(&embedded).is_ok());
        }
    }

    #[test]
    fn conditional_and_remote_imports_are_left_for_validation() {
        let folder = temp_folder();
        let theme = folder.join("theme.css");
        std::fs::write(&theme, "a { color: red }").unwrap();
        for css in [
            format!("@import \"{}\" screen;", theme.display()),
            "@import 'https://example.com/a.css';".to_string(),
            "@import 'a.css';".to_string(),
            "@import".to_string(),
        ] {
            assert_eq!(embed_files(&css).unwrap(), css);
            assert!(validate(&css).is_err());
        }
    }

    #[test]
    fn a_file_that_imports_itself_is_rejected() {
        let folder = temp_folder();
        std::fs::write(folder.join("loop.css"), "@import 'loop.css';").unwrap();
        let css = format!("@import '{}';", folder.join("loop.css").display());
        assert!(embed_files(&css).unwrap_err().contains("import itself"));
    }

    #[test]
    fn remote_and_network_urls_are_not_embedded() {
        for css in [
            "a { background: url(https://example.com/a.png) }",
            "a { background: url(//example.com/a.png) }",
            "a { background: url('\\\\server\\share\\a.png') }",
            "a { background: url(file://server/share/a.png) }",
            "a { background: url(a.png) }",
            "a { background: url(",
        ] {
            assert_eq!(embed_files(css).unwrap(), css);
        }
    }

    #[test]
    fn unsupported_and_missing_files_are_rejected() {
        let folder = temp_folder();
        let notes = folder.join("notes.txt");
        std::fs::write(&notes, b"secret").unwrap();
        let css = format!("a {{ background: url(\"{}\") }}", notes.display());
        assert!(
            embed_files(&css)
                .unwrap_err()
                .contains("isn't an image or font")
        );
        let css = format!(
            "a {{ background: url(\"{}\") }}",
            folder.join("missing.png").display()
        );
        assert!(
            embed_files(&css)
                .unwrap_err()
                .contains("Does the file exist?")
        );
    }
}
