import { describe, expect, it } from '@jest/globals'
import { Curve } from '../../Utils/crypto'

/**
 * The WASM bridge reports a well-formed but invalid signature by RETURNING
 * false, and only throws on malformed input. The JS libsignal it replaced threw
 * in both cases, so the old `try { verify(); return true }` shape silently
 * accepted every 64-byte signature once the backend changed. These cases pin
 * the contract: only a genuinely valid signature may return true.
 */
describe('Curve.verify', () => {
	const message = Buffer.from('the quick brown fox')

	it('accepts a signature produced by the matching private key', () => {
		const keyPair = Curve.generateKeyPair()
		const signature = Curve.sign(keyPair.private, message)

		expect(Curve.verify(keyPair.public, message, signature)).toBe(true)
	})

	it('rejects a well-formed signature that does not match the message', () => {
		const keyPair = Curve.generateKeyPair()
		const signature = Curve.sign(keyPair.private, message)

		expect(Curve.verify(keyPair.public, Buffer.from('a different message'), signature)).toBe(false)
	})

	it('rejects a valid signature checked against the wrong public key', () => {
		const signer = Curve.generateKeyPair()
		const other = Curve.generateKeyPair()
		const signature = Curve.sign(signer.private, message)

		expect(Curve.verify(other.public, message, signature)).toBe(false)
	})

	it('rejects a tampered signature of the correct length', () => {
		const keyPair = Curve.generateKeyPair()
		const signature = Buffer.from(Curve.sign(keyPair.private, message))
		signature[0] = signature[0]! ^ 0xff

		expect(signature).toHaveLength(64)
		expect(Curve.verify(keyPair.public, message, signature)).toBe(false)
	})

	it('rejects an all-zero signature of the correct length', () => {
		const keyPair = Curve.generateKeyPair()

		expect(Curve.verify(keyPair.public, message, new Uint8Array(64))).toBe(false)
	})

	it('rejects malformed input instead of throwing', () => {
		const keyPair = Curve.generateKeyPair()

		expect(Curve.verify(keyPair.public, message, new Uint8Array(10))).toBe(false)
		expect(Curve.verify(new Uint8Array(5), message, Curve.sign(keyPair.private, message))).toBe(false)
	})
})
