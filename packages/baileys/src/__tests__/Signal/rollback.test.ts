import { describe, expect, it } from '@jest/globals'
import P from 'pino'
import { projectLegacySessionRecordV1 } from 'whatsapp-rust-bridge'
import { fromTypedRecord, toTypedRecord } from '../../Signal/legacy-session-codec'
import { makeLibSignalRepository } from '../../Signal/libsignal'
import type { SignalAuthState, SignalDataSet, SignalDataTypeMap, SignalKeyStore } from '../../Types'
import { addTransactionCapability } from '../../Utils/auth-utils'
import fixture from '../fixtures/legacy-session-rc9.json'

/**
 * Going back to a pre-WASM release. Bob upgrades carrying an rc.9 auth state,
 * uses it, and then changes his mind: the session he is now on has to be
 * expressible in the legacy JSON shape the JS libsignal reads.
 *
 * Sender keys have no such projection. A group key written by this backend
 * cannot be read by the old one, so that limitation is asserted here rather
 * than left to be discovered during a rollback.
 */
const logger = P({ level: 'silent' })

const revive = (value: unknown): unknown => {
	if (typeof value === 'object' && value !== null && (value as { type?: string }).type === 'Buffer') {
		const { data } = value as { data: number[] | string }
		return typeof data === 'string' ? Buffer.from(data, 'base64') : Buffer.from(data)
	}

	if (Array.isArray(value)) return value.map(revive)
	if (ArrayBuffer.isView(value)) return value
	if (typeof value === 'object' && value !== null) {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, revive(v)]))
	}

	return value
}

const makeBob = () => {
	const data = revive(fixture.bob.store) as Record<string, Record<string, unknown>>
	const store: SignalKeyStore = {
		get: async (type, ids) => {
			const bucket = data[type] || {}
			const out: { [id: string]: SignalDataTypeMap[typeof type] } = {}
			for (const id of ids) {
				if (bucket[id] !== undefined && bucket[id] !== null) out[id] = bucket[id] as never
			}

			return out
		},
		set: async (update: SignalDataSet) => {
			for (const type of Object.keys(update)) {
				data[type] ||= {}
				const bucket = update[type as keyof SignalDataSet]!
				for (const id of Object.keys(bucket)) {
					const value = (bucket as Record<string, unknown>)[id]
					if (value === null) delete data[type]![id]
					else data[type]![id] = value
				}
			}
		}
	}

	const auth: SignalAuthState = {
		creds: revive(fixture.bob.creds) as never,
		keys: addTransactionCapability(store, logger, { maxCommitRetries: 1, delayBetweenTriesMs: 1 })
	}

	return { data, repository: makeLibSignalRepository(auth, logger) }
}

const { aliceJid, groupJid } = fixture.jids
const sessionAddr = '5511900000001.0'

describe('rolling back to a pre-WASM release', () => {
	it('projects a session this backend advanced into the legacy shape', async () => {
		const bob = makeBob()

		// Use the upgraded state the way a running client would.
		for (const message of fixture.pending) {
			await bob.repository.decryptMessage({
				jid: aliceJid,
				type: message.type as 'msg' | 'pkmsg',
				ciphertext: Buffer.from(message.ct, 'base64')
			})
		}

		await bob.repository.encryptMessage({ jid: aliceJid, data: Buffer.from('from-new-bob') })

		const projection = projectLegacySessionRecordV1(bob.data.session![sessionAddr] as Uint8Array)
		// Narrowed by hand: expect() does not tell the compiler which arm this is.
		if (projection.status !== 'projected') {
			throw new Error(`not projectable: ${JSON.stringify(projection.issue)}`)
		}

		const legacy = fromTypedRecord(projection.record)
		// The shape the JS libsignal expects: a record keyed by base64 index keys.
		const sessions = legacy._sessions ?? {}
		expect(Object.keys(sessions).length).toBeGreaterThan(0)
		for (const entry of Object.values(sessions)) {
			expect(entry).toHaveProperty('currentRatchet')
			expect(entry).toHaveProperty('indexInfo')
		}
	})

	it('round-trips the projection back through the bridge unchanged', async () => {
		const bob = makeBob()
		await bob.repository.encryptMessage({ jid: aliceJid, data: Buffer.from('one more') })

		const bytes = bob.data.session![sessionAddr] as Uint8Array
		const projection = projectLegacySessionRecordV1(bytes)
		if (projection.status !== 'projected') {
			throw new Error(`not projectable: ${JSON.stringify(projection.issue)}`)
		}

		// Legacy JSON -> typed model -> legacy JSON must be stable, or a rollback
		// would hand the old build a record it wrote differently than it reads.
		const legacy = fromTypedRecord(projection.record)
		const again = fromTypedRecord(toTypedRecord(legacy))

		expect(JSON.stringify(again)).toBe(JSON.stringify(legacy))
	})

	it('leaves a group sender key in a shape the old build cannot read', async () => {
		const bob = makeBob()

		// Reading the legacy row is fine; writing is what changes the shape.
		await bob.repository.decryptGroupMessage({
			group: groupJid,
			authorJid: aliceJid,
			msg: Buffer.from(fixture.pendingGroup[0]!.ct, 'base64')
		})

		const stored = bob.data['sender-key']![`${groupJid}::5511900000001::0`] as Uint8Array
		// The JS backend parses this row as JSON. Once this backend has written
		// it, that parse fails: there is no projection for sender keys, so a
		// rollback needs the group keys to be redistributed.
		expect(() => JSON.parse(Buffer.from(stored).toString())).toThrow()
	})
})
