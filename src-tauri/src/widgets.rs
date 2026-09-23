//! Permissioned widget manifests, signed catalogue data, and safe package installation.

use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{Cursor, Write};
use std::path::{Component, Path};

use base64::Engine;
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use url::Url;
use uuid::Uuid;
use zip::ZipArchive;

const MAX_ARCHIVE_BYTES: usize = 20 * 1024 * 1024;
const MAX_EXPANDED_BYTES: u64 = 80 * 1024 * 1024;
const MAX_FILES: usize = 2_000;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetManifest {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    pub version: String,
    /// Sandboxed iframe page. Optional when the widget provides `module`.
    #[serde(default)]
    pub entry: Option<String>,
    /// ES module loaded into the app window with full access to the host API.
    #[serde(default)]
    pub module: Option<String>,
    #[serde(default)]
    pub settings_entry: Option<String>,
    #[serde(default)]
    pub dashboard_entry: Option<String>,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub permissions: Vec<WidgetPermission>,
    #[serde(default)]
    pub network_origins: Vec<String>,
    #[serde(default)]
    pub processes: Vec<WidgetProcess>,
}

#[derive(Clone, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub enum WidgetPermission {
    #[serde(rename = "accounts.read.basic")]
    AccountsReadBasic,
    #[serde(rename = "widgetData.read")]
    WidgetDataRead,
    #[serde(rename = "widgetData.write")]
    WidgetDataWrite,
    #[serde(rename = "roblox.status")]
    RobloxStatus,
    #[serde(rename = "roblox.join")]
    RobloxJoin,
    #[serde(rename = "network.fetch")]
    NetworkFetch,
    #[serde(rename = "process.spawn")]
    ProcessSpawn,
}

impl WidgetPermission {
    /// Every permission. Module widgets run in the app window and receive all of them.
    pub const ALL: [WidgetPermission; 7] = [
        WidgetPermission::AccountsReadBasic,
        WidgetPermission::WidgetDataRead,
        WidgetPermission::WidgetDataWrite,
        WidgetPermission::RobloxStatus,
        WidgetPermission::RobloxJoin,
        WidgetPermission::NetworkFetch,
        WidgetPermission::ProcessSpawn,
    ];
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetProcess {
    pub id: String,
    pub executable: String,
    #[serde(default)]
    pub allowed_arguments: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalogue {
    pub schema_version: u32,
    pub generated_at: i64,
    pub entries: Vec<CatalogueEntry>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogueEntry {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub archive_url: String,
    pub sha256: String,
    #[serde(default)]
    pub permissions: Vec<WidgetPermission>,
    #[serde(default)]
    pub icon_url: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledWidget {
    pub id: String,
    pub version: String,
    pub sha256: String,
    pub manifest: WidgetManifest,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstalledMetadata {
    schema_version: u32,
    id: String,
    version: String,
    sha256: String,
    manifest_sha256: String,
}

impl WidgetManifest {
    pub fn validate(&self) -> Result<(), String> {
        if self.schema_version != 1 {
            return Err("This widget uses an unsupported manifest version.".into());
        }
        validate_widget_id(&self.id)?;
        if self.name.trim().is_empty() || self.name.chars().count() > 80 {
            return Err("The widget name must contain between 1 and 80 characters.".into());
        }
        Version::parse(&self.version).map_err(|_| "The widget version isn't valid SemVer.")?;
        if self.entry.is_none() && self.module.is_none() {
            return Err("The widget must declare an entry page or a module.".into());
        }
        if self
            .entry
            .as_deref()
            .is_some_and(|entry| entry != "index.html")
        {
            return Err("The widget entry must be index.html.".into());
        }
        if self
            .module
            .as_deref()
            .is_some_and(|module| module != "main.js")
        {
            return Err("The widget module must be main.js.".into());
        }
        if self
            .settings_entry
            .as_deref()
            .is_some_and(|entry| entry != "settings.html")
        {
            return Err("The widget settings entry must be settings.html.".into());
        }
        if self
            .dashboard_entry
            .as_deref()
            .is_some_and(|entry| entry != "dashboard.html")
        {
            return Err("The widget dashboard entry must be dashboard.html.".into());
        }
        let permissions: HashSet<_> = self.permissions.iter().collect();
        if permissions.len() != self.permissions.len() {
            return Err("The widget manifest contains duplicate permissions.".into());
        }
        for origin in &self.network_origins {
            validate_https_origin(origin)?;
        }
        if !self.network_origins.is_empty()
            && !permissions.contains(&WidgetPermission::NetworkFetch)
        {
            return Err(
                "The widget declares network origins without network.fetch permission.".into(),
            );
        }
        let mut process_ids = HashSet::new();
        for process in &self.processes {
            validate_process_id(&process.id)?;
            validate_relative_file(&process.executable, "process executable")?;
            if !process.executable.starts_with("optional-bin/") {
                return Err("Widget processes must live under optional-bin/.".into());
            }
            if !process_ids.insert(&process.id) {
                return Err("The widget manifest contains duplicate process IDs.".into());
            }
        }
        if !self.processes.is_empty() && !permissions.contains(&WidgetPermission::ProcessSpawn) {
            return Err("The widget declares processes without process.spawn permission.".into());
        }
        Ok(())
    }
}

impl Catalogue {
    pub fn parse_verified(
        bytes: &[u8],
        signature_base64: &str,
        public_key_base64: &str,
    ) -> Result<Self, String> {
        verify_signature(bytes, signature_base64, public_key_base64)?;
        let catalogue: Self = serde_json::from_slice(bytes)
            .map_err(|_| "The widget catalogue isn't valid JSON.".to_string())?;
        if catalogue.schema_version != 1 {
            return Err("The widget catalogue version isn't supported.".into());
        }
        let mut ids = HashSet::new();
        for entry in &catalogue.entries {
            validate_widget_id(&entry.id)?;
            Version::parse(&entry.version)
                .map_err(|_| format!("Widget {} has an invalid version.", entry.id))?;
            validate_sha256(&entry.sha256)?;
            let permissions: HashSet<_> = entry.permissions.iter().collect();
            if permissions.len() != entry.permissions.len() {
                return Err(format!(
                    "Widget {} has duplicate catalogue permissions.",
                    entry.id
                ));
            }
            let url = Url::parse(&entry.archive_url)
                .map_err(|_| format!("Widget {} has an invalid archive URL.", entry.id))?;
            if url.scheme() != "https" || url.host_str().is_none() {
                return Err(format!(
                    "Widget {} must use an HTTPS archive URL.",
                    entry.id
                ));
            }
            if !ids.insert(&entry.id) {
                return Err(format!(
                    "The catalogue contains widget {} more than once.",
                    entry.id
                ));
            }
        }
        Ok(catalogue)
    }
}

pub fn install_archive(
    archive: &[u8],
    expected_id: &str,
    expected_version: &str,
    expected_sha256: &str,
    expected_permissions: &[WidgetPermission],
    widgets_root: &Path,
) -> Result<InstalledWidget, String> {
    validate_widget_id(expected_id)?;
    validate_sha256(expected_sha256)?;
    if archive.len() > MAX_ARCHIVE_BYTES {
        return Err("The widget package is larger than 20 MB.".into());
    }
    let actual_sha256 = hex::encode(Sha256::digest(archive));
    if !actual_sha256.eq_ignore_ascii_case(expected_sha256) {
        return Err("The widget package checksum doesn't match the catalogue.".into());
    }

    fs::create_dir_all(widgets_root)
        .map_err(|_| "Couldn't create the widget directory. Is it writable?".to_string())?;
    let nonce = Uuid::new_v4();
    let staging = widgets_root.join(format!(".{expected_id}-install-{nonce}"));
    let backup = widgets_root.join(format!(".{expected_id}-backup-{nonce}"));
    let destination = widgets_root.join(expected_id);
    fs::create_dir(&staging)
        .map_err(|_| "Couldn't create the widget staging directory. Is it writable?".to_string())?;

    let result = extract_archive(archive, &staging).and_then(|_| {
        let manifest = read_manifest(&staging)?;
        if manifest.id != expected_id {
            return Err("The widget package ID doesn't match the catalogue.".into());
        }
        if manifest.version != expected_version {
            return Err("The widget package version doesn't match the catalogue.".into());
        }
        if manifest.permissions.iter().collect::<HashSet<_>>()
            != expected_permissions.iter().collect::<HashSet<_>>()
        {
            return Err("The widget permissions don't match the catalogue.".into());
        }
        for entry in [
            manifest.entry.as_deref(),
            manifest.module.as_deref(),
            manifest.settings_entry.as_deref(),
            manifest.dashboard_entry.as_deref(),
        ]
        .into_iter()
        .flatten()
        {
            if !staging.join(entry).is_file() {
                return Err(format!("The widget package doesn't contain {entry}."));
            }
        }
        for process in &manifest.processes {
            if !staging.join(&process.executable).is_file() {
                return Err(format!("Widget process {} is missing.", process.id));
            }
        }
        write_installed_metadata(&staging, &manifest, &actual_sha256)?;
        replace_atomically(&staging, &destination, &backup)?;
        Ok(InstalledWidget {
            id: manifest.id.clone(),
            version: manifest.version.clone(),
            sha256: actual_sha256,
            manifest,
        })
    });

    if staging.exists() {
        let _ = fs::remove_dir_all(&staging);
    }
    if result.is_ok() && backup.exists() {
        let _ = fs::remove_dir_all(&backup);
    }
    result
}

pub fn discover_installed(widgets_root: &Path) -> Vec<Result<InstalledWidget, String>> {
    let Ok(entries) = fs::read_dir(widgets_root) else {
        return Vec::new();
    };
    let mut found = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || !entry.path().is_dir() {
            continue;
        }
        found.push(
            read_installed(&entry.path())
                .map_err(|error| format!("Widget {name} couldn't load: {error}")),
        );
    }
    found.sort_by(|left, right| {
        let left_id = left.as_ref().map(|widget| widget.id.as_str()).unwrap_or("");
        let right_id = right
            .as_ref()
            .map(|widget| widget.id.as_str())
            .unwrap_or("");
        left_id.cmp(right_id)
    });
    found
}

pub fn uninstall_widget(widget_id: &str, widgets_root: &Path) -> Result<(), String> {
    validate_widget_id(widget_id)?;
    let target = widgets_root.join(widget_id);
    if !target.exists() {
        return Ok(());
    }
    fs::remove_dir_all(target)
        .map_err(|_| "Couldn't remove the widget. Is a widget process still running?".to_string())
}

fn extract_archive(archive: &[u8], staging: &Path) -> Result<(), String> {
    let mut zip = ZipArchive::new(Cursor::new(archive))
        .map_err(|_| "The widget package isn't a valid ZIP archive.".to_string())?;
    if zip.len() > MAX_FILES {
        return Err("The widget package contains too many files.".into());
    }
    let mut names = HashSet::new();
    let mut expanded = 0_u64;
    for index in 0..zip.len() {
        let mut item = zip
            .by_index(index)
            .map_err(|_| "Couldn't read the widget package.".to_string())?;
        let enclosed = item
            .enclosed_name()
            .ok_or_else(|| "The widget package contains an unsafe path.".to_string())?
            .to_path_buf();
        validate_archive_path(&enclosed)?;
        let normalized = enclosed.to_string_lossy().replace('\\', "/");
        if !names.insert(normalized) {
            return Err("The widget package contains duplicate paths.".into());
        }
        if item
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err("The widget package contains a symbolic link.".into());
        }
        expanded = expanded
            .checked_add(item.size())
            .ok_or_else(|| "The widget package is too large when extracted.".to_string())?;
        if expanded > MAX_EXPANDED_BYTES {
            return Err("The widget package is too large when extracted.".into());
        }
        let output = staging.join(&enclosed);
        if item.is_dir() {
            fs::create_dir_all(&output)
                .map_err(|_| "Couldn't create a widget package directory.".to_string())?;
            continue;
        }
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent)
                .map_err(|_| "Couldn't create a widget package directory.".to_string())?;
        }
        let mut file = File::create(&output)
            .map_err(|_| "Couldn't create a widget package file.".to_string())?;
        std::io::copy(&mut item, &mut file)
            .map_err(|_| "Couldn't extract the widget package.".to_string())?;
        file.sync_all()
            .map_err(|_| "Couldn't save the widget package.".to_string())?;
        #[cfg(unix)]
        if let Some(mode) = item.unix_mode() {
            use std::os::unix::fs::PermissionsExt;

            fs::set_permissions(&output, fs::Permissions::from_mode(mode & 0o777))
                .map_err(|_| "Couldn't set widget package permissions.".to_string())?;
        }
    }
    Ok(())
}

fn read_manifest(root: &Path) -> Result<WidgetManifest, String> {
    let bytes = fs::read(root.join("widget.json"))
        .map_err(|_| "The widget package doesn't contain widget.json.".to_string())?;
    if bytes.len() > 128 * 1024 {
        return Err("The widget manifest is too large.".into());
    }
    let manifest: WidgetManifest = serde_json::from_slice(&bytes)
        .map_err(|_| "The widget manifest isn't valid JSON.".to_string())?;
    manifest.validate()?;
    Ok(manifest)
}

fn read_installed(root: &Path) -> Result<InstalledWidget, String> {
    let manifest = read_manifest(root)?;
    let metadata_bytes = match fs::read(root.join(".installed.json")) {
        Ok(bytes) => bytes,
        Err(_) if cfg!(debug_assertions) => {
            return Ok(InstalledWidget {
                id: manifest.id.clone(),
                version: manifest.version.clone(),
                sha256: "0".repeat(64),
                manifest,
            });
        }
        Err(_) => {
            return Err(format!(
                "Widget {} is missing install metadata.",
                manifest.id
            ));
        }
    };
    let metadata: InstalledMetadata = serde_json::from_slice(&metadata_bytes)
        .map_err(|_| format!("Widget {} has invalid install metadata.", manifest.id))?;
    if metadata.schema_version != 1
        || metadata.id != manifest.id
        || metadata.version != manifest.version
    {
        return Err(format!(
            "Widget {} has inconsistent install metadata.",
            manifest.id
        ));
    }
    validate_sha256(&metadata.sha256)?;
    validate_sha256(&metadata.manifest_sha256)?;
    let manifest_bytes = fs::read(root.join("widget.json"))
        .map_err(|_| format!("Widget {} is missing widget.json.", manifest.id))?;
    if hex::encode(Sha256::digest(&manifest_bytes)) != metadata.manifest_sha256 {
        return Err(format!(
            "Widget {} has a modified manifest. Reinstall it from the Catalogue.",
            manifest.id
        ));
    }
    Ok(InstalledWidget {
        id: manifest.id.clone(),
        version: manifest.version.clone(),
        sha256: metadata.sha256,
        manifest,
    })
}

fn write_installed_metadata(
    root: &Path,
    manifest: &WidgetManifest,
    sha256: &str,
) -> Result<(), String> {
    let metadata = InstalledMetadata {
        schema_version: 1,
        id: manifest.id.clone(),
        version: manifest.version.clone(),
        sha256: sha256.to_owned(),
        manifest_sha256: hex::encode(Sha256::digest(
            fs::read(root.join("widget.json"))
                .map_err(|_| "Couldn't read widget.json after installation.".to_string())?,
        )),
    };
    let bytes = serde_json::to_vec_pretty(&metadata)
        .map_err(|_| "Couldn't encode widget install metadata.".to_string())?;
    let path = root.join(".installed.json");
    let mut file =
        File::create(path).map_err(|_| "Couldn't create widget install metadata.".to_string())?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "Couldn't save widget install metadata.".to_string())
}

fn replace_atomically(staging: &Path, destination: &Path, backup: &Path) -> Result<(), String> {
    if destination.exists() {
        fs::rename(destination, backup)
            .map_err(|_| "Couldn't prepare the installed widget for replacement.".to_string())?;
    }
    if let Err(error) = fs::rename(staging, destination) {
        if backup.exists() {
            let _ = fs::rename(backup, destination);
        }
        return Err(format!("Couldn't activate the widget package: {error}"));
    }
    Ok(())
}

fn verify_signature(
    bytes: &[u8],
    signature_base64: &str,
    public_key_base64: &str,
) -> Result<(), String> {
    let decoder = base64::engine::general_purpose::STANDARD;
    let key_bytes = decoder
        .decode(public_key_base64)
        .map_err(|_| "The catalogue public key isn't valid.".to_string())?;
    let signature_bytes = decoder
        .decode(signature_base64)
        .map_err(|_| "The catalogue signature isn't valid.".to_string())?;
    let key_array: [u8; 32] = key_bytes
        .try_into()
        .map_err(|_| "The catalogue public key has the wrong length.".to_string())?;
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|_| "The catalogue signature has the wrong length.".to_string())?;
    let key = VerifyingKey::from_bytes(&key_array)
        .map_err(|_| "The catalogue public key isn't valid.".to_string())?;
    key.verify(bytes, &signature)
        .map_err(|_| "The widget catalogue signature couldn't be verified.".to_string())
}

fn validate_widget_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
    {
        return Err(
            "Widget IDs may contain only lowercase letters, numbers, and underscores.".into(),
        );
    }
    Ok(())
}

fn validate_process_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err("Widget process IDs contain unsupported characters.".into());
    }
    Ok(())
}

fn validate_relative_file(value: &str, label: &str) -> Result<(), String> {
    let path = Path::new(value);
    if value.is_empty()
        || path.is_absolute()
        || path.components().any(|part| {
            matches!(
                part,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(format!("The widget {label} path isn't safe."));
    }
    Ok(())
}

fn validate_archive_path(path: &Path) -> Result<(), String> {
    if path.components().any(|part| {
        matches!(
            part,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err("The widget package contains an unsafe path.".into());
    }
    Ok(())
}

fn validate_https_origin(value: &str) -> Result<(), String> {
    let url = Url::parse(value).map_err(|_| "A widget network origin isn't valid.".to_string())?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("Widget network origins must be bare HTTPS origins.".into());
    }
    Ok(())
}

fn validate_sha256(value: &str) -> Result<(), String> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("A widget checksum isn't a valid SHA-256 value.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    use std::io::Write;
    use tempfile::tempdir;
    use zip::write::SimpleFileOptions;

    fn manifest() -> WidgetManifest {
        WidgetManifest {
            schema_version: 1,
            id: "example_widget".into(),
            name: "Example Widget".into(),
            version: "1.0.0".into(),
            entry: Some("index.html".into()),
            module: None,
            settings_entry: None,
            dashboard_entry: None,
            description: String::new(),
            icon: None,
            permissions: vec![WidgetPermission::WidgetDataRead],
            network_origins: Vec::new(),
            processes: Vec::new(),
        }
    }

    #[test]
    fn manifest_needs_a_page_or_a_module_with_fixed_names() {
        let mut module_only = manifest();
        module_only.entry = None;
        module_only.module = Some("main.js".into());
        assert!(module_only.validate().is_ok());
        let mut neither = module_only.clone();
        neither.module = None;
        assert!(neither.validate().is_err());
        let mut renamed = module_only.clone();
        renamed.module = Some("../main.js".into());
        assert!(renamed.validate().is_err());
    }

    fn archive(files: &[(&str, &[u8])]) -> Vec<u8> {
        let cursor = Cursor::new(Vec::new());
        let mut writer = zip::ZipWriter::new(cursor);
        for (name, contents) in files {
            writer
                .start_file(*name, SimpleFileOptions::default())
                .unwrap();
            writer.write_all(contents).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    #[test]
    fn manifest_rejects_undeclared_network_access() {
        let mut value = manifest();
        value.network_origins = vec!["https://example.com".into()];
        assert!(value.validate().is_err());
    }

    #[test]
    fn signed_catalogue_requires_exact_bytes() {
        let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
        let bytes = br#"{"schemaVersion":1,"generatedAt":1,"entries":[]}"#;
        let signature = signing_key.sign(bytes);
        let encoder = base64::engine::general_purpose::STANDARD;
        let parsed = Catalogue::parse_verified(
            bytes,
            &encoder.encode(signature.to_bytes()),
            &encoder.encode(signing_key.verifying_key().to_bytes()),
        );
        assert!(parsed.is_ok());
        assert!(
            Catalogue::parse_verified(
                b"{}",
                &encoder.encode(signature.to_bytes()),
                &encoder.encode(signing_key.verifying_key().to_bytes()),
            )
            .is_err()
        );
    }

    #[test]
    fn install_verifies_then_replaces() {
        let root = tempdir().unwrap();
        let manifest_bytes = serde_json::to_vec(&manifest()).unwrap();
        let bytes = archive(&[
            ("widget.json", &manifest_bytes),
            ("index.html", b"<main>Example</main>"),
        ]);
        let checksum = hex::encode(Sha256::digest(&bytes));
        let installed = install_archive(
            &bytes,
            "example_widget",
            "1.0.0",
            &checksum,
            &[WidgetPermission::WidgetDataRead],
            root.path(),
        )
        .unwrap();
        assert_eq!(installed.version, "1.0.0");
        assert!(root.path().join("example_widget/index.html").is_file());
    }

    #[test]
    fn install_rejects_checksum_mismatch_before_extraction() {
        let root = tempdir().unwrap();
        let error = install_archive(
            &[],
            "example_widget",
            "1.0.0",
            &"0".repeat(64),
            &[],
            root.path(),
        )
        .unwrap_err();
        assert!(error.contains("checksum"));
        assert!(!root.path().join("example_widget").exists());
    }

    #[test]
    fn install_rejects_manifest_version_mismatch() {
        let root = tempdir().unwrap();
        let manifest_bytes = serde_json::to_vec(&manifest()).unwrap();
        let bytes = archive(&[
            ("widget.json", &manifest_bytes),
            ("index.html", b"<main>Example</main>"),
        ]);
        let checksum = hex::encode(Sha256::digest(&bytes));
        let error = install_archive(
            &bytes,
            "example_widget",
            "2.0.0",
            &checksum,
            &[WidgetPermission::WidgetDataRead],
            root.path(),
        )
        .unwrap_err();
        assert!(error.contains("version"));
        assert!(!root.path().join("example_widget").exists());
    }

    #[test]
    fn discovery_rejects_a_modified_installed_manifest() {
        let root = tempdir().unwrap();
        let manifest_bytes = serde_json::to_vec(&manifest()).unwrap();
        let bytes = archive(&[
            ("widget.json", &manifest_bytes),
            ("index.html", b"<main>Example</main>"),
        ]);
        let checksum = hex::encode(Sha256::digest(&bytes));
        install_archive(
            &bytes,
            "example_widget",
            "1.0.0",
            &checksum,
            &[WidgetPermission::WidgetDataRead],
            root.path(),
        )
        .unwrap();
        let mut changed = manifest();
        changed.name = "Changed".into();
        fs::write(
            root.path().join("example_widget/widget.json"),
            serde_json::to_vec(&changed).unwrap(),
        )
        .unwrap();
        let error = discover_installed(root.path()).remove(0).unwrap_err();
        assert!(error.contains("modified manifest"));
    }
}
