// Step 1 of the rollback proof, run with tsx inside packages/baileys.
//
// Bob upgrades to this branch carrying an rc.9 auth state: he consumes the
// ciphertexts the old build left pending, sends a new message, and then decides
// to go back — so his session is projected into the legacy JSON shape again.
// Step 2 feeds that projection to the real rc.9 and keeps the conversation going.
import { writeFileSync } from 'node:fs'
import P from 'pino'
import { projectLegacySessionRecordV1 } from 'whatsapp-rust-bridge'
import { fromTypedRecord } from '../../Signal/legacy-session-codec'
import { makeLibSignalRepository } from '../../Signal/libsignal'
import type { SignalAuthState, SignalDataSet, SignalDataTypeMap, SignalKeyStore } from '../../Types'
import { addTransactionCapability } from '../../Utils/auth-utils'
import fixture from './legacy-session-rc9.json'

const logger = P({ level: 'silent' })

const revive = (value: unknown): unknown => {
	if (typeof value === 'object' && value !== null && (value as { type?: string }).type === 'Buffer') {
		return Buffer.from((value as { data: string }).data, 'base64')
	}

	if (Array.isArray(value)) return value.map(revive)
	if (ArrayBuffer.isView(value)) return value
	if (typeof value === 'object' && value !== null) {
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, revive(v)]))
	}

	return value
}

const data = revive(fixture.bob.store) as Record<string, Record<string, unknown>>
const store: SignalKeyStore = {
	get: async (type, ids) => {
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
const repository = makeLibSignalRepository(auth, logger)

const { aliceJid, groupJid } = fixture.jids
const sessionAddr = '5511900000001.0'

const main = async () => {
	// 1. Consume what the old build enciphered but never delivered.
	for (const message of fixture.pending) {
		const plaintext = await repository.decryptMessage({
			jid: aliceJid,
			type: message.type as 'msg' | 'pkmsg',
			ciphertext: Buffer.from(message.ct, 'base64')
		})
		if (Buffer.from(plaintext).toString() !== message.pt) throw new Error(`DM mismatch: ${message.pt}`)
	}

	for (const message of fixture.pendingGroup) {
		const plaintext = await repository.decryptGroupMessage({
			group: groupJid,
			authorJid: aliceJid,
			msg: Buffer.from(message.ct, 'base64')
		})
		if (Buffer.from(plaintext).toString() !== message.pt) throw new Error(`group mismatch: ${message.pt}`)
	}

	// 2. Send something new from the upgraded build.
	const outgoing = await repository.encryptMessage({ jid: aliceJid, data: Buffer.from('from-new-bob') })

	// 3. Roll back: project the session Bob is now using into legacy JSON.
	const stored = data.session![sessionAddr] as Uint8Array
	const projection = projectLegacySessionRecordV1(stored)
	if (projection.status !== 'projected') {
		throw new Error(`session is not projectable: ${JSON.stringify(projection.issue)}`)
	}

	const outputPath = process.argv[2]
	if (!outputPath) {
		throw new Error('usage: rollback-step1 <output-path>')
	}

	writeFileSync(
		outputPath,
		JSON.stringify({
			outgoing: { type: outgoing.type, ct: Buffer.from(outgoing.ciphertext).toString('base64') },
			projectedSession: fromTypedRecord(projection.record),
			senderKey: Buffer.from(data['sender-key']![`${groupJid}::5511900000001::0`] as Uint8Array).toString('base64')
		})
	)

	console.log('step1 ok: consumed pending DM + group, sent one message, projected session back')
}

main().catch(error => {
	console.error('step1 FAILED:', error)
	process.exit(1)
})
