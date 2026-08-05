import { describe, expect, it } from '@jest/globals'
import P from 'pino'
import { makeLibSignalRepository } from '../../Signal/libsignal'
import type { SignalAuthState, SignalDataSet, SignalDataTypeMap, SignalKeyStore } from '../../Types'
import { addTransactionCapability, initAuthCreds } from '../../Utils/auth-utils'
import { generateSignalPubKey } from '../../Utils/crypto'

/**
 * The session path reads a snapshot, runs the protocol with no callbacks, and
 * lands every mutation in one write. These tests pin that shape from the
 * Baileys side: what the store sees, and when. A regression here means the
 * bridge is reaching back into JS mid-operation again — the re-entrancy that
 * made two scopes take the same records in opposite orders.
 */

const logger = P({ level: 'silent' })

type Call = { op: 'get' | 'set'; types: string[]; ids: string[] }

const makeRecordingStore = () => {
	const data: { [type: string]: { [id: string]: unknown } } = {}
	const calls: Call[] = []

	const store: SignalKeyStore = {
		get: async (type, ids) => {
			calls.push({ op: 'get', types: [type], ids: [...ids] })
			const bucket = data[type] || {}
			const out: { [id: string]: SignalDataTypeMap[typeof type] } = {}
			for (const id of ids) {
				if (bucket[id] !== undefined && bucket[id] !== null) {
					out[id] = bucket[id] as SignalDataTypeMap[typeof type]
				}
			}

			return out
		},
		set: async (update: SignalDataSet) => {
			const types = Object.keys(update)
			calls.push({
				op: 'set',
				types,
				ids: types.flatMap(type => Object.keys(update[type as keyof SignalDataSet]!))
			})
			for (const type of types) {
				data[type] ||= {}
				const bucket = update[type as keyof SignalDataSet]!
				for (const id of Object.keys(bucket)) {
					const value = (bucket as Record<string, unknown>)[id]
					if (value === null) delete data[type][id]
					else data[type][id] = value
				}
			}
		}
	}

	return { store, calls, data }
}

const makeParty = () => {
	const creds = initAuthCreds()
	const recorder = makeRecordingStore()
	const keys = addTransactionCapability(recorder.store, logger, {
		maxCommitRetries: 1,
		delayBetweenTriesMs: 1
	})
	const auth: SignalAuthState = { creds, keys }

	return { auth, creds, recorder, repository: makeLibSignalRepository(auth, logger) }
}

const bundleOf = async (party: ReturnType<typeof makeParty>, preKeyId: number) => {
	const preKey = initAuthCreds().signedPreKey.keyPair
	await party.auth.keys.set({ 'pre-key': { [preKeyId]: preKey } })

	return {
		registrationId: party.creds.registrationId,
		identityKey: generateSignalPubKey(party.creds.signedIdentityKey.public),
		preKey: { keyId: preKeyId, publicKey: generateSignalPubKey(preKey.public) },
		signedPreKey: {
			keyId: party.creds.signedPreKey.keyId,
			publicKey: generateSignalPubKey(party.creds.signedPreKey.keyPair.public),
			signature: party.creds.signedPreKey.signature
		}
	}
}

const aliceJid = '1111111111@s.whatsapp.net'
const bobJid = '2222222222@s.whatsapp.net'

describe('snapshot session path', () => {
	it('lands an encrypt in a single write with no reads in between', async () => {
		const alice = makeParty()
		const bob = makeParty()
		await alice.repository.injectE2ESession({ jid: bobJid, session: await bundleOf(bob, 1) })

		alice.recorder.calls.length = 0
		await alice.repository.encryptMessage({ jid: bobJid, data: Buffer.from('hello') })

		const writes = alice.recorder.calls.filter(call => call.op === 'set')
		expect(writes).toHaveLength(1)
		// Encrypt pins the peer identity alongside the session; both land together.
		expect(writes[0]!.types.sort()).toEqual(['identity-key', 'session'])

		// Every read must precede the single write: a read after it would mean
		// the operation went back to storage mid-flight.
		const write = alice.recorder.calls.findIndex(call => call.op === 'set')
		expect(alice.recorder.calls.slice(write + 1).some(call => call.op === 'get')).toBe(false)
	})

	it('deletes the consumed pre-key in the same write that stores the session', async () => {
		const alice = makeParty()
		const bob = makeParty()
		await alice.repository.injectE2ESession({ jid: bobJid, session: await bundleOf(bob, 7) })
		const { ciphertext, type } = await alice.repository.encryptMessage({
			jid: bobJid,
			data: Buffer.from('hi')
		})
		expect(type).toBe('pkmsg')

		bob.recorder.calls.length = 0
		await bob.repository.decryptMessage({ jid: aliceJid, type, ciphertext })

		const writes = bob.recorder.calls.filter(call => call.op === 'set')
		expect(writes).toHaveLength(1)
		// Session and spent pre-key move together: a crash between them would
		// either strip a key the session still needs or leave it reusable.
		expect(writes[0]!.types.sort()).toEqual(['identity-key', 'pre-key', 'session'])
		expect(bob.recorder.data['pre-key']?.[7]).toBeUndefined()
	})

	it('reads the pre-key the incoming message names, not the whole keyspace', async () => {
		const alice = makeParty()
		const bob = makeParty()
		await alice.repository.injectE2ESession({ jid: bobJid, session: await bundleOf(bob, 42) })
		const message = await alice.repository.encryptMessage({ jid: bobJid, data: Buffer.from('hi') })

		bob.recorder.calls.length = 0
		await bob.repository.decryptMessage({ jid: aliceJid, ...message })

		const preKeyReads = bob.recorder.calls.filter(call => call.op === 'get' && call.types[0] === 'pre-key')
		expect(preKeyReads).toHaveLength(1)
		expect(preKeyReads[0]!.ids).toEqual(['42'])
	})

	it('does not touch the pre-key store for a plain whisper message', async () => {
		const alice = makeParty()
		const bob = makeParty()
		await alice.repository.injectE2ESession({ jid: bobJid, session: await bundleOf(bob, 1) })
		const first = await alice.repository.encryptMessage({ jid: bobJid, data: Buffer.from('one') })
		await bob.repository.decryptMessage({ jid: aliceJid, ...first })

		const reply = await bob.repository.encryptMessage({ jid: aliceJid, data: Buffer.from('two') })
		expect(reply.type).toBe('msg')

		alice.recorder.calls.length = 0
		const plaintext = await alice.repository.decryptMessage({ jid: bobJid, ...reply })

		expect(Buffer.from(plaintext).toString()).toBe('two')
		expect(alice.recorder.calls.some(call => call.types.includes('pre-key'))).toBe(false)
	})

	it('leaves storage untouched when the operation fails', async () => {
		const alice = makeParty()
		const bob = makeParty()
		await alice.repository.injectE2ESession({ jid: bobJid, session: await bundleOf(bob, 1) })
		const message = await alice.repository.encryptMessage({ jid: bobJid, data: Buffer.from('hi') })

		const corrupted = Uint8Array.from(message.ciphertext)
		corrupted[corrupted.length - 1] = corrupted[corrupted.length - 1]! ^ 0xff

		bob.recorder.calls.length = 0
		await expect(
			bob.repository.decryptMessage({ jid: aliceJid, type: message.type, ciphertext: corrupted })
		).rejects.toThrow()

		// A failed operation reports no changes, so nothing may be written —
		// half-applied state is what corrupts a session.
		expect(bob.recorder.calls.filter(call => call.op === 'set')).toHaveLength(0)
		expect(bob.recorder.data['session']).toBeUndefined()
	})

	it('keeps the chain monotonic when encrypts overlap on one session', async () => {
		const alice = makeParty()
		const bob = makeParty()
		await alice.repository.injectE2ESession({ jid: bobJid, session: await bundleOf(bob, 1) })

		const produced = await Promise.all(
			Array.from({ length: 8 }, (_, index) =>
				alice.repository.encryptMessage({ jid: bobJid, data: Buffer.from(`m${index}`) })
			)
		)

		// Two encrypts reading the same session state would reuse a chain index
		// and repeat a ciphertext — the failure the server reports as
		// "message with old counter".
		const distinct = new Set(produced.map(out => Buffer.from(out.ciphertext).toString('base64')))
		expect(distinct.size).toBe(produced.length)
	})

	it('delivers every message when encrypt and decrypt interleave on one session', async () => {
		const alice = makeParty()
		const bob = makeParty()
		await alice.repository.injectE2ESession({ jid: bobJid, session: await bundleOf(bob, 1) })

		const opening = await alice.repository.encryptMessage({ jid: bobJid, data: Buffer.from('open') })
		await bob.repository.decryptMessage({ jid: aliceJid, ...opening })

		// bob answers while still deciphering what alice sends: both directions
		// hit the same record at once.
		const inbound: Promise<unknown>[] = []
		const outbound: Promise<unknown>[] = []
		for (let index = 0; index < 6; index++) {
			outbound.push(bob.repository.encryptMessage({ jid: aliceJid, data: Buffer.from(`pong${index}`) }))
			inbound.push(
				alice.repository
					.encryptMessage({ jid: bobJid, data: Buffer.from(`ping${index}`) })
					.then(message => bob.repository.decryptMessage({ jid: aliceJid, ...message }))
			)
		}

		const received = (await Promise.all(inbound)) as Uint8Array[]
		expect(received.map(plaintext => Buffer.from(plaintext).toString()).sort()).toEqual([
			'ping0',
			'ping1',
			'ping2',
			'ping3',
			'ping4',
			'ping5'
		])

		const replies = (await Promise.all(outbound)) as { type: 'pkmsg' | 'msg'; ciphertext: Uint8Array }[]
		const decoded = await Promise.all(
			replies.map(reply =>
				alice.repository.decryptMessage({ jid: bobJid, type: reply.type, ciphertext: reply.ciphertext })
			)
		)
		expect(decoded.map(plaintext => Buffer.from(plaintext).toString()).sort()).toEqual([
			'pong0',
			'pong1',
			'pong2',
			'pong3',
			'pong4',
			'pong5'
		])
	})
})
