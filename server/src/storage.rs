use crate::crypto::validate_client_id;
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fmt;
use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClientStatus {
    Pending,
    Approved,
    Revoked,
}

impl ClientStatus {
    fn as_str(self) -> &'static str {
        match self {
            ClientStatus::Pending => "pending",
            ClientStatus::Approved => "approved",
            ClientStatus::Revoked => "revoked",
        }
    }

    fn from_db(s: &str) -> Result<Self, rusqlite::Error> {
        match s {
            "pending" => Ok(ClientStatus::Pending),
            "approved" => Ok(ClientStatus::Approved),
            "revoked" => Ok(ClientStatus::Revoked),
            other => Err(rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Text,
                format!("invalid client status: {other}").into(),
            )),
        }
    }
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
    AlreadyLocked(PathBuf),
    Io(std::io::Error),
    Sqlite(rusqlite::Error),
    TaskJoin(tokio::task::JoinError),
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
            StorageError::AlreadyLocked(path) => {
                write!(
                    f,
                    "data directory is already locked by another server instance ({})",
                    path.display()
                )
            }
            StorageError::Io(e) => write!(f, "storage I/O error: {e}"),
            StorageError::Sqlite(e) => write!(f, "storage database error: {e}"),
            StorageError::TaskJoin(e) => write!(f, "storage task join error: {e}"),
        }
    }
}

impl std::error::Error for StorageError {}

impl From<std::io::Error> for StorageError {
    fn from(e: std::io::Error) -> Self {
        StorageError::Io(e)
    }
}

impl From<rusqlite::Error> for StorageError {
    fn from(e: rusqlite::Error) -> Self {
        StorageError::Sqlite(e)
    }
}

impl From<tokio::task::JoinError> for StorageError {
    fn from(e: tokio::task::JoinError) -> Self {
        StorageError::TaskJoin(e)
    }
}

const DB_SCHEMA_VERSION: u32 = 1;
const DB_FILE_NAME: &str = "cloudcookie.db";

pub struct Storage {
    data_dir: PathBuf,
    db_path: PathBuf,
    max_pending: usize,
    max_slot: u32,
    max_slots_per_client: Option<usize>,
    max_client_storage_bytes: Option<u64>,
    _lock_file: File,
    write_conn: Arc<Mutex<Connection>>,
    read_conn: Arc<Mutex<Connection>>,
}

impl Storage {
    pub fn load_or_init(
        data_dir: PathBuf,
        max_pending: usize,
        max_slot: u32,
        max_slots_per_client: Option<usize>,
        max_client_storage_bytes: Option<u64>,
    ) -> Result<Self, StorageError> {
        create_dir_all_private(&data_dir)?;

        let lock_path = data_dir.join(".lock");
        let mut lock_opts = OpenOptions::new();
        lock_opts.create(true).read(true).write(true).truncate(false);
        #[cfg(unix)]
        lock_opts.mode(0o600);
        let mut lock_file = lock_opts.open(&lock_path)?;
        set_private_file_permissions(&lock_path)?;
        if let Err(err) = lock_file.try_lock() {
            return match err {
                TryLockError::WouldBlock => Err(StorageError::AlreadyLocked(lock_path)),
                TryLockError::Error(io_err) => Err(StorageError::Io(io_err)),
            };
        }
        let _ = lock_file.set_len(0);
        let _ = writeln!(lock_file, "{}", std::process::id());

        let db_path = data_dir.join(DB_FILE_NAME);
        let write_conn = Connection::open_with_flags(
            &db_path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        set_private_file_permissions(&db_path)?;

        configure_connection(&write_conn, false)?;
        init_schema(&write_conn)?;
        maybe_migrate_legacy_json(&data_dir, &write_conn)?;

        let read_conn = Connection::open_with_flags(
            &db_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        configure_connection(&read_conn, true)?;

        Ok(Self {
            data_dir,
            db_path,
            max_pending,
            max_slot,
            max_slots_per_client,
            max_client_storage_bytes,
            _lock_file: lock_file,
            write_conn: Arc::new(Mutex::new(write_conn)),
            read_conn: Arc::new(Mutex::new(read_conn)),
        })
    }

    async fn with_write_conn<F, R>(&self, f: F) -> Result<R, StorageError>
    where
        F: FnOnce(&mut Connection) -> Result<R, StorageError> + Send + 'static,
        R: Send + 'static,
    {
        let conn = Arc::clone(&self.write_conn);
        tokio::task::spawn_blocking(move || {
            let mut guard = conn.lock().expect("write connection mutex poisoned");
            f(&mut guard)
        })
        .await?
    }

    async fn with_read_conn<F, R>(&self, f: F) -> Result<R, StorageError>
    where
        F: FnOnce(&Connection) -> Result<R, StorageError> + Send + 'static,
        R: Send + 'static,
    {
        let conn = Arc::clone(&self.read_conn);
        tokio::task::spawn_blocking(move || {
            let guard = conn.lock().expect("read connection mutex poisoned");
            f(&guard)
        })
        .await?
    }

    /// Check client authorization status.
    /// - If `public_mode` is true, unknown clients are automatically registered as `Approved`.
    /// - Otherwise, if `auto_register_pending` is true, unknown clients are recorded as `Pending`
    ///   (subject to `max_pending`).
    pub async fn check_or_register_client(
        &self,
        client_id: &str,
        auto_register_pending: bool,
        public_mode: bool,
    ) -> Result<Option<ClientStatus>, StorageError> {
        if !validate_client_id(client_id) {
            return Err(StorageError::InvalidClientId);
        }

        let client_id = client_id.to_string();
        let max_pending = self.max_pending;
        let now = Utc::now().to_rfc3339();

        self.with_write_conn(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let existing_status: Option<String> = tx
                .query_row(
                    "UPDATE clients
                     SET last_seen_at = ?1, request_count = request_count + 1
                     WHERE client_id = ?2
                     RETURNING status",
                    params![now, client_id],
                    |row| row.get(0),
                )
                .optional()?;

            if let Some(status_str) = existing_status {
                let status = ClientStatus::from_db(&status_str)?;
                tx.commit()?;
                return Ok(Some(status));
            }

            if public_mode {
                tx.execute(
                    "INSERT INTO clients
                     (client_id, status, label, created_at, approved_at, last_seen_at, request_count)
                     VALUES (?1, 'approved', NULL, ?2, ?2, ?2, 1)",
                    params![client_id, now],
                )?;
                tx.commit()?;
                return Ok(Some(ClientStatus::Approved));
            }

            if !auto_register_pending {
                return Ok(None);
            }

            let pending_count: i64 = tx.query_row(
                "SELECT COUNT(*) FROM clients WHERE status = 'pending'",
                [],
                |row| row.get(0),
            )?;
            if pending_count as usize >= max_pending {
                return Err(StorageError::PendingQueueFull);
            }

            tx.execute(
                "INSERT INTO clients
                 (client_id, status, label, created_at, approved_at, last_seen_at, request_count)
                 VALUES (?1, 'pending', NULL, ?2, NULL, ?2, 1)",
                params![client_id, now],
            )?;
            tx.commit()?;
            Ok(Some(ClientStatus::Pending))
        })
        .await
    }

    pub async fn get_blob(
        &self,
        client_id: &str,
        slot: u32,
    ) -> Result<Option<StoredBlob>, StorageError> {
        if !validate_client_id(client_id) {
            return Err(StorageError::InvalidClientId);
        }
        if slot > self.max_slot {
            return Err(StorageError::SlotOutOfRange);
        }

        let client_id = client_id.to_string();
        self.with_read_conn(move |conn| {
            let row = conn
                .query_row(
                    "SELECT encrypted, updated_at, version
                     FROM slots
                     WHERE client_id = ?1 AND slot = ?2",
                    params![client_id, slot],
                    |row| {
                        let encrypted: String = row.get(0)?;
                        let updated_at_str: String = row.get(1)?;
                        let version: i64 = row.get(2)?;
                        Ok((encrypted, updated_at_str, version))
                    },
                )
                .optional()?;

            match row {
                Some((encrypted, updated_at_str, version)) => Ok(Some(StoredBlob {
                    slot,
                    encrypted,
                    updated_at: parse_rfc3339(&updated_at_str)?,
                    version: u64::try_from(version).unwrap_or(0),
                })),
                None => Ok(None),
            }
        })
        .await
    }

    pub async fn put_blob(
        &self,
        client_id: &str,
        slot: u32,
        expected_version: u64,
        encrypted: String,
    ) -> Result<StoredBlob, StorageError> {
        if !validate_client_id(client_id) {
            return Err(StorageError::InvalidClientId);
        }
        if slot > self.max_slot {
            return Err(StorageError::SlotOutOfRange);
        }

        let client_id = client_id.to_string();
        let max_slots_per_client = self.max_slots_per_client;
        let max_client_storage_bytes = self.max_client_storage_bytes;
        let now = Utc::now();
        let now_str = now.to_rfc3339();
        let new_size = encrypted.len() as u64;

        self.with_write_conn(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;

            let client_exists: Option<i64> = tx
                .query_row(
                    "SELECT 1 FROM clients WHERE client_id = ?1",
                    params![client_id],
                    |row| row.get(0),
                )
                .optional()?;
            if client_exists.is_none() {
                return Err(StorageError::ClientNotFound);
            }

            let current_version: u64 = tx
                .query_row(
                    "SELECT version FROM slots WHERE client_id = ?1 AND slot = ?2",
                    params![client_id, slot],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?
                .map(|v| u64::try_from(v).unwrap_or(0))
                .unwrap_or(0);

            if current_version != expected_version {
                return Err(StorageError::VersionConflict { current_version });
            }

            if let Some(max_slots) = max_slots_per_client {
                if current_version == 0 {
                    let existing_count: i64 = tx.query_row(
                        "SELECT COUNT(*) FROM slots WHERE client_id = ?1",
                        params![client_id],
                        |row| row.get(0),
                    )?;
                    if existing_count as usize >= max_slots {
                        return Err(StorageError::MaxSlotsExceeded { max_slots });
                    }
                }
            }

            if let Some(max_bytes) = max_client_storage_bytes {
                let other_bytes: i64 = tx.query_row(
                    "SELECT COALESCE(SUM(size_bytes), 0)
                     FROM slots
                     WHERE client_id = ?1 AND slot != ?2",
                    params![client_id, slot],
                    |row| row.get(0),
                )?;
                let other_bytes_u64 = u64::try_from(other_bytes).unwrap_or(0);
                if other_bytes_u64.saturating_add(new_size) > max_bytes {
                    return Err(StorageError::StorageQuotaExceeded { max_bytes });
                }
            }

            let next_version = current_version.saturating_add(1);
            let next_version_i64 = i64::try_from(next_version).unwrap_or(i64::MAX);
            let new_size_i64 = i64::try_from(new_size).unwrap_or(i64::MAX);

            tx.execute(
                "INSERT INTO slots (client_id, slot, version, updated_at, size_bytes, encrypted)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(client_id, slot) DO UPDATE SET
                     version = excluded.version,
                     updated_at = excluded.updated_at,
                     size_bytes = excluded.size_bytes,
                     encrypted = excluded.encrypted",
                params![
                    client_id,
                    slot,
                    next_version_i64,
                    now_str,
                    new_size_i64,
                    encrypted
                ],
            )?;
            tx.commit()?;

            Ok(StoredBlob {
                slot,
                encrypted,
                updated_at: now,
                version: next_version,
            })
        })
        .await
    }

    pub async fn delete_slot(&self, client_id: &str, slot: u32) -> Result<bool, StorageError> {
        if !validate_client_id(client_id) {
            return Err(StorageError::InvalidClientId);
        }
        if slot > self.max_slot {
            return Err(StorageError::SlotOutOfRange);
        }

        let client_id = client_id.to_string();
        self.with_write_conn(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let client_exists: Option<i64> = tx
                .query_row(
                    "SELECT 1 FROM clients WHERE client_id = ?1",
                    params![client_id],
                    |row| row.get(0),
                )
                .optional()?;
            if client_exists.is_none() {
                return Err(StorageError::ClientNotFound);
            }

            let affected = tx.execute(
                "DELETE FROM slots WHERE client_id = ?1 AND slot = ?2",
                params![client_id, slot],
            )?;
            tx.commit()?;
            Ok(affected > 0)
        })
        .await
    }

    pub async fn list_client_slots(
        &self,
        client_id: &str,
    ) -> Result<BTreeMap<u32, SlotMeta>, StorageError> {
        if !validate_client_id(client_id) {
            return Err(StorageError::InvalidClientId);
        }

        let client_id = client_id.to_string();
        self.with_read_conn(move |conn| {
            let client_exists: Option<i64> = conn
                .query_row(
                    "SELECT 1 FROM clients WHERE client_id = ?1",
                    params![client_id],
                    |row| row.get(0),
                )
                .optional()?;
            if client_exists.is_none() {
                return Err(StorageError::ClientNotFound);
            }

            load_client_slots(conn, &client_id)
        })
        .await
    }

    pub async fn list_clients(&self, status_filter: Option<ClientStatus>) -> Vec<ClientRecord> {
        self.with_read_conn(move |conn| {
            let mut clients = BTreeMap::<String, ClientRecord>::new();

            let mut stmt = match status_filter {
                Some(_) => conn.prepare(
                    "SELECT client_id, status, label, created_at, approved_at, last_seen_at, request_count
                     FROM clients
                     WHERE status = ?1
                     ORDER BY client_id ASC",
                )?,
                None => conn.prepare(
                    "SELECT client_id, status, label, created_at, approved_at, last_seen_at, request_count
                     FROM clients
                     ORDER BY client_id ASC",
                )?,
            };

            let rows = match status_filter {
                Some(status) => stmt.query(params![status.as_str()])?,
                None => stmt.query([])?,
            };

            let mut rows = rows;
            while let Some(row) = rows.next()? {
                let record = row_to_client_record(row)?;
                clients.insert(record.client_id.clone(), record);
            }
            drop(rows);
            drop(stmt);

            let mut slot_stmt = conn.prepare(
                "SELECT client_id, slot, updated_at, version, size_bytes
                 FROM slots
                 ORDER BY client_id ASC, slot ASC",
            )?;
            let mut slot_rows = slot_stmt.query([])?;
            while let Some(row) = slot_rows.next()? {
                let cid: String = row.get(0)?;
                if let Some(client) = clients.get_mut(&cid) {
                    let slot: u32 = row.get(1)?;
                    let updated_at_str: String = row.get(2)?;
                    let version: i64 = row.get(3)?;
                    let size_bytes: i64 = row.get(4)?;
                    client.slots.insert(
                        slot,
                        SlotMeta {
                            updated_at: parse_rfc3339(&updated_at_str)?,
                            version: u64::try_from(version).unwrap_or(0),
                            size_bytes: u64::try_from(size_bytes).unwrap_or(0),
                        },
                    );
                }
            }

            Ok(clients.into_values().collect())
        })
        .await
        .unwrap_or_default()
    }

    pub async fn preauthorize_client(
        &self,
        client_id: &str,
        label: Option<String>,
    ) -> Result<ClientRecord, StorageError> {
        if !validate_client_id(client_id) {
            return Err(StorageError::InvalidClientId);
        }

        let client_id = client_id.to_string();
        let now_str = Utc::now().to_rfc3339();

        self.with_write_conn(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            tx.execute(
                "INSERT INTO clients
                 (client_id, status, label, created_at, approved_at, last_seen_at, request_count)
                 VALUES (?1, 'approved', ?2, ?3, ?3, ?3, 0)
                 ON CONFLICT(client_id) DO UPDATE SET
                     status = 'approved',
                     approved_at = excluded.approved_at,
                     label = COALESCE(excluded.label, clients.label)",
                params![client_id, label, now_str],
            )?;
            let record = load_client_record(&tx, &client_id)?
                .ok_or(StorageError::ClientNotFound)?;
            tx.commit()?;
            Ok(record)
        })
        .await
    }

    pub async fn approve_client(
        &self,
        client_id: &str,
        label: Option<String>,
    ) -> Result<ClientRecord, StorageError> {
        if !validate_client_id(client_id) {
            return Err(StorageError::InvalidClientId);
        }

        let client_id = client_id.to_string();
        let now_str = Utc::now().to_rfc3339();

        self.with_write_conn(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let affected = tx.execute(
                "UPDATE clients
                 SET status = 'approved',
                     approved_at = ?1,
                     label = COALESCE(?2, label)
                 WHERE client_id = ?3",
                params![now_str, label, client_id],
            )?;
            if affected == 0 {
                return Err(StorageError::ClientNotFound);
            }
            let record = load_client_record(&tx, &client_id)?
                .ok_or(StorageError::ClientNotFound)?;
            tx.commit()?;
            Ok(record)
        })
        .await
    }

    pub async fn revoke_client(&self, client_id: &str) -> Result<ClientRecord, StorageError> {
        if !validate_client_id(client_id) {
            return Err(StorageError::InvalidClientId);
        }

        let client_id = client_id.to_string();
        self.with_write_conn(move |conn| {
            let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let affected = tx.execute(
                "UPDATE clients SET status = 'revoked' WHERE client_id = ?1",
                params![client_id],
            )?;
            if affected == 0 {
                return Err(StorageError::ClientNotFound);
            }
            let record = load_client_record(&tx, &client_id)?
                .ok_or(StorageError::ClientNotFound)?;
            tx.commit()?;
            Ok(record)
        })
        .await
    }

    pub async fn delete_client(&self, client_id: &str) -> Result<bool, StorageError> {
        if !validate_client_id(client_id) {
            return Err(StorageError::InvalidClientId);
        }

        let client_id = client_id.to_string();
        self.with_write_conn(move |conn| {
            let affected = conn.execute(
                "DELETE FROM clients WHERE client_id = ?1",
                params![client_id],
            )?;
            Ok(affected > 0)
        })
        .await
    }

    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    pub fn db_path(&self) -> &Path {
        &self.db_path
    }
}

fn configure_connection(conn: &Connection, read_only: bool) -> Result<(), StorageError> {
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    if !read_only {
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
    }
    Ok(())
}

fn init_schema(conn: &Connection) -> Result<(), StorageError> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_meta (
             key TEXT PRIMARY KEY,
             value TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS clients (
             client_id TEXT PRIMARY KEY,
             status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'revoked')),
             label TEXT,
             created_at TEXT NOT NULL,
             approved_at TEXT,
             last_seen_at TEXT NOT NULL,
             request_count INTEGER NOT NULL DEFAULT 0
         );
         CREATE INDEX IF NOT EXISTS idx_clients_status ON clients(status);
         CREATE TABLE IF NOT EXISTS slots (
             client_id TEXT NOT NULL,
             slot INTEGER NOT NULL,
             version INTEGER NOT NULL,
             updated_at TEXT NOT NULL,
             size_bytes INTEGER NOT NULL,
             encrypted TEXT NOT NULL,
             PRIMARY KEY (client_id, slot),
             FOREIGN KEY (client_id) REFERENCES clients(client_id) ON DELETE CASCADE
         );",
    )?;

    let existing_ver: Option<String> = conn
        .query_row(
            "SELECT value FROM schema_meta WHERE key = 'schema_version'",
            [],
            |row| row.get(0),
        )
        .optional()?;

    match existing_ver {
        None => {
            conn.execute(
                "INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?1)",
                params![DB_SCHEMA_VERSION.to_string()],
            )?;
        }
        Some(ver_str) => {
            let ver: u32 = ver_str.parse().unwrap_or(0);
            if ver == 0 || ver > DB_SCHEMA_VERSION {
                return Err(StorageError::Io(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("unsupported database schema_version: {ver_str}"),
                )));
            }
        }
    }

    Ok(())
}

/// One-time automatic migration from legacy `clients.json` + `blobs/` into SQLite
/// when the SQLite database has no clients yet and `clients.json` exists.
fn maybe_migrate_legacy_json(data_dir: &Path, conn: &Connection) -> Result<(), StorageError> {
    let legacy_path = data_dir.join("clients.json");
    if !legacy_path.exists() {
        return Ok(());
    }

    let client_count: i64 =
        conn.query_row("SELECT COUNT(*) FROM clients", [], |row| row.get(0))?;
    if client_count > 0 {
        return Ok(());
    }

    #[derive(Deserialize)]
    struct LegacyRegistry {
        clients: BTreeMap<String, ClientRecord>,
    }

    #[derive(Deserialize)]
    struct LegacyBlob {
        slot: u32,
        encrypted: String,
        updated_at: DateTime<Utc>,
        version: u64,
    }

    let raw = fs::read_to_string(&legacy_path)?;
    let parsed: LegacyRegistry = match serde_json::from_str(&raw) {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(
                "Skipping legacy clients.json migration due to parse error: {e}"
            );
            return Ok(());
        }
    };

    let blobs_dir = data_dir.join("blobs");
    let tx = conn.unchecked_transaction()?;
    for (cid, record) in &parsed.clients {
        tx.execute(
            "INSERT OR IGNORE INTO clients
             (client_id, status, label, created_at, approved_at, last_seen_at, request_count)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                cid,
                record.status.as_str(),
                record.label,
                record.created_at.to_rfc3339(),
                record.approved_at.map(|t| t.to_rfc3339()),
                record.last_seen_at.to_rfc3339(),
                i64::try_from(record.request_count).unwrap_or(i64::MAX),
            ],
        )?;

        let client_blobs_dir = blobs_dir.join(cid);
        if let Ok(entries) = fs::read_dir(&client_blobs_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                if let Ok(blob_raw) = fs::read_to_string(&path) {
                    if let Ok(blob) = serde_json::from_str::<LegacyBlob>(&blob_raw) {
                        tx.execute(
                            "INSERT OR IGNORE INTO slots
                             (client_id, slot, version, updated_at, size_bytes, encrypted)
                             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                            params![
                                cid,
                                blob.slot,
                                i64::try_from(blob.version).unwrap_or(i64::MAX),
                                blob.updated_at.to_rfc3339(),
                                i64::try_from(blob.encrypted.len()).unwrap_or(i64::MAX),
                                blob.encrypted,
                            ],
                        )?;
                    }
                }
            }
        }
    }
    tx.commit()?;
    tracing::info!(
        "Migrated {} clients from legacy clients.json into {}",
        parsed.clients.len(),
        data_dir.join(DB_FILE_NAME).display()
    );
    Ok(())
}

fn load_client_slots(
    conn: &Connection,
    client_id: &str,
) -> Result<BTreeMap<u32, SlotMeta>, StorageError> {
    let mut stmt = conn.prepare(
        "SELECT slot, updated_at, version, size_bytes
         FROM slots
         WHERE client_id = ?1
         ORDER BY slot ASC",
    )?;
    let mut rows = stmt.query(params![client_id])?;
    let mut slots = BTreeMap::new();
    while let Some(row) = rows.next()? {
        let slot: u32 = row.get(0)?;
        let updated_at_str: String = row.get(1)?;
        let version: i64 = row.get(2)?;
        let size_bytes: i64 = row.get(3)?;
        slots.insert(
            slot,
            SlotMeta {
                updated_at: parse_rfc3339(&updated_at_str)?,
                version: u64::try_from(version).unwrap_or(0),
                size_bytes: u64::try_from(size_bytes).unwrap_or(0),
            },
        );
    }
    Ok(slots)
}

fn load_client_record(
    conn: &Connection,
    client_id: &str,
) -> Result<Option<ClientRecord>, StorageError> {
    let mut record = match conn
        .query_row(
            "SELECT client_id, status, label, created_at, approved_at, last_seen_at, request_count
             FROM clients
             WHERE client_id = ?1",
            params![client_id],
            row_to_client_record,
        )
        .optional()?
    {
        Some(r) => r,
        None => return Ok(None),
    };
    record.slots = load_client_slots(conn, client_id)?;
    Ok(Some(record))
}

fn row_to_client_record(row: &rusqlite::Row<'_>) -> Result<ClientRecord, rusqlite::Error> {
    let client_id: String = row.get(0)?;
    let status_str: String = row.get(1)?;
    let label: Option<String> = row.get(2)?;
    let created_at_str: String = row.get(3)?;
    let approved_at_str: Option<String> = row.get(4)?;
    let last_seen_at_str: String = row.get(5)?;
    let request_count: i64 = row.get(6)?;

    Ok(ClientRecord {
        client_id,
        status: ClientStatus::from_db(&status_str)?,
        label,
        created_at: parse_rfc3339(&created_at_str).map_err(chrono_to_sqlite_err)?,
        approved_at: approved_at_str
            .as_deref()
            .map(parse_rfc3339)
            .transpose()
            .map_err(chrono_to_sqlite_err)?,
        last_seen_at: parse_rfc3339(&last_seen_at_str).map_err(chrono_to_sqlite_err)?,
        request_count: u64::try_from(request_count).unwrap_or(0),
        slots: BTreeMap::new(),
    })
}

fn parse_rfc3339(s: &str) -> Result<DateTime<Utc>, rusqlite::Error> {
    DateTime::parse_from_rfc3339(s)
        .map(|dt| dt.with_timezone(&Utc))
        .map_err(chrono_to_sqlite_err)
}

fn chrono_to_sqlite_err<E: std::error::Error + Send + Sync + 'static>(err: E) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(err))
}

fn create_dir_all_private(path: &Path) -> Result<(), std::io::Error> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    builder.mode(0o700);
    builder.create(path)?;
    #[cfg(unix)]
    {
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn set_private_file_permissions(path: &Path) -> Result<(), std::io::Error> {
    #[cfg(unix)]
    {
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_sqlite_permissions_schema_and_persistence() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().join("data");
        let client_id = "efaa52e7bf7b356fcebcbde5b95fa9aa24d6d91bbe6dac4d06bc5679b1d3e31e";

        {
            let storage = Storage::load_or_init(data_dir.clone(), 100, 1023, None, None).unwrap();
            storage
                .preauthorize_client(client_id, Some("Test".to_string()))
                .await
                .unwrap();
            storage
                .put_blob(client_id, 1, 0, "dGVzdA==".to_string())
                .await
                .unwrap();

            #[cfg(unix)]
            {
                let dir_mode = fs::metadata(&data_dir).unwrap().permissions().mode() & 0o777;
                let lock_mode = fs::metadata(data_dir.join(".lock")).unwrap().permissions().mode() & 0o777;
                let db_mode = fs::metadata(data_dir.join(DB_FILE_NAME))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777;

                assert_eq!(dir_mode, 0o700);
                assert_eq!(lock_mode, 0o600);
                assert_eq!(db_mode, 0o600);
            }
        }

        // Re-open database and verify data persisted
        {
            let reopened = Storage::load_or_init(data_dir.clone(), 100, 1023, None, None).unwrap();
            let clients = reopened.list_clients(None).await;
            assert_eq!(clients.len(), 1);
            assert_eq!(clients[0].client_id, client_id);
            assert_eq!(clients[0].slots.get(&1).unwrap().version, 1);

            let blob = reopened.get_blob(client_id, 1).await.unwrap().unwrap();
            assert_eq!(blob.encrypted, "dGVzdA==");
            assert_eq!(blob.version, 1);
        }
    }

    #[tokio::test]
    async fn test_legacy_json_migration() {
        let dir = tempfile::tempdir().unwrap();
        let data_dir = dir.path().join("data");
        let client_id = "efaa52e7bf7b356fcebcbde5b95fa9aa24d6d91bbe6dac4d06bc5679b1d3e31e";

        fs::create_dir_all(data_dir.join("blobs").join(client_id)).unwrap();
        let now = Utc::now().to_rfc3339();
        let legacy_clients = serde_json::json!({
            "schema_version": 1,
            "clients": {
                client_id: {
                    "client_id": client_id,
                    "status": "approved",
                    "label": "Migrated",
                    "created_at": now,
                    "approved_at": now,
                    "last_seen_at": now,
                    "request_count": 5,
                    "slots": {
                        "0": { "updated_at": now, "version": 2, "size_bytes": 8 }
                    }
                }
            }
        });
        fs::write(
            data_dir.join("clients.json"),
            serde_json::to_vec(&legacy_clients).unwrap(),
        )
        .unwrap();

        let legacy_blob = serde_json::json!({
            "slot": 0,
            "encrypted": "bGVnYWN5",
            "updated_at": now,
            "version": 2
        });
        fs::write(
            data_dir.join("blobs").join(client_id).join("0.json"),
            serde_json::to_vec(&legacy_blob).unwrap(),
        )
        .unwrap();

        let storage = Storage::load_or_init(data_dir, 100, 1023, None, None).unwrap();
        let clients = storage.list_clients(None).await;
        assert_eq!(clients.len(), 1);
        assert_eq!(clients[0].label.as_deref(), Some("Migrated"));
        assert_eq!(clients[0].request_count, 5);
        let blob = storage.get_blob(client_id, 0).await.unwrap().unwrap();
        assert_eq!(blob.encrypted, "bGVnYWN5");
        assert_eq!(blob.version, 2);
    }
}
