use aes::cipher::{BlockEncrypt, KeyInit as AesKeyInit};
use aes::Aes256;
use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, Nonce as GcmNonce};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use ring::digest::{digest, SHA256};
use ring::hkdf::{KeyType, Salt, HKDF_SHA256};
use ring::rand::{SecureRandom, SystemRandom};
use ring::signature::{Ed25519KeyPair, KeyPair, UnparsedPublicKey, ED25519};
use std::fmt;

pub const PROTOCOL_SALT: &[u8] = b"cloudcookie-v1";
pub const INFO_AUTH_ED25519: &[u8] = b"client-auth-ed25519";
pub const INFO_ENC_KEY: &[u8] = b"e2e-xaes256gcm";
pub const NONCE_LEN: usize = 24;
pub const TAG_LEN: usize = 16;
pub const MIN_ENCRYPTED_LEN: usize = NONCE_LEN + TAG_LEN;
pub const AUTH_NONCE_HEX_LEN: usize = 32;
pub const SIGNATURE_HEX_LEN: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CryptoError {
    RngFailed,
    HkdfFailed,
    KeypairFailed,
    EncryptionFailed,
    DecryptionFailed,
    InvalidBase64,
    InvalidHex,
    InvalidClientId,
    InvalidSignature,
    PayloadTooShort,
    PayloadTooLarge,
}

impl fmt::Display for CryptoError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CryptoError::RngFailed => write!(f, "CSPRNG failure"),
            CryptoError::HkdfFailed => write!(f, "HKDF key derivation failed"),
            CryptoError::KeypairFailed => write!(f, "Ed25519 keypair derivation failed"),
            CryptoError::EncryptionFailed => write!(f, "AEAD encryption failed"),
            CryptoError::DecryptionFailed => write!(f, "AEAD decryption failed"),
            CryptoError::InvalidBase64 => write!(f, "invalid base64 encoding"),
            CryptoError::InvalidHex => write!(f, "invalid hex encoding"),
            CryptoError::InvalidClientId => write!(f, "invalid client_id"),
            CryptoError::InvalidSignature => write!(f, "invalid Ed25519 signature"),
            CryptoError::PayloadTooShort => write!(f, "encrypted payload shorter than nonce + tag"),
            CryptoError::PayloadTooLarge => write!(f, "encrypted payload exceeds maximum size"),
        }
    }
}

impl std::error::Error for CryptoError {}

struct Len32;

impl KeyType for Len32 {
    fn len(&self) -> usize {
        32
    }
}

/// Generate a fresh 256-bit (32-byte) root key using the OS CSPRNG.
pub fn generate_root_key() -> Result<[u8; 32], CryptoError> {
    let rng = SystemRandom::new();
    let mut key = [0u8; 32];
    rng.fill(&mut key).map_err(|_| CryptoError::RngFailed)?;
    Ok(key)
}

/// Generate a random 256-bit hex token (64 lowercase hex chars), e.g. for admin auth.
pub fn generate_random_token() -> Result<String, CryptoError> {
    let bytes = generate_root_key()?;
    Ok(hex_encode(&bytes))
}

/// Generate a random 128-bit (16-byte) per-request nonce encoded as 32 lowercase hex chars.
pub fn generate_request_nonce() -> Result<String, CryptoError> {
    let rng = SystemRandom::new();
    let mut bytes = [0u8; 16];
    rng.fill(&mut bytes).map_err(|_| CryptoError::RngFailed)?;
    Ok(hex_encode(&bytes))
}

fn hkdf_derive_32(root_key: &[u8; 32], info: &[u8]) -> Result<[u8; 32], CryptoError> {
    let salt = Salt::new(HKDF_SHA256, PROTOCOL_SALT);
    let prk = salt.extract(root_key);
    let info_slices = [info];
    let okm = prk
        .expand(&info_slices, Len32)
        .map_err(|_| CryptoError::HkdfFailed)?;
    let mut out = [0u8; 32];
    okm.fill(&mut out).map_err(|_| CryptoError::HkdfFailed)?;
    Ok(out)
}

/// Derive the deterministic Ed25519 authentication keypair from the 256-bit root key.
pub fn derive_auth_keypair(root_key: &[u8; 32]) -> Result<Ed25519KeyPair, CryptoError> {
    let seed = hkdf_derive_32(root_key, INFO_AUTH_ED25519)?;
    Ed25519KeyPair::from_seed_unchecked(&seed).map_err(|_| CryptoError::KeypairFailed)
}

/// Derive the 64-character lowercase hex `client_id` (the Ed25519 public key)
/// from the 256-bit root key.
pub fn derive_client_id(root_key: &[u8; 32]) -> Result<String, CryptoError> {
    let kp = derive_auth_keypair(root_key)?;
    Ok(hex_encode(kp.public_key().as_ref()))
}

/// Derive the 256-bit XAES-256-GCM content encryption key from the 256-bit root key.
pub fn derive_enc_key(root_key: &[u8; 32]) -> Result<[u8; 32], CryptoError> {
    hkdf_derive_32(root_key, INFO_ENC_KEY)
}

fn build_aead_aad(client_id: &str, slot: u32, version: u64) -> Vec<u8> {
    format!("cloudcookie-v1:{client_id}:{slot}:{version}").into_bytes()
}

/// Derive per-nonce 256-bit AES-GCM key `Kx` and 96-bit nonce `N2` per C2SP XAES-256-GCM.
fn xaes_derive_subkey(key: &[u8; 32], nonce: &[u8; NONCE_LEN]) -> ([u8; 32], [u8; 12]) {
    let aes = Aes256::new_from_slice(key).expect("32-byte key");

    let mut l_block = aes::Block::default();
    aes.encrypt_block(&mut l_block);

    let mut k1 = [0u8; 16];
    let msb = (l_block[0] & 0x80) != 0;
    for i in 0..15 {
        k1[i] = (l_block[i] << 1) | (l_block[i + 1] >> 7);
    }
    k1[15] = l_block[15] << 1;
    if msb {
        k1[15] ^= 0x87;
    }

    let n1 = &nonce[..12];
    let mut n2 = [0u8; 12];
    n2.copy_from_slice(&nonce[12..24]);

    let mut m1 = [0u8; 16];
    m1[0] = 0x00;
    m1[1] = 0x01;
    m1[2] = b'X';
    m1[3] = 0x00;
    m1[4..16].copy_from_slice(n1);
    for i in 0..16 {
        m1[i] ^= k1[i];
    }

    let mut m2 = [0u8; 16];
    m2[0] = 0x00;
    m2[1] = 0x02;
    m2[2] = b'X';
    m2[3] = 0x00;
    m2[4..16].copy_from_slice(n1);
    for i in 0..16 {
        m2[i] ^= k1[i];
    }

    let mut b1 = aes::Block::from(m1);
    let mut b2 = aes::Block::from(m2);
    aes.encrypt_block(&mut b1);
    aes.encrypt_block(&mut b2);

    let mut kx = [0u8; 32];
    kx[..16].copy_from_slice(&b1);
    kx[16..].copy_from_slice(&b2);
    (kx, n2)
}

/// Encrypt with XAES-256-GCM given a 256-bit key, 192-bit nonce, plaintext, and AAD.
pub fn xaes_256_gcm_seal(
    key: &[u8; 32],
    nonce: &[u8; NONCE_LEN],
    plaintext: &[u8],
    aad: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    let (kx, n2) = xaes_derive_subkey(key, nonce);
    let gcm = Aes256Gcm::new_from_slice(&kx).map_err(|_| CryptoError::EncryptionFailed)?;
    gcm.encrypt(
        GcmNonce::from_slice(&n2),
        Payload {
            msg: plaintext,
            aad,
        },
    )
    .map_err(|_| CryptoError::EncryptionFailed)
}

/// Decrypt with XAES-256-GCM given a 256-bit key, 192-bit nonce, ciphertext+tag, and AAD.
pub fn xaes_256_gcm_open(
    key: &[u8; 32],
    nonce: &[u8; NONCE_LEN],
    ciphertext: &[u8],
    aad: &[u8],
) -> Result<Vec<u8>, CryptoError> {
    let (kx, n2) = xaes_derive_subkey(key, nonce);
    let gcm = Aes256Gcm::new_from_slice(&kx).map_err(|_| CryptoError::DecryptionFailed)?;
    gcm.decrypt(
        GcmNonce::from_slice(&n2),
        Payload {
            msg: ciphertext,
            aad,
        },
    )
    .map_err(|_| CryptoError::DecryptionFailed)
}

/// Build the canonical UTF-8 message signed by the client for every `POST /` request.
pub fn build_auth_message(
    action: &str,
    client_id: &str,
    slot_or_all: &str,
    expected_version: Option<u64>,
    timestamp: i64,
    nonce: &str,
    encrypted: Option<&str>,
) -> Vec<u8> {
    let payload_bytes = encrypted.unwrap_or("").as_bytes();
    let payload_hash = digest(&SHA256, payload_bytes);
    let payload_hash_hex = hex_encode(payload_hash.as_ref());
    let ver_str = expected_version.map_or_else(|| "-".to_string(), |v| v.to_string());
    format!(
        "cloudcookie-v1:{action}:{client_id}:{slot_or_all}:{ver_str}:{timestamp}:{nonce}:{payload_hash_hex}"
    )
    .into_bytes()
}

/// Sign a sync request with the client's Ed25519 keypair derived from `root_key`.
pub fn sign_request(
    root_key: &[u8; 32],
    action: &str,
    slot_or_all: &str,
    expected_version: Option<u64>,
    timestamp: i64,
    nonce: &str,
    encrypted: Option<&str>,
) -> Result<String, CryptoError> {
    let kp = derive_auth_keypair(root_key)?;
    let client_id = hex_encode(kp.public_key().as_ref());
    let msg = build_auth_message(
        action,
        &client_id,
        slot_or_all,
        expected_version,
        timestamp,
        nonce,
        encrypted,
    );
    let sig = kp.sign(&msg);
    Ok(hex_encode(sig.as_ref()))
}

/// Verify an Ed25519 request signature against `client_id` (the 32-byte Ed25519 public key).
pub fn verify_request_signature(
    client_id: &str,
    action: &str,
    slot_or_all: &str,
    expected_version: Option<u64>,
    timestamp: i64,
    nonce: &str,
    encrypted: Option<&str>,
    signature_hex: &str,
) -> Result<(), CryptoError> {
    if !validate_client_id(client_id) {
        return Err(CryptoError::InvalidClientId);
    }
    if !is_lowercase_hex(signature_hex, SIGNATURE_HEX_LEN) {
        return Err(CryptoError::InvalidSignature);
    }
    let pk_bytes = hex_decode(client_id)?;
    let sig_bytes = hex_decode(signature_hex)?;
    let msg = build_auth_message(
        action,
        client_id,
        slot_or_all,
        expected_version,
        timestamp,
        nonce,
        encrypted,
    );
    let pk = UnparsedPublicKey::new(&ED25519, &pk_bytes);
    pk.verify(&msg, &sig_bytes)
        .map_err(|_| CryptoError::InvalidSignature)
}

/// Encrypt plaintext with XAES-256-GCM using a fresh 192-bit CSPRNG nonce
/// and AAD bound to `(client_id, slot, version)`. Returns `base64(nonce || ciphertext || tag)`.
pub fn encrypt_payload(
    root_key: &[u8; 32],
    slot: u32,
    version: u64,
    plaintext: &[u8],
) -> Result<String, CryptoError> {
    let client_id = derive_client_id(root_key)?;
    let enc_key_bytes = derive_enc_key(root_key)?;

    let rng = SystemRandom::new();
    let mut nonce_bytes = [0u8; NONCE_LEN];
    rng.fill(&mut nonce_bytes)
        .map_err(|_| CryptoError::RngFailed)?;

    let aad_bytes = build_aead_aad(&client_id, slot, version);
    let ciphertext = xaes_256_gcm_seal(&enc_key_bytes, &nonce_bytes, plaintext, &aad_bytes)?;

    let mut out = Vec::with_capacity(NONCE_LEN + ciphertext.len());
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);
    Ok(BASE64.encode(&out))
}

/// Decrypt a `base64(nonce || ciphertext || tag)` payload using `root_key`, `slot`, and `version`.
pub fn decrypt_payload(
    root_key: &[u8; 32],
    slot: u32,
    version: u64,
    encoded: &str,
) -> Result<Vec<u8>, CryptoError> {
    let client_id = derive_client_id(root_key)?;
    let enc_key_bytes = derive_enc_key(root_key)?;

    let raw = BASE64
        .decode(encoded.as_bytes())
        .map_err(|_| CryptoError::InvalidBase64)?;
    if raw.len() < MIN_ENCRYPTED_LEN {
        return Err(CryptoError::PayloadTooShort);
    }

    let mut nonce_bytes = [0u8; NONCE_LEN];
    nonce_bytes.copy_from_slice(&raw[..NONCE_LEN]);

    let aad_bytes = build_aead_aad(&client_id, slot, version);
    xaes_256_gcm_open(&enc_key_bytes, &nonce_bytes, &raw[NONCE_LEN..], &aad_bytes)
}

pub fn is_lowercase_hex(s: &str, expected_len: usize) -> bool {
    s.len() == expected_len
        && s.bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Validate that `client_id` is exactly 64 lowercase hex characters (256-bit Ed25519 public key).
pub fn validate_client_id(client_id: &str) -> bool {
    is_lowercase_hex(client_id, 64)
}

/// Validate that `nonce` is a 32-character lowercase hex string (128-bit random nonce).
pub fn validate_request_nonce(nonce: &str) -> bool {
    is_lowercase_hex(nonce, AUTH_NONCE_HEX_LEN)
}

/// Validate that an opaque encrypted blob is valid base64 and has at least
/// `NONCE_LEN + TAG_LEN` (40) decoded bytes and does not exceed `max_decoded_bytes`.
pub fn validate_encrypted_blob(encoded: &str, max_decoded_bytes: usize) -> Result<usize, CryptoError> {
    let raw = BASE64
        .decode(encoded.as_bytes())
        .map_err(|_| CryptoError::InvalidBase64)?;
    if raw.len() < MIN_ENCRYPTED_LEN {
        return Err(CryptoError::PayloadTooShort);
    }
    if raw.len() > max_decoded_bytes {
        return Err(CryptoError::PayloadTooLarge);
    }
    Ok(raw.len())
}

/// Constant-time token comparison via SHA-256 digest comparison so neither
/// token length nor prefix leaks through timing side channels.
pub fn constant_time_token_eq(a: &str, b: &str) -> bool {
    let da = digest(&SHA256, a.as_bytes());
    let db = digest(&SHA256, b.as_bytes());
    let mut diff = 0u8;
    for (x, y) in da.as_ref().iter().zip(db.as_ref().iter()) {
        diff |= x ^ y;
    }
    std::hint::black_box(diff) == 0
}

pub fn hex_encode(bytes: &[u8]) -> String {
    const HEX_CHARS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX_CHARS[(b >> 4) as usize] as char);
        out.push(HEX_CHARS[(b & 0x0f) as usize] as char);
    }
    out
}

pub fn hex_decode(s: &str) -> Result<Vec<u8>, CryptoError> {
    if s.len() % 2 != 0 {
        return Err(CryptoError::InvalidHex);
    }
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len() / 2);
    for chunk in bytes.chunks_exact(2) {
        let hi = hex_nibble(chunk[0]).ok_or(CryptoError::InvalidHex)?;
        let lo = hex_nibble(chunk[1]).ok_or(CryptoError::InvalidHex)?;
        out.push((hi << 4) | lo);
    }
    Ok(out)
}

fn hex_nibble(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}
