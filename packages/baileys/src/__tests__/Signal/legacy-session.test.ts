import { describe, expect, it } from '@jest/globals'
import P from 'pino'
import {
	hasOpenLegacySession,
	isLegacySessionEntry,
	isLegacySessionRecord,
	legacySessionInfo,
	pickOpenLegacySession
} from '../../Signal/legacy-session'
import { makeLibSignalRepository } from '../../Signal/libsignal'
import type { SignalAuthState, SignalDataSet, SignalDataTypeMap, SignalKeyStore } from '../../Types'
import { addTransactionCapability, initAuthCreds } from '../../Utils/auth-utils'

const logger = P({ level: 'silent' })

const b64 = (fill: number, size = 33) => Buffer.alloc(size, fill).toString('base64')

/** One `SessionEntry.serialize()` as the JS libsignal wrote it (base64 strings). */
const legacyEntry = ({ closed, registrationId, baseKeyFill }: Record<string, number>) => ({
	registrationId,
	currentRatchet: {
		ephemeralKeyPair: { pubKey: b64(1), privKey: b64(2, 32) },
		lastRemoteEphemeralKey: b64(3),
		previousCounter: 0,
		rootKey: b64(4, 32)
	},
	indexInfo: {
		baseKey: b64(baseKeyFill!),
		baseKeyType: 2,
		closed,
		used: 1700000000000,
		created: 1699999999000,
		remoteIdentityKey: b64(5)
	},
	_chains: {}
})

/** A rotated record: the FIRST key is a closed state, the live one comes later. */
const rotatedLegacyRecord = () => ({
	_sessions: {
		[b64(9)]: legacyEntry({ closed: 1700000000000, registrationId: 111, baseKeyFill: 9 }),
		[b64(8)]: legacyEntry({ closed: -1, registrationId: 222, baseKeyFill: 8 })
	},
	version: 'v1'
})

const makeMemoryKeyStore = (seed: { [type: string]: { [id: string]: unknown } } = {}) => {
	const data: { [type: string]: { [id: string]: unknown } } = JSON.parse(JSON.stringify(seed))

	const store: SignalKeyStore = {
		get: async (type, ids) => {
			const bucket = data[type] || {}
			const out: { [id: string]: SignalDataTypeMap[typeof type] } = {}
			for (const id of ids) {
				const value = bucket[id]
				if (value !== undefined && value !== null) {
					out[id] = value as SignalDataTypeMap[typeof type]
				}
			}

			return out
		},
		set: async (update: SignalDataSet) => {
			for (const type of Object.keys(update)) {
				data[type] ||= {}
				const bucket = update[type as keyof SignalDataSet]!
				for (const id of Object.keys(bucket)) {
					const value = (bucket as Record<string, unknown>)[id]
					if (value === null) {
						delete data[type]![id]
					} else {
						data[type]![id] = value
					}
				}
			}
		}
	}

	return { store, data }
}

const makeRepository = (seed?: { [type: string]: { [id: string]: unknown } }) => {
	const { store, data } = makeMemoryKeyStore(seed)
	const auth: SignalAuthState = {
		creds: initAuthCreds(),
		keys: addTransactionCapability(store, logger, { maxCommitRetries: 1, delayBetweenTriesMs: 1 })
	}

	return { repository: makeLibSignalRepository(auth, logger), data }
}

describe('legacy session helpers', () => {
	it('recognises a legacy record and rejects bridge bytes', () => {
		expect(isLegacySessionRecord(rotatedLegacyRecord())).toBe(true)
		expect(isLegacySessionRecord(new Uint8Array([1, 2, 3]))).toBe(false)
		expect(isLegacySessionRecord(Buffer.from([1, 2, 3]))).toBe(false)
		expect(isLegacySessionRecord(null)).toBe(false)
		expect(isLegacySessionRecord({})).toBe(false)
	})

	it('picks the OPEN state, not the first key', () => {
		const open = pickOpenLegacySession(rotatedLegacyRecord())

		// Insertion order puts the closed state first; the live one must win.
		expect(open?.registrationId).toBe(222)
		expect(hasOpenLegacySession(rotatedLegacyRecord())).toBe(true)
	})

	it('reports no open state when every session is closed', () => {
		const allClosed = {
			_sessions: {
				[b64(9)]: legacyEntry({ closed: 1700000000000, registrationId: 111, baseKeyFill: 9 })
			}
		}

		expect(pickOpenLegacySession(allClosed)).toBeUndefined()
		expect(hasOpenLegacySession(allClosed)).toBe(false)
	})

	it('ignores structurally incomplete entries', () => {
		const broken = { _sessions: { a: { indexInfo: { closed: -1 } } as never } }

		expect(pickOpenLegacySession(broken)).toBeUndefined()
	})

	it('detects a bare entry and reads its session info', () => {
		const entry = legacyEntry({ closed: -1, registrationId: 222, baseKeyFill: 8 })

		expect(isLegacySessionEntry(entry)).toBe(true)
		expect(isLegacySessionEntry(new Uint8Array([1]))).toBe(false)

		const info = legacySessionInfo(entry)
		expect(info?.registrationId).toBe(222)
		expect(Buffer.from(info!.baseKey).toString('base64')).toBe(b64(8))
	})

	it('returns null session info when the entry lacks a base key', () => {
		expect(legacySessionInfo({ registrationId: 1 })).toBeNull()
		expect(legacySessionInfo({ indexInfo: { baseKey: b64(8) } })).toBeNull()
	})
})

describe('repository on a pre-WASM auth state', () => {
	const pnJid = '5511900000001@s.whatsapp.net'
	const addr = '5511900000001.0'

	it('exposes the OPEN legacy state through getSessionInfo', async () => {
		const { repository } = makeRepository({ session: { [addr]: rotatedLegacyRecord() } })

		const info = await repository.getSessionInfo(pnJid)

		// 222 is the live state; 111 is the stale closed one the bridge would take.
		expect(info?.registrationId).toBe(222)
		expect(Buffer.from(info!.baseKey).toString('base64')).toBe(b64(8))
	})

	it('treats a legacy record with an open state as a valid session', async () => {
		const { repository } = makeRepository({ session: { [addr]: rotatedLegacyRecord() } })

		await expect(repository.validateSession(pnJid)).resolves.toEqual({ exists: true })
	})

	it('reports no open session when the legacy record is fully closed', async () => {
		const closedOnly = {
			_sessions: { [b64(9)]: legacyEntry({ closed: 1700000000000, registrationId: 111, baseKeyFill: 9 }) }
		}
		const { repository } = makeRepository({ session: { [addr]: closedOnly } })

		const result = await repository.validateSession(pnJid)
		expect(result.exists).toBe(false)
	})

	it('carries a legacy session across the PN → LID migration instead of dropping it', async () => {
		const lidJid = '18000000000001@lid'
		const { repository, data } = makeRepository({
			'device-list': { '5511900000001': ['0'] },
			session: { [addr]: rotatedLegacyRecord() }
		})

		const result = await repository.migrateSession(pnJid, lidJid)

		expect(result.migrated).toBe(1)
		// PN row cleared, LID row now holds the record — still readable, not empty.
		expect(data.session!['5511900000001.0']).toBeUndefined()
		const moved = data.session!['18000000000001_1.0']
		expect(moved).toBeDefined()
		expect(hasOpenLegacySession(moved as never)).toBe(true)
	})

	it('does not migrate a legacy record whose states are all closed', async () => {
		const lidJid = '18000000000001@lid'
		const closedOnly = {
			_sessions: { [b64(9)]: legacyEntry({ closed: 1700000000000, registrationId: 111, baseKeyFill: 9 }) }
		}
		const { repository, data } = makeRepository({
			'device-list': { '5511900000001': ['0'] },
			session: { [addr]: closedOnly }
		})

		const result = await repository.migrateSession(pnJid, lidJid)

		expect(result.migrated).toBe(0)
		// The dead record stays put rather than being copied onto the LID key.
		expect(data.session!['18000000000001_1.0']).toBeUndefined()
	})
})
