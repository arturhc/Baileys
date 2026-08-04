/**
 * Auth states written before the WASM backend hold sessions in the JS libsignal
 * shape — `SessionRecord.serialize()` returned a plain object, never bytes:
 *
 *   { _sessions: { [baseKeyB64]: SessionEntry }, version: 'v1' }
 *
 * The bridge can migrate one of these, but it picks `Object.keys(_sessions)[0]`,
 * which is insertion-ordered — after a ratchet rotation that is an old *closed*
 * state, not the live one, so the upgraded session would be unusable. It also
 * accepts a bare `SessionEntry` (anything carrying `registrationId` +
 * `currentRatchet`), so selecting the open entry here hands it the right state.
 */

export type LegacySessionEntry = {
	registrationId?: number
	currentRatchet?: unknown
	indexInfo?: {
		baseKey?: string
		closed?: number
	}
}

export type LegacySessionRecord = {
	_sessions?: { [baseKey: string]: LegacySessionEntry | undefined }
	version?: string
}

/** libsignal marks a live session with `closed === -1`. */
const OPEN = -1

export const isLegacySessionRecord = (value: unknown): value is LegacySessionRecord =>
	typeof value === 'object' && value !== null && !ArrayBuffer.isView(value) && '_sessions' in value

const isUsableEntry = (entry: LegacySessionEntry | undefined): entry is LegacySessionEntry =>
	!!entry && typeof entry.registrationId === 'number' && !!entry.currentRatchet

/**
 * The live session state, or undefined when every state is closed (or the
 * record is empty). Mirrors libsignal's `getOpenSession()`.
 */
export const pickOpenLegacySession = (record: LegacySessionRecord): LegacySessionEntry | undefined => {
	for (const entry of Object.values(record._sessions || {})) {
		if (isUsableEntry(entry) && entry.indexInfo?.closed === OPEN) {
			return entry
		}
	}

	return undefined
}

export const hasOpenLegacySession = (record: LegacySessionRecord): boolean => !!pickOpenLegacySession(record)

/** A single state, as handed to the bridge by `loadSession` for legacy records. */
export const isLegacySessionEntry = (value: unknown): value is LegacySessionEntry =>
	typeof value === 'object' &&
	value !== null &&
	!ArrayBuffer.isView(value) &&
	'registrationId' in value &&
	'currentRatchet' in value

/**
 * `indexInfo.baseKey` is the JS libsignal equivalent of wacore's
 * `alice_base_key`, so the retry protections keep working on a session that has
 * not been rewritten into the bridge format yet.
 */
export const legacySessionInfo = (
	entry: LegacySessionEntry
): { baseKey: Uint8Array; registrationId: number } | null => {
	const baseKey = entry.indexInfo?.baseKey
	const { registrationId } = entry
	if (!baseKey || typeof registrationId !== 'number') {
		return null
	}

	return { baseKey: new Uint8Array(Buffer.from(baseKey, 'base64')), registrationId }
}
