//! In-memory store served from a caller-provided snapshot.
//!
//! The callback-based `JsStorageAdapter` calls back into JS several times per
//! Signal operation. That re-entrancy is what forces the JS side to predict
//! which records an operation will touch (so it can lock them up front), and it
//! lets a nested JS scope acquire locks in an order that inverts against
//! another scope's — the two failure modes we hit in production.
//!
//! Here the caller hands over everything the operation can need, the protocol
//! runs entirely in memory, and the mutations come back as an explicit
//! changeset. One read, one write, no callbacks in between.
//!
//! State lives behind `Rc<RefCell<_>>` so the store can be cloned into the
//! several `&mut dyn` slots `message_encrypt`/`message_decrypt_*` expect while
//! every handle still refers to the same snapshot.

use async_trait::async_trait;
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use wacore_libsignal::protocol::error::{Result as SignalResult, SignalProtocolError};
use wacore_libsignal::protocol::{
    Direction, IdentityChange, IdentityKey, IdentityKeyPair, IdentityKeyStore, PreKeyId,
    PreKeyRecord, PreKeyStore, ProtocolAddress, SenderKeyRecord, SenderKeyStore, SessionRecord,
    SessionStore, SignedPreKeyId, SignedPreKeyRecord, SignedPreKeyStore,
};
use wacore_libsignal::store::sender_key_name::SenderKeyName as CoreSenderKeyName;

/// What the operation changed. An absent field means the record was untouched,
/// so the caller must leave it alone rather than write a stale copy back.
#[derive(Default, Clone)]
pub struct SnapshotChanges {
    pub session: Option<Vec<u8>>,
    /// The peer's identity was replaced, so the session built on the old key is
    /// void: delete the row instead of writing `session`.
    pub session_cleared: bool,
    pub identity: Option<Vec<u8>>,
    pub removed_pre_key: Option<u32>,
    pub sender_key: Option<Vec<u8>>,
}

struct Inner {
    identity_key_pair: IdentityKeyPair,
    registration_id: u32,
    session: Option<SessionRecord>,
    peer_identity: Option<Vec<u8>>,
    pre_keys: HashMap<u32, PreKeyRecord>,
    signed_pre_keys: HashMap<u32, SignedPreKeyRecord>,
    sender_key: Option<SenderKeyRecord>,
    changes: SnapshotChanges,
}

#[derive(Clone)]
pub struct SnapshotStore {
    inner: Rc<RefCell<Inner>>,
}

impl SnapshotStore {
    pub fn new(identity_key_pair: IdentityKeyPair, registration_id: u32) -> Self {
        Self {
            inner: Rc::new(RefCell::new(Inner {
                identity_key_pair,
                registration_id,
                session: None,
                peer_identity: None,
                pre_keys: HashMap::new(),
                signed_pre_keys: HashMap::new(),
                sender_key: None,
                changes: SnapshotChanges::default(),
            })),
        }
    }

    pub fn with_session(&self, record: SessionRecord) {
        self.inner.borrow_mut().session = Some(record);
    }

    pub fn with_peer_identity_bytes(&self, identity: Vec<u8>) {
        self.inner.borrow_mut().peer_identity = Some(identity);
    }

    pub fn with_pre_key(&self, id: u32, record: PreKeyRecord) {
        self.inner.borrow_mut().pre_keys.insert(id, record);
    }

    pub fn with_signed_pre_key(&self, id: u32, record: SignedPreKeyRecord) {
        self.inner.borrow_mut().signed_pre_keys.insert(id, record);
    }

    pub fn with_sender_key(&self, record: SenderKeyRecord) {
        self.inner.borrow_mut().sender_key = Some(record);
    }

    pub fn take_changes(&self) -> SnapshotChanges {
        std::mem::take(&mut self.inner.borrow_mut().changes)
    }
}

#[async_trait(?Send)]
impl SessionStore for SnapshotStore {
    async fn load_session(&self, _address: &ProtocolAddress) -> SignalResult<Option<SessionRecord>> {
        Ok(self.inner.borrow().session.clone())
    }

    async fn has_session(&self, _address: &ProtocolAddress) -> SignalResult<bool> {
        Ok(self.inner.borrow().session.is_some())
    }

    async fn store_session(
        &mut self,
        _address: &ProtocolAddress,
        record: SessionRecord,
    ) -> SignalResult<()> {
        let bytes = record.serialize()?;
        let mut inner = self.inner.borrow_mut();
        inner.changes.session = Some(bytes);
        inner.changes.session_cleared = false;
        inner.session = Some(record);
        Ok(())
    }
}

#[async_trait(?Send)]
impl IdentityKeyStore for SnapshotStore {
    async fn get_identity_key_pair(&self) -> SignalResult<IdentityKeyPair> {
        Ok(self.inner.borrow().identity_key_pair.clone())
    }

    async fn get_local_registration_id(&self) -> SignalResult<u32> {
        Ok(self.inner.borrow().registration_id)
    }

    async fn save_identity(
        &mut self,
        _address: &ProtocolAddress,
        identity: &IdentityKey,
    ) -> SignalResult<IdentityChange> {
        let bytes = identity.serialize().to_vec();
        let mut inner = self.inner.borrow_mut();
        let previous = inner.peer_identity.replace(bytes.clone());
        inner.changes.identity = Some(bytes.clone());

        match previous {
            Some(old) if old != bytes => {
                // Trust on first use, but a REPLACED key voids the session built
                // on the old one. Report it so the caller deletes that row.
                inner.session = None;
                inner.changes.session = None;
                inner.changes.session_cleared = true;
                Ok(IdentityChange::ReplacedExisting)
            }
            _ => Ok(IdentityChange::NewOrUnchanged),
        }
    }

    async fn is_trusted_identity(
        &self,
        _address: &ProtocolAddress,
        _identity: &IdentityKey,
        _direction: Direction,
    ) -> SignalResult<bool> {
        // TOFU, matching the JS storage and WhatsApp Web.
        Ok(true)
    }

    async fn get_identity(&self, _address: &ProtocolAddress) -> SignalResult<Option<IdentityKey>> {
        let inner = self.inner.borrow();
        match &inner.peer_identity {
            Some(bytes) => Ok(Some(IdentityKey::decode(bytes)?)),
            None => Ok(None),
        }
    }
}

#[async_trait(?Send)]
impl PreKeyStore for SnapshotStore {
    async fn get_pre_key(&self, prekey_id: PreKeyId) -> SignalResult<PreKeyRecord> {
        self.inner
            .borrow()
            .pre_keys
            .get(&u32::from(prekey_id))
            .cloned()
            .ok_or(SignalProtocolError::InvalidPreKeyId)
    }

    async fn save_pre_key(
        &mut self,
        prekey_id: PreKeyId,
        record: &PreKeyRecord,
    ) -> SignalResult<()> {
        self.inner
            .borrow_mut()
            .pre_keys
            .insert(u32::from(prekey_id), record.clone());
        Ok(())
    }

    async fn remove_pre_key(&mut self, prekey_id: PreKeyId) -> SignalResult<()> {
        let id = u32::from(prekey_id);
        let mut inner = self.inner.borrow_mut();
        inner.pre_keys.remove(&id);
        // Reported, not applied: the caller deletes it alongside the session
        // write so a crash cannot strip the pre-key while the session is still
        // volatile (see the core's `consumed_prekey_id` note).
        inner.changes.removed_pre_key = Some(id);
        Ok(())
    }
}

#[async_trait(?Send)]
impl SignedPreKeyStore for SnapshotStore {
    async fn get_signed_pre_key(&self, id: SignedPreKeyId) -> SignalResult<SignedPreKeyRecord> {
        self.inner
            .borrow()
            .signed_pre_keys
            .get(&u32::from(id))
            .cloned()
            .ok_or(SignalProtocolError::InvalidSignedPreKeyId)
    }

    async fn save_signed_pre_key(
        &mut self,
        id: SignedPreKeyId,
        record: &SignedPreKeyRecord,
    ) -> SignalResult<()> {
        self.inner
            .borrow_mut()
            .signed_pre_keys
            .insert(u32::from(id), record.clone());
        Ok(())
    }
}

#[async_trait(?Send)]
impl SenderKeyStore for SnapshotStore {
    async fn store_sender_key(
        &mut self,
        _sender_key_name: &CoreSenderKeyName,
        record: SenderKeyRecord,
    ) -> SignalResult<()> {
        let bytes = record.serialize()?;
        let mut inner = self.inner.borrow_mut();
        inner.changes.sender_key = Some(bytes);
        inner.sender_key = Some(record);
        Ok(())
    }

    async fn load_sender_key(
        &self,
        _sender_key_name: &CoreSenderKeyName,
    ) -> SignalResult<Option<SenderKeyRecord>> {
        Ok(self.inner.borrow().sender_key.clone())
    }
}
