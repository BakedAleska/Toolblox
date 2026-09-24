//! Fail-closed startup update decisions.

#![cfg_attr(all(debug_assertions, not(test)), allow(dead_code))]

use std::collections::BTreeMap;
use std::fmt;

use semver::Version;
use serde::Deserialize;

/// Manifest schema version this build understands.
pub const MANIFEST_SCHEMA_VERSION: u32 = 1;
/// How far in the future a manifest's `publishedAt` may be, to tolerate slow clocks.
pub const MAX_CLOCK_SKEW_SECONDS: u64 = 300;
/// Longest allowed time between a manifest's `publishedAt` and `expiresAt`.
pub const MAX_MANIFEST_LIFETIME_SECONDS: u64 = 7 * 24 * 60 * 60;

/// The signed release manifest. Unknown fields are rejected.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseManifest {
    pub schema_version: u32,
    pub channel: String,
    pub version: Version,
    /// Unix time the manifest was signed.
    pub published_at: u64,
    /// Unix time after which the manifest is refused.
    pub expires_at: u64,
    /// Installers keyed by Tauri updater target, such as `windows-x86_64`.
    pub platforms: BTreeMap<String, UpdateArtifact>,
}

/// One platform's installer.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateArtifact {
    /// HTTPS download URL.
    pub url: String,
    /// Lowercase hex SHA-256 of the installer.
    pub sha256: String,
    /// Tauri updater signature of the installer.
    pub signature: String,
}

/// A manifest whose signature has been checked. Only `verify_and_parse` creates one.
pub struct VerifiedManifest(ReleaseManifest);

impl VerifiedManifest {
    /// Returns the verified manifest.
    pub fn manifest(&self) -> &ReleaseManifest {
        &self.0
    }
}

/// Checks a detached manifest signature.
pub trait ManifestSignatureVerifier {
    /// Fails unless `detached_signature` signs exactly `manifest_bytes`.
    fn verify(&self, manifest_bytes: &[u8], detached_signature: &[u8]) -> Result<(), String>;
}

/// Persists the highest verified release version.
pub trait HighestSeenStore {
    /// Returns the stored version, or `None` when none is stored.
    fn load(&self) -> Result<Option<Version>, String>;
    /// Replaces the stored version.
    fn store(&self, version: &Version) -> Result<(), String>;
}

/// The installed app's state, used to judge a manifest.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReleaseContext<'a> {
    pub installed: &'a Version,
    pub channel: &'a str,
    /// Tauri updater target of this build.
    pub target: &'a str,
    /// Current Unix time.
    pub now: u64,
    /// Highest version verified before, which the manifest may not go below.
    pub highest_seen: Option<&'a Version>,
}

/// What a valid manifest means for this install.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReleaseDecision {
    /// The installed version is current; the app may open.
    Current { version: Version },
    /// A newer version must be installed before the app opens.
    UpdateRequired {
        version: Version,
        artifact: UpdateArtifact,
    },
}

/// Why a manifest was refused. Displays as a user-facing message.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReleaseError {
    BadSignature,
    InvalidManifest(String),
    UnsupportedSchema(u32),
    WrongChannel { expected: String, found: String },
    MissingTarget(String),
    NotYetValid,
    Expired,
    ExcessiveLifetime,
    Rollback { floor: Version, found: Version },
    Persistence(String),
}

impl fmt::Display for ReleaseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        let message = match self {
            Self::BadSignature => "The update information couldn't be verified. Try again?".into(),
            Self::InvalidManifest(reason) => {
                format!("The update information is invalid ({reason}). Try again?")
            }
            Self::UnsupportedSchema(version) => format!(
                "This updater can't read update format {version}. Would reinstalling Toolblox help?"
            ),
            Self::WrongChannel { expected, found } => format!(
                "The update channel is {found}, not {expected}. Would reinstalling Toolblox help?"
            ),
            Self::MissingTarget(target) => {
                format!("No update is available for {target}. Would reinstalling Toolblox help?")
            }
            Self::NotYetValid => {
                "The update information is dated in the future. Is the system clock correct?".into()
            }
            Self::Expired => {
                "The update information has expired. Check the connection and try again?".into()
            }
            Self::ExcessiveLifetime => {
                "The update information is valid for too long. Try again?".into()
            }
            Self::Rollback { .. } => {
                "The update service offered an older release. Try again later?".into()
            }
            Self::Persistence(reason) => {
                format!("The verified version couldn't be saved ({reason}). Try again?")
            }
        };
        formatter.write_str(&message)
    }
}

impl std::error::Error for ReleaseError {}

/// Verifies the signature before parsing, so unsigned bytes are never interpreted.
pub fn verify_and_parse(
    manifest_bytes: &[u8],
    detached_signature: &[u8],
    verifier: &impl ManifestSignatureVerifier,
) -> Result<VerifiedManifest, ReleaseError> {
    verifier
        .verify(manifest_bytes, detached_signature)
        .map_err(|_| ReleaseError::BadSignature)?;
    let manifest = serde_json::from_slice(manifest_bytes)
        .map_err(|error| ReleaseError::InvalidManifest(error.to_string()))?;
    Ok(VerifiedManifest(manifest))
}

/// Judges a verified manifest: checks the schema, channel, validity window, lifetime, rollback
/// floor, and this platform's artifact, then compares versions.
///
/// Only an exact version match admits the app. An older manifest is a rollback error.
pub fn decide_release(
    verified: &VerifiedManifest,
    context: &ReleaseContext<'_>,
) -> Result<ReleaseDecision, ReleaseError> {
    let manifest = verified.manifest();
    if manifest.schema_version != MANIFEST_SCHEMA_VERSION {
        return Err(ReleaseError::UnsupportedSchema(manifest.schema_version));
    }
    if manifest.channel != context.channel {
        return Err(ReleaseError::WrongChannel {
            expected: context.channel.into(),
            found: manifest.channel.clone(),
        });
    }
    if manifest.published_at > context.now.saturating_add(MAX_CLOCK_SKEW_SECONDS) {
        return Err(ReleaseError::NotYetValid);
    }
    if manifest.expires_at <= context.now {
        return Err(ReleaseError::Expired);
    }
    if manifest.expires_at <= manifest.published_at
        || manifest.expires_at - manifest.published_at > MAX_MANIFEST_LIFETIME_SECONDS
    {
        return Err(ReleaseError::ExcessiveLifetime);
    }

    let floor = context
        .highest_seen
        .filter(|seen| *seen > context.installed)
        .unwrap_or(context.installed);
    if &manifest.version < floor {
        return Err(ReleaseError::Rollback {
            floor: floor.clone(),
            found: manifest.version.clone(),
        });
    }

    validate_artifact(
        manifest
            .platforms
            .get(context.target)
            .ok_or_else(|| ReleaseError::MissingTarget(context.target.into()))?,
    )?;

    if manifest.version == *context.installed {
        return Ok(ReleaseDecision::Current {
            version: manifest.version.clone(),
        });
    }
    if manifest.version < *context.installed {
        return Err(ReleaseError::Rollback {
            floor: context.installed.clone(),
            found: manifest.version.clone(),
        });
    }

    Ok(ReleaseDecision::UpdateRequired {
        version: manifest.version.clone(),
        artifact: manifest.platforms[context.target].clone(),
    })
}

/// Runs `decide_release` with the stored highest version and records a newer verified version,
/// even when an update is then required.
pub fn decide_and_record(
    verified: &VerifiedManifest,
    installed: &Version,
    channel: &str,
    target: &str,
    now: u64,
    store: &impl HighestSeenStore,
) -> Result<ReleaseDecision, ReleaseError> {
    let highest_seen = store.load().map_err(ReleaseError::Persistence)?;
    let decision = decide_release(
        verified,
        &ReleaseContext {
            installed,
            channel,
            target,
            now,
            highest_seen: highest_seen.as_ref(),
        },
    )?;
    let verified_version = &verified.manifest().version;
    if highest_seen
        .as_ref()
        .is_none_or(|seen| verified_version > seen)
    {
        store
            .store(verified_version)
            .map_err(ReleaseError::Persistence)?;
    }
    Ok(decision)
}

/// Requires an HTTPS URL, a 64-character hex SHA-256, and a non-empty signature.
fn validate_artifact(artifact: &UpdateArtifact) -> Result<(), ReleaseError> {
    if !artifact.url.starts_with("https://") {
        return Err(ReleaseError::InvalidManifest(
            "the artifact URL isn't HTTPS".into(),
        ));
    }
    if artifact.sha256.len() != 64 || !artifact.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err(ReleaseError::InvalidManifest(
            "the artifact SHA-256 is malformed".into(),
        ));
    }
    if artifact.signature.trim().is_empty() {
        return Err(ReleaseError::InvalidManifest(
            "the updater signature is missing".into(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;

    use super::*;

    struct AcceptSignature;

    impl ManifestSignatureVerifier for AcceptSignature {
        fn verify(&self, _: &[u8], _: &[u8]) -> Result<(), String> {
            Ok(())
        }
    }

    #[derive(Default)]
    struct MemoryStore(RefCell<Option<Version>>);

    impl HighestSeenStore for MemoryStore {
        fn load(&self) -> Result<Option<Version>, String> {
            Ok(self.0.borrow().clone())
        }

        fn store(&self, version: &Version) -> Result<(), String> {
            self.0.replace(Some(version.clone()));
            Ok(())
        }
    }

    fn manifest(version: &str) -> VerifiedManifest {
        let json = format!(
            r#"{{"schemaVersion":1,"channel":"stable","version":"{version}","publishedAt":1000,"expiresAt":2000,"platforms":{{"windows-x86_64":{{"url":"https://example.test/update.zip","sha256":"{}","signature":"signed"}}}}}}"#,
            "a".repeat(64)
        );
        verify_and_parse(json.as_bytes(), b"signature", &AcceptSignature).unwrap()
    }

    fn version(value: &str) -> Version {
        Version::parse(value).unwrap()
    }

    #[test]
    fn current_release_is_the_only_release_decision_that_admits_the_ui() {
        let current = ReleaseDecision::Current {
            version: version("1.1.0"),
        };
        let update = ReleaseDecision::UpdateRequired {
            version: version("1.1.0"),
            artifact: manifest("1.1.0").manifest().platforms["windows-x86_64"].clone(),
        };
        assert!(matches!(current, ReleaseDecision::Current { .. }));
        assert!(!matches!(update, ReleaseDecision::Current { .. }));
    }

    #[test]
    fn expired_and_rollback_manifests_fail_closed() {
        let release = manifest("1.1.0");
        let expired = decide_release(
            &release,
            &ReleaseContext {
                installed: &version("1.0.0"),
                channel: "stable",
                target: "windows-x86_64",
                now: 2000,
                highest_seen: None,
            },
        );
        assert_eq!(expired, Err(ReleaseError::Expired));

        let installed = version("1.0.0");
        let highest = version("1.2.0");
        let rollback = decide_release(
            &release,
            &ReleaseContext {
                installed: &installed,
                channel: "stable",
                target: "windows-x86_64",
                now: 1500,
                highest_seen: Some(&highest),
            },
        );
        assert!(matches!(rollback, Err(ReleaseError::Rollback { .. })));
    }

    #[test]
    fn valid_new_release_is_recorded_before_installation() {
        let store = MemoryStore::default();
        let decision = decide_and_record(
            &manifest("1.1.0"),
            &version("1.0.0"),
            "stable",
            "windows-x86_64",
            1500,
            &store,
        )
        .unwrap();
        assert!(matches!(decision, ReleaseDecision::UpdateRequired { .. }));
        assert_eq!(store.load().unwrap(), Some(version("1.1.0")));
    }

    #[test]
    fn bad_signature_is_rejected_before_json_parsing() {
        struct RejectSignature;
        impl ManifestSignatureVerifier for RejectSignature {
            fn verify(&self, _: &[u8], _: &[u8]) -> Result<(), String> {
                Err("secret verifier detail".into())
            }
        }

        assert!(matches!(
            verify_and_parse(b"not json", b"bad", &RejectSignature),
            Err(ReleaseError::BadSignature)
        ));
    }
}
