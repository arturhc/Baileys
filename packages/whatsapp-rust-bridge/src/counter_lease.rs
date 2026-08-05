//! Every record this crate puts into service waives the core's counter lease.
//!
//! The lease reserves a batch of outbound counters ahead of durability so the
//! send path only needs a flush once per batch. Carrying that ceiling forward
//! requires persisting it, and the record shape this crate writes has nowhere
//! to put it: the export materializes the reservation, so the whole batch burns
//! on every operation instead of once per batch. Left alone, consecutive sends
//! land on the wire 64 counters apart and the peer buffers 63 skipped keys for
//! each one.
//!
//! What the lease protects against is a crash between the encrypt and the
//! write. This crate hands the changeset back to the caller, which persists it
//! before the ciphertext reaches the wire, so there is nothing left for the
//! lease to protect. That is the trade the waiver states, and it is the same
//! guarantee the pre-WASM releases gave.
//!
//! Route every record through here rather than calling the core directly: a
//! path that forgets goes back to leasing without failing, and the only symptom
//! is skipped keys piling up somewhere else.

use wacore_libsignal::protocol::error::Result as SignalResult;
use wacore_libsignal::protocol::{SenderKeyRecord, SessionRecord};

pub(crate) fn waive_session(mut record: SessionRecord) -> SessionRecord {
    record.waive_counter_lease();
    record
}

pub(crate) fn waive_sender_key(mut record: SenderKeyRecord) -> SignalResult<SenderKeyRecord> {
    record.waive_counter_lease()?;
    Ok(record)
}
