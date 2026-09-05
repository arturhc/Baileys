import { Boom } from '@hapi/boom'
import { jest } from '@jest/globals'
import {
	BUSINESS_ORDER_MEX_QUERY,
	fetchMexOrderDetails,
	getOrderMexJidCandidates,
	isMexOrderAliasFallbackError,
	orderMexVariables
} from '../../Socket/business-mex'
import { parseMexOrderDetails } from '../../Utils/business-mex'

const orderResponse = {
	order: {
		price_details: { currency: 'MXN', total_amount: '300000' },
		products: [
			{
				id: 'product-1',
				name: 'Notebook',
				currency: 'MXN',
				price: '150000',
				quantity: '2',
				media: { images: [{ request_image_url: 'https://example.invalid/thumb.jpg' }] }
			}
		]
	}
}

const orderJidFromVariables = (variables: Record<string, unknown>) =>
	(variables.request as { order: { jid: string } }).order.jid

const mexBadRequest = () =>
	new Boom('GraphQL server error: Bad Request', {
		statusCode: 400,
		data: {
			message: 'Bad Request',
			extensions: { error_code: 400, is_retryable: false, severity: 'CRITICAL' },
			path: []
		}
	})

describe('business MEX order lookup', () => {
	it('uses the current persisted query and variable shape from WhatsApp Web', () => {
		expect(BUSINESS_ORDER_MEX_QUERY).toEqual({
			queryId: '26593811266898374',
			dataPath: 'xwa_checkout_get_order_info'
		})
		expect(orderMexVariables('15550000001@s.whatsapp.net', 'order-1', 'token-1')).toEqual({
			request: {
				order: {
					id: 'order-1',
					jid: '15550000001@s.whatsapp.net',
					token: { sensitive_string_value: 'token-1' },
					image_dimensions: { width: 100, height: 100 },
					direct_connection_encrypted_info: null
				}
			}
		})
	})

	it('normalizes own-account aliases and preserves the requested JID as the first candidate', () => {
		expect(
			getOrderMexJidCandidates('11111111111111:7@lid', ['15550000001:4@s.whatsapp.net', '11111111111111:7@lid'])
		).toEqual(['11111111111111@lid', '15550000001@s.whatsapp.net'])
	})

	it('does not try own-account aliases for another business', () => {
		expect(
			getOrderMexJidCandidates('22222222222222@lid', ['15550000001@s.whatsapp.net', '11111111111111@lid'])
		).toEqual(['22222222222222@lid'])
	})

	it('retries a rejected own LID with its PN alias and returns the parsed order', async () => {
		const executeQuery = jest.fn(async (variables: Record<string, unknown>) => {
			if (orderJidFromVariables(variables) === '11111111111111@lid') throw mexBadRequest()
			return orderResponse
		})
		const debug = jest.fn()

		const result = await fetchMexOrderDetails({
			orderId: 'order-1',
			token: 'token-1',
			requestedJid: '11111111111111@lid',
			ownJids: ['15550000001@s.whatsapp.net', '11111111111111@lid'],
			executeQuery,
			logger: { debug }
		})

		expect(executeQuery).toHaveBeenCalledTimes(2)
		expect(orderJidFromVariables(executeQuery.mock.calls[0]![0])).toBe('11111111111111@lid')
		expect(orderJidFromVariables(executeQuery.mock.calls[1]![0])).toBe('15550000001@s.whatsapp.net')
		expect(debug).toHaveBeenCalledWith(
			{ orderId: 'order-1', attempt: 1 },
			'order lookup rejected own-account alias; trying the next alias'
		)
		expect(result).toEqual(parseMexOrderDetails(orderResponse))
	})

	it('also retries a rejected own PN with its LID alias', async () => {
		const executeQuery = jest.fn(async (variables: Record<string, unknown>) => {
			if (orderJidFromVariables(variables) === '15550000001@s.whatsapp.net') throw mexBadRequest()
			return orderResponse
		})

		await fetchMexOrderDetails({
			orderId: 'order-1',
			token: 'token-1',
			requestedJid: '15550000001@s.whatsapp.net',
			ownJids: ['15550000001@s.whatsapp.net', '11111111111111@lid'],
			executeQuery,
			logger: { debug: jest.fn() }
		})

		expect(orderJidFromVariables(executeQuery.mock.calls[0]![0])).toBe('15550000001@s.whatsapp.net')
		expect(orderJidFromVariables(executeQuery.mock.calls[1]![0])).toBe('11111111111111@lid')
	})

	it('propagates the final structured error when neither own-account alias resolves the order', async () => {
		const finalFailure = mexBadRequest()
		const executeQuery = jest
			.fn<(variables: Record<string, unknown>) => Promise<unknown>>()
			.mockRejectedValueOnce(mexBadRequest())
			.mockRejectedValueOnce(finalFailure)

		await expect(
			fetchMexOrderDetails({
				orderId: 'order-1',
				token: 'token-1',
				requestedJid: '11111111111111@lid',
				ownJids: ['15550000001@s.whatsapp.net', '11111111111111@lid'],
				executeQuery,
				logger: { debug: jest.fn() }
			})
		).rejects.toBe(finalFailure)
		expect(executeQuery).toHaveBeenCalledTimes(2)
	})

	it('does not retry transport, authentication, or malformed-response failures', async () => {
		const failure = new Boom('Business request unavailable', { statusCode: 503 })
		const executeQuery = jest.fn(async () => Promise.reject(failure))

		await expect(
			fetchMexOrderDetails({
				orderId: 'order-1',
				token: 'token-1',
				requestedJid: '11111111111111@lid',
				ownJids: ['15550000001@s.whatsapp.net', '11111111111111@lid'],
				executeQuery,
				logger: { debug: jest.fn() }
			})
		).rejects.toBe(failure)
		expect(executeQuery).toHaveBeenCalledTimes(1)
	})

	it('recognizes only structured MEX bad-request errors as alias mismatches', () => {
		expect(isMexOrderAliasFallbackError(mexBadRequest())).toBe(true)
		expect(isMexOrderAliasFallbackError(new Boom('Bad Request', { statusCode: 400 }))).toBe(false)
		expect(isMexOrderAliasFallbackError(new Error('GraphQL server error: Bad Request'))).toBe(false)
	})

	it('rejects malformed order responses with a 502 Boom', () => {
		expect(() => parseMexOrderDetails({ order: {} })).toThrow(Boom)
		try {
			parseMexOrderDetails({ order: {} })
		} catch (error) {
			expect((error as Boom).output.statusCode).toBe(502)
		}
	})
})
