use crate::crypto::validate_client_id;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fmt;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use tokio::sync::RwLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClientStatus {
    Pending,
    Approved,
    Revoked,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SlotMeta {
    pub updated_at: DateTime<Utc>,
    pub version: u64,
    #[serde(default)]
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClientRecord {
    pub client_id: String,
    pub status: ClientStatus,
    pub label: Option<String>,
    pub created_at: DateTime<Utc>,
    pub approved_at: Option<DateTime<Utc>>,
    pub last_seen_at: DateTime<Utc>,
    pub request_count: u64,
    #[serde(default)]
    pub slots: BTreeMap<u32, SlotMeta>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredBlob {
    pub slot: u32,
    pub encrypted: String,
    pub updated_at: DateTime<Utc>,
    pub version: u64,
}

#[derive(Debug)]
pub enum StorageError {
    InvalidClientId,
    ClientNotFound,
    PendingQueueFull,
    SlotOutOfRange,
    VersionConflict { current_version: u64 },
    MaxSlotsExceeded { max_slots: usize },
    StorageQuotaExceeded { max_bytes: u64 },
    Io(std::io::Error),
    Serde(serde_json::Error),
}

impl fmt::Display for StorageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StorageError::InvalidClientId => write!(f, "invalid client_id format"),
            StorageError::ClientNotFound => write!(f, "client not found"),
            StorageError::PendingQueueFull => write!(f, "pending client queue is full"),
            StorageError::SlotOutOfRange => write!(f, "slot index exceeds maximum allowed"),
            StorageError::VersionConflict { current_version } => {
                write!(f, "version conflict (current version is {current_version})")
            }
            StorageError::MaxSlotsExceeded { max_slots } => {
                write!(f, "per-client slot limit ({max_slots}) exceeded")
            }
            StorageError::StorageQuotaExceeded { max_bytes } => {
                write!(f, "per-client storage quota ({max_bytes} bytes) exceeded")
            }
            StorageError::Io(e) => write!(f, "storage I/O error: {e}"),
            StorageError::Serde(e) => write!(f, "storage serialization error: {e}"),
        }
    }
}

impl std::error::Error for StorageError {}

impl From<std::io::Error> for StorageError {
    fn from(e: std::io::Error) -> Self {
        StorageError::Io(e)
    }
}

impl From<serde_json::Error> for StorageError {
    fn from(e: serde_json::Error) -> Self {
        StorageError::Serde(e)
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct RegistryFile {
    clients: BTreeMap<String, ClientRecord>,
}

pub struct Storage {
    data_dir: PathBuf,
    blobs_dir: PathBuf,
    registry_path: PathBuf,
    max_pending: usize,
    max_slot: u32,
    max_slots_per_client: Option<usize>,
    max_client_storage_bytes: Option<u64>,
    registry: RwLock<BTreeMap<String, ClientRecord>>,
}

impl Storage {
    pub fn load_or_init(
        data_dir: PathBuf,
        max_pending: usize,
        max_slot: u32,
        max_slots_per_client: Option<usize>,
        max_client_storage_bytes: Option<u64>,
    ) -> Result<Self, StorageError> {
        let blobs_dir = data_dir.join("blobs");
        fs::create_dir_all(&blobs_dir)?;
        let registry_path = data_dir.join("clients.json");

        let mut clients = if registry_path.exists() {
            let content = fs::read_to_string(&registry_path)?;
            let parsed: RegistryFile = serde_json::from_str(&content)?;
            parsed.clients
        } else {
            BTreeMap::new()
        };

        // Reconcile slot versions from blob files in case of a crash between
        // writing a slot blob and updating clients.json.
        for (client_id, record) in clients.iter_mut() {
            let client_dir = blobs_dir.join(client_id);
            if let Ok(entries) = fs::read_dir(&client_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.extension().and_then(|e| e.to_str()) != Some("json") {
                        continue;
                    }
                    if let Ok(raw) = fs::read_to_string(&path) {
                        if let Ok(blob) = serde_json::from_str::<StoredBlob>(&raw) {
                            let needs_update = record
                                .slots
                                .get(&blob.slot)
                                .map_or(true, |m| blob.version > m.version);
                            if needs_update {
                                record.slots.insert(
                                    blob.slot,
                                    SlotMeta {
                                        updated_at: blob.updated_at,
                                        version: blob.version,
                                        size_bytes: blob.encrypted.len() as u64,
                                    },
                                );
                            }
                        }
                    }
                }
            }
        }

        Ok(Self {
            data_dir,
            blobs_dir,
            registry_path,
            max_pending,
            max_slot,
            max_slots_per_client,
            max_client_storage_bytes,
            registry: RwLock::new(clients),
        })
    }

    fn client_dir(&self, client_id: &str) -> Result<PathBuf, StorageError> {
        if !validate_client_id(client_id) {
            return Err(StorageError::InvalidClientId);
        }
        Ok(self.blobs_dir.join(client_id))
    }

    fn slot_path(&self, client_id: &str, slot: u32) -> Result<PathBuf, StorageError> {
        if slot > self.max_slot {
            return Err(StorageError::SlotOutOfRange);
        }
        Ok(self.client_dir(client_id)?.join(format!("{slot}.json")))
    }

    fn save_registry_locked(&self, clients: &BTreeMap<String, ClientRecord>) -> Result<(), StorageError> {
        let wrapper = RegistryFile {
            clients: clients.clone(),
        };
        let json = serde_json::to_vec_pretty(&wrapper)?;
        atomic_write(&self.registry_path, &json)?;
        Ok(())
    }

    /// Check client authorization status. If unknown and `auto_register_pending` is true,
    /// records the client as `Pending` (subject to `max_pending`).
    pub async fn check_or_register_client(
        &self,
        client_id: &str,
        auto_register_pending: bool,
    ) -> Result<Option<ClientStatus>, StorageError> {
        if !validate_client_id(client_id) {
            return Err(StorageError::InvalidClientId);
        }

        let now = Utc::now();
        let mut reg = self.registry.write().await;

        if let Some(record) = reg.get_mut(client_id) {
            record.last_seen_at = now;
            record.request_count = record.request_count.saturating_add(1);
            return Ok(Some(record.status));
        }

        if !auto_register_pending {
            return Ok(None);
        }

        let pending_count = reg
            .values()
            .filter(|c| c.status == ClientStatus::Pending)
            .count();
        if pending_count >= self.max_pending {
            return Err(StorageError::PendingQueueFull);
        }

        let record = ClientRecord {
            client_id: client_id.to_string(),
            status: ClientStatus::Pending,
            label: None,
            created_at: now,
            approved_at: None,
            last_seen_at: now,
            request_count: 1,
            slots: BTreeMap::new(),
        };
        reg.insert(client_id.to_string(), record);
        self.save_registry_locked(&reg)?;
        Ok(Some(ClientStatus::Pending))
    }

    pub async fn get_blob(&self, client_id: &str, slot: u32) -> Result<Option<StoredBlob>, StorageError> {
        let path = self.slot_path(client_id, slot)?;
        if !path.exists() {
            return Ok(None);
        }
        let content = fs::read_to_string(path)?;
        let blob: StoredBlob = serde_json::from_str(&content)?;
        Ok(Some(blob))
    }

    pub async fn put_blob(
        &self,
        client_id: &str,
        slot: u32,
        expected_version: u64,
        encrypted: String,
    ) -> Result<StoredBlob, StorageError> {
        let client_dir = self.client_dir(client_id)?;
        let path = self.slot_path(client_id, slot)?;
        let now = Utc::now();
        let new_size = encrypted.len() as u64;

        let mut reg = self.registry.write().await;
        let record = reg.get_mut(client_id).ok_or(StorageError::ClientNotFound)?;

        let current_version = record.slots.get(&slot).map_or(0, |m| m.version);
        if current_version != expected_version {
            return Err(StorageError::VersionConflict { current_version });
        }

        if let Some(max_slots) = self.max_slots_per_client {
            if !record.slots.contains_key(&slot) && record.slots.len() >= max_slots {
                return Err(StorageError::MaxSlotsExceeded { max_slots });
            }
        }

        if let Some(max_bytes) = self.max_client_storage_bytes {
            let other_bytes: u64 = record
                .slots
                .iter()
                .filter(|(&k, _)| k != slot)
                .map(|(_, m)| m.size_bytes)
                .sum();
            if other_bytes.saturating_add(new_size) > max_bytes {
                return Err(StorageError::StorageQuotaExceeded { max_bytes });
            }
        }

        fs::create_dir_all(&client_dir)?;
        let next_version = current_version.saturating_add(1);

        let blob = StoredBlob {
            slot,
            encrypted,
            updated_at: now,
            version: next_version,
        };
        let blob_bytes = serde_json::to_vec(&blob)?;
        atomic_write(&path, &blob_bytes)?;

        record.slots.insert(
            slot,
            SlotMeta {
                updated_at: now,
                version: next_version,
                size_bytes: new_size,
            },
        );
        self.save_registry_locked(&reg)?;

        Ok(blob)
    }

    pub async fn delete_slot(&self, client_id: &str, slot: u32) -> Result<bool, StorageError> {
        let path = self.slot_path(client_id, slot)?;
        let mut reg = self.registry.write().await;
        let record = reg.get_mut(client_id).ok_or(StorageError::ClientNotFound)?;
        let removed_meta = record.slots.remove(&slot).is_some();
        let file_existed = path.exists();
        if file_existed {
            fs::remove_file(path)?;
        }
        if removed_meta {
            self.save_registry_locked(&reg)?;
        }
        Ok(removed_meta || file_existed)
    }

    pub async fn list_client_slots(
        &self,
        client_id: &str,
    ) -> Result<BTreeMap<u32, SlotMeta>, StorageError> {
        if !validate_client_id(client_id) {
            return Err(StorageError::InvalidClientId);
        }
        let reg = self.registry.read().await;
        let record = reg.get(client_id).ok_or(StorageError::ClientNotFound)?;
        Ok(record.slots.clone())
    }

    pub async fn list_clients(&self, status_filter: Option<ClientStatus>) -> Vec<ClientRecord> {
        let reg = self.registry.read().await;
        reg.values()
            .filter(|r| status_filter.map_or(true, |s| r.status == s))
            .cloned()
            .collect()
    }

    pub async fn preauthorize_client(
        &self,
        client_id: &str,
        label: Option<String>,
    ) -> Result<ClientRecord, StorageError> {
        if !validate_client_id(client_id) {
            return Err(StorageError::InvalidClientId);
        }

        let now = Utc::now();
        let mut reg = self.registry.write().await;
        let record = reg
            .entry(client_id.to_string())
            .and_modify(|r| {
                r.status = ClientStatus::Approved;
                r.approved_at = Some(now);
                if label.is_some() {
                    r.label = label.clone();
                }
            })
            .or_insert_with(|| ClientRecord {
                client_id: client_id.to_string(),
                status: ClientStatus::Approved,
                label,
                created_at: now,
                approved_at: Some(now),
                last_seen_at: now,
                request_count: 0,
                slots: BTreeMap::new(),
            })
            .clone();

        self.save_registry_locked(&reg)?;
        Ok(record)
    }

    pub async fn approve_client(
        &self,
        client_id: &str,
        label: Option<String>,
    ) -> Result<ClientRecord, StorageError> {
        if !validate_client_id(client_id) {
            return Err(StorageError::InvalidClientId);
        }

        let now = Utc::now();
        let mut reg = self.registry.write().await;
        let record = reg.get_mut(client_id).ok_or(StorageError::ClientNotFound)?;
        record.status = ClientStatus::Approved;
        record.approved_at = Some(now);
        if label.is_some() {
            record.label = label;
        }
        let cloned = record.clone();
        self.save_registry_locked(&reg)?;
        Ok(cloned)
    }

    pub async fn revoke_client(&self, client_id: &str) -> Result<ClientRecord, StorageError> {
        if !validate_client_id(client_id) {
            return Err(StorageError::InvalidClientId);
        }

        let mut reg = self.registry.write().await;
        let record = reg.get_mut(client_id).ok_or(StorageError::ClientNotFound)?;
        record.status = ClientStatus::Revoked;
        let cloned = record.clone();
        self.save_registry_locked(&reg)?;
        Ok(cloned)
    }

    pub async fn delete_client(&self, client_id: &str) -> Result<bool, StorageError> {
        let client_dir = self.client_dir(client_id)?;
        let mut reg = self.registry.write().await;
        let removed = reg.remove(client_id).is_some();
        if removed {
            self.save_registry_locked(&reg)?;
            if client_dir.exists() {
                fs::remove_dir_all(client_dir)?;
            }
        }
        Ok(removed)
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }
}

fn atomic_write(target: &Path, data: &[u8]) -> Result<(), std::io::Error> {
    let tmp_name = format!(
        ".{}.tmp.{}",
        target
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("file"),
        std::process::id()
    );
    let tmp_path = target.with_file_name(tmp_name);
    {
        let mut file = File::create(&tmp_path)?;
        file.write_all(data)?;
        file.sync_all()?;
    }
    fs::rename(&tmp_path, target)?;
    Ok(())
}
