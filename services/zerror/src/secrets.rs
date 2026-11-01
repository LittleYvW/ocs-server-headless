use crate::types::{Error, Settings};
use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::{Path, PathBuf},
};
use uuid::Uuid;

pub fn random_token() -> String {
    format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple())
}

pub fn private_file(path: &Path, bytes: &[u8]) -> io::Result<Vec<u8>> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    match options.open(path) {
        Ok(mut file) => {
            file.write_all(bytes)?;
            file.sync_all()?;
        }
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => (),
        Err(e) => return Err(e),
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    fs::read(path)
}

pub struct SettingsFile {
    path: PathBuf,
    cipher: Aes256Gcm,
}

impl SettingsFile {
    pub fn open(dir: &Path) -> io::Result<(Self, Settings)> {
        let path = dir.join("settings.enc");
        let key_path = dir.join("settings.key");
        if path.exists() && !key_path.exists() {
            return Err(io::Error::other(
                "Settings key missing; restore the original key",
            ));
        }
        let random = [
            Uuid::new_v4().as_bytes().as_slice(),
            Uuid::new_v4().as_bytes().as_slice(),
        ]
        .concat();
        let key = private_file(&key_path, &random)?;
        let cipher = Aes256Gcm::new_from_slice(&key)
            .map_err(|_| io::Error::other("Invalid settings key"))?;
        let file = Self { path, cipher };
        let settings = if file.path.exists() {
            let raw: serde_json::Value = serde_json::from_slice(&fs::read(&file.path)?)?;
            if raw["version"] != 1 {
                return Err(io::Error::other("Unsupported encrypted settings"));
            }
            let decode = |name: &str| {
                STANDARD
                    .decode(raw[name].as_str().unwrap_or(""))
                    .map_err(io::Error::other)
            };
            let nonce = decode("nonce")?;
            if nonce.len() != 12 {
                return Err(io::Error::other("Invalid settings nonce"));
            }
            let bytes = file
                .cipher
                .decrypt(Nonce::from_slice(&nonce), decode("content")?.as_ref())
                .map_err(|_| {
                    io::Error::other(
                        "Settings cannot be decrypted; restore the original key and settings",
                    )
                })?;
            serde_json::from_slice::<Settings>(&bytes)?
        } else {
            let settings = Settings::default();
            file.save(&settings)
                .map_err(|_| io::Error::other("Settings write failed"))?;
            settings
        };
        settings
            .validate()
            .map_err(|_| io::Error::other("Invalid stored settings"))?;
        Ok((file, settings))
    }
    pub fn save(&self, settings: &Settings) -> Result<(), Error> {
        let nonce_bytes = Uuid::new_v4();
        let nonce = &nonce_bytes.as_bytes()[..12];
        let plain = serde_json::to_vec(settings).map_err(|_| Error::internal())?;
        let encrypted = self
            .cipher
            .encrypt(Nonce::from_slice(nonce), plain.as_ref())
            .map_err(|_| Error::internal())?;
        let body = serde_json::to_vec(&serde_json::json!({"version":1,"nonce":STANDARD.encode(nonce),"content":STANDARD.encode(encrypted)})).map_err(|_| Error::internal())?;
        let temp = self.path.with_extension(format!("{}.tmp", Uuid::new_v4()));
        let result = (|| {
            private_file(&temp, &body).map_err(|_| Error::internal())?;
            fs::rename(&temp, &self.path).map_err(|_| Error::internal())?;
            #[cfg(unix)]
            {
                fs::File::open(self.path.parent().unwrap())
                    .and_then(|f| f.sync_all())
                    .map_err(|_| Error::internal())?;
            }
            Ok(())
        })();
        let _ = fs::remove_file(temp);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_encrypted_settings_and_refuses_a_missing_or_wrong_key() {
        let dir = std::env::temp_dir().join(format!("zerror-secrets-{}", Uuid::new_v4()));
        fs::create_dir(&dir).unwrap();
        let (file, mut settings) = SettingsFile::open(&dir).unwrap();
        settings.model.api_key = "private-key-marker".into();
        file.save(&settings).unwrap();
        assert!(!fs::read_to_string(dir.join("settings.enc"))
            .unwrap()
            .contains("private-key-marker"));
        assert_eq!(
            SettingsFile::open(&dir).unwrap().1.model.api_key,
            "private-key-marker"
        );
        let key = fs::read(dir.join("settings.key")).unwrap();
        fs::remove_file(dir.join("settings.key")).unwrap();
        assert!(SettingsFile::open(&dir).is_err());
        assert!(!dir.join("settings.key").exists());
        fs::write(dir.join("settings.key"), [0u8; 32]).unwrap();
        assert!(SettingsFile::open(&dir).is_err());
        fs::write(dir.join("settings.key"), key).unwrap();
        assert!(SettingsFile::open(&dir).is_ok());
        fs::remove_dir_all(dir).unwrap();
    }
}
