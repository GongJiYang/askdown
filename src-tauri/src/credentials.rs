//! Credentials never enter settings.json; legacy migration commits only after verification.
use crate::storage::{read_optional, replace_atomic, WRITES};
use serde_json::Value;
use std::path::Path;

const PROVIDERS: [&str; 3] = ["anthropic", "compat", "search"];

trait Credentials {
    fn get(&self, provider: &str) -> Result<Option<String>, String>;
    fn set(&self, provider: &str, value: Option<&str>) -> Result<(), String>;
}

struct Keychain;
impl Credentials for Keychain {
    fn get(&self, provider: &str) -> Result<Option<String>, String> {
        let entry = keyring::Entry::new("com.askdown.credentials", provider)
            .map_err(|error| format!("无法访问系统钥匙串：{error}"))?;
        match entry.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(format!("无法读取系统钥匙串：{error}")),
        }
    }
    fn set(&self, provider: &str, value: Option<&str>) -> Result<(), String> {
        let entry = keyring::Entry::new("com.askdown.credentials", provider)
            .map_err(|error| format!("无法访问系统钥匙串：{error}"))?;
        match value {
            Some(value) => entry
                .set_password(value)
                .map_err(|error| format!("无法保存系统钥匙串：{error}")),
            None => match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(error) => Err(format!("无法删除系统钥匙串凭据：{error}")),
            },
        }
    }
}

fn parse(content: &str) -> Result<Value, String> {
    let value: Value = serde_json::from_str(content).map_err(|error| error.to_string())?;
    if !value.is_object() {
        return Err("设置格式错误".into());
    }
    for provider in PROVIDERS {
        if let Some(entry) = value.get(provider) {
            if !entry.is_object() {
                return Err("提供商设置格式错误".into());
            }
            if let Some(key) = entry.get("apiKey") {
                if !key.is_string() {
                    return Err("API Key 必须是字符串".into());
                }
            }
        }
    }
    Ok(value)
}

fn strip_keys(value: &mut Value) {
    match value {
        Value::Object(object) => {
            object.remove("apiKey");
            for child in object.values_mut() {
                strip_keys(child);
            }
        }
        Value::Array(array) => {
            for child in array {
                strip_keys(child);
            }
        }
        _ => {}
    }
}

fn commit(path: &Path, document: &Value, store: &impl Credentials) -> Result<(), String> {
    let mut changes = Vec::new();
    // Read all prior credentials before changing any, so access denial fails closed.
    for provider in PROVIDERS {
        if let Some(value) = document
            .get(provider)
            .and_then(|entry| entry.get("apiKey"))
            .and_then(Value::as_str)
        {
            let old = store.get(provider)?;
            let next = if value.is_empty() {
                None
            } else {
                Some(value.to_owned())
            };
            changes.push((provider, old, next));
        }
    }
    let mut sanitized = document.clone();
    strip_keys(&mut sanitized);
    let bytes = serde_json::to_vec_pretty(&sanitized).map_err(|error| error.to_string())?;
    let mut attempted = 0;
    let result = (|| {
        for (provider, _, next) in &changes {
            attempted += 1;
            store.set(provider, next.as_deref())?;
            if store.get(provider)? != *next {
                return Err("系统钥匙串写入验证失败".to_string());
            }
        }
        replace_atomic(path, &bytes).map_err(|error| error.to_string())
    })();
    if let Err(mut error) = result {
        // Settings remain unchanged until all entries have been read back successfully.
        // Best-effort rollback also preserves previous keys on ordinary save failures.
        for (provider, old, _) in changes[..attempted].iter().rev() {
            if store.set(provider, old.as_deref()).is_err() {
                error.push_str("；钥匙串回滚失败，原设置文件中的凭据仍保留（如有）");
            }
        }
        return Err(error);
    }
    Ok(())
}

fn load_with(path: &Path, store: &impl Credentials) -> Result<Option<String>, String> {
    let Some(raw) = read_optional(path).map_err(|error| error.to_string())? else {
        return Ok(None);
    };
    let mut document = parse(&raw)?;
    let has_plaintext = PROVIDERS.iter().any(|provider| {
        document
            .get(provider)
            .and_then(|entry| entry.get("apiKey"))
            .is_some()
    });
    if has_plaintext {
        commit(path, &document, store)?;
    }
    strip_keys(&mut document);
    for provider in PROVIDERS {
        let key = store.get(provider)?.unwrap_or_default();
        if let Some(entry) = document.get_mut(provider).and_then(Value::as_object_mut) {
            entry.insert("apiKey".into(), Value::String(key));
        }
    }
    serde_json::to_string(&document)
        .map(Some)
        .map_err(|error| error.to_string())
}

pub(crate) fn load(path: &Path) -> Result<Option<String>, String> {
    let _guard = WRITES.lock().map_err(|_| "写入锁不可用".to_string())?;
    load_with(path, &Keychain)
}

pub(crate) fn save(path: &Path, content: &str) -> Result<(), String> {
    let _guard = WRITES.lock().map_err(|_| "写入锁不可用".to_string())?;
    commit(path, &parse(content)?, &Keychain)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    #[derive(Default)]
    struct FakeStore {
        values: RefCell<HashMap<String, String>>,
        denied: Option<&'static str>,
        deny_reads: bool,
    }
    impl Credentials for FakeStore {
        fn get(&self, provider: &str) -> Result<Option<String>, String> {
            if self.deny_reads {
                return Err("keychain unavailable".into());
            }
            Ok(self.values.borrow().get(provider).cloned())
        }
        fn set(&self, provider: &str, value: Option<&str>) -> Result<(), String> {
            if self.denied == Some(provider) {
                return Err("denied".into());
            }
            match value {
                Some(value) => {
                    self.values
                        .borrow_mut()
                        .insert(provider.into(), value.into());
                }
                None => {
                    self.values.borrow_mut().remove(provider);
                }
            }
            Ok(())
        }
    }

    #[test]
    fn migration_redacts_disk_and_hydrates_memory() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(
            &path,
            r#"{"anthropic":{"apiKey":"test-a","model":"model"},"compat":{"apiKey":"test-b"},"search":{"apiKey":"test-search","enabled":true}}"#,
        )
        .unwrap();
        let store = FakeStore::default();
        let loaded: Value =
            serde_json::from_str(&load_with(&path, &store).unwrap().unwrap()).unwrap();
        assert_eq!(loaded["anthropic"]["apiKey"], "test-a");
        assert_eq!(loaded["compat"]["apiKey"], "test-b");
        assert_eq!(loaded["search"]["apiKey"], "test-search");
        assert_eq!(loaded["search"]["enabled"], true);
        let disk = std::fs::read_to_string(&path).unwrap();
        assert!(!disk.contains("apiKey"));
        assert!(!disk.contains("test-a"));
        assert!(!disk.contains("test-search"));
        assert_eq!(
            load_with(&path, &store).unwrap().unwrap(),
            serde_json::to_string(&loaded).unwrap()
        );
    }

    #[test]
    fn partial_migration_preserves_plaintext_and_rolls_back() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let raw = r#"{"anthropic":{"apiKey":"test-a"},"compat":{"apiKey":"test-b"},"search":{"apiKey":"test-search"}}"#;
        std::fs::write(&path, raw).unwrap();
        let store = FakeStore {
            denied: Some("search"),
            ..Default::default()
        };
        store
            .values
            .borrow_mut()
            .insert("anthropic".into(), "previous".into());
        assert!(load_with(&path, &store).is_err());
        assert_eq!(std::fs::read_to_string(path).unwrap(), raw);
        assert_eq!(store.get("anthropic").unwrap().as_deref(), Some("previous"));
        assert_eq!(store.get("compat").unwrap(), None);
    }

    #[test]
    fn empty_key_deletes_and_disk_failure_restores_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let store = FakeStore::default();
        store
            .values
            .borrow_mut()
            .insert("anthropic".into(), "previous".into());
        commit(
            &path,
            &parse(r#"{"anthropic":{"apiKey":""}}"#).unwrap(),
            &store,
        )
        .unwrap();
        assert_eq!(store.get("anthropic").unwrap(), None);
        let bad_path = dir.path().join("missing/settings.json");
        assert!(commit(
            &bad_path,
            &parse(r#"{"anthropic":{"apiKey":"replacement"}}"#).unwrap(),
            &store
        )
        .is_err());
        assert_eq!(store.get("anthropic").unwrap(), None);
    }

    #[test]
    fn unavailable_keychain_does_not_redact_legacy_credentials() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        let raw = r#"{"anthropic":{"apiKey":"legacy-test"}}"#;
        std::fs::write(&path, raw).unwrap();
        let store = FakeStore {
            deny_reads: true,
            ..Default::default()
        };
        assert!(load_with(&path, &store).is_err());
        assert_eq!(std::fs::read_to_string(path).unwrap(), raw);
    }
}
