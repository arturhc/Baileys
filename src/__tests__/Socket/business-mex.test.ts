import { Boom } from '@hapi/boom'
import { jest } from '@jest/globals'
import {
	BUSINESS_MEX_QUERIES,
	catalogMexVariables,
	collectionsMexVariables,
	fetchMexOrderDetails,
	getOrderMexJidCandidates,
	isMexOrderAliasFallbackError,
	orderMexVariables
} from '../../Socket/business-mex'
import { parseMexCatalog, parseMexCollections, parseMexOrderDetails } from '../../Utils/business-mex'

const product = {
	id: 'product-1',
	name: 'Notebook',
	description: 'Dotted pages',
	currency: 'MXN',
	price: '150000',
	retailer_id: 'SKU-1',
	product_availability: 'IN_STOCK',
	is_hidden: 'ISHIDDEN_FALSE',
	status_info: { status: 'APPROVED', can_appeal: 'false' },
	media: {
		images: [
			{
				request_image_url: 'https://example.invalid/thumb.jpg',
				original_image_url: 'https://example.invalid/original.jpg'
			}
		]
	}
}

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

describe('business MEX request variables', () => {
	it('uses the current persisted queries and stringifies catalog dimensions', () => {
		expect(BUSINESS_MEX_QUERIES.catalog).toEqual({
			queryId: '30445081048424116',
			dataPath: 'xwa_product_catalog_get_product_catalog'
		})
		expect(catalogMexVariables('5215550000000@s.whatsapp.net', 10, 'page-2')).toEqual({
			request: {
				product_catalog: {
					jid: '5215550000000@s.whatsapp.net',
					limit: '10',
					width: '100',
					height: '100',
					allow_shop_source: 'ALLOWSHOPSOURCE_TRUE',
					after: 'page-2'
				}
			}
		})
	})

	it('omits a first-page cursor instead of sending null', () => {
		const variables = catalogMexVariables('5215550000000@s.whatsapp.net', 10)
		expect(variables.request.product_catalog).not.toHaveProperty('after')
	})

	it('builds collection and order variables with their wire-level number conventions', () => {
		expect(collectionsMexVariables('5215550000000@s.whatsapp.net', 51)).toEqual({
			request: {
				collections: {
					biz_jid: '5215550000000@s.whatsapp.net',
					collection_limit: '51',
					item_limit: '51',
					width: '100',
					height: '100'
				}
			}
		})
		expect(orderMexVariables('5215550000000@s.whatsapp.net', 'order-1', 'token-1')).toEqual({
			request: {
				order: {
					id: 'order-1',
					jid: '5215550000000@s.whatsapp.net',
					token: { sensitive_string_value: 'token-1' },
					image_dimensions: { width: 100, height: 100 },
					direct_connection_encrypted_info: null
				}
			}
		})
	})
})

describe('business MEX response parsing', () => {
	it('maps a catalog page to the existing Baileys product shape', () => {
		const result = parseMexCatalog({
			product_catalog: {
				products: [product],
				paging: { after: 'page-2' }
			}
		})

		expect(result).toEqual({
			products: [
				{
					id: 'product-1',
					name: 'Notebook',
					description: 'Dotted pages',
					currency: 'MXN',
					price: 150000,
					retailerId: 'SKU-1',
					url: undefined,
					availability: 'in stock',
					isHidden: false,
					reviewStatus: { whatsapp: 'APPROVED' },
					imageUrls: {
						requested: 'https://example.invalid/thumb.jpg',
						original: 'https://example.invalid/original.jpg'
					}
				}
			],
			nextPageCursor: 'page-2'
		})
	})

	it('maps collections and preserves the continuation cursor', () => {
		const result = parseMexCollections({
			collections: [
				{
					id: 'collection-1',
					name: 'Stationery',
					products: [{ ...product, product_availability: 'OUT_OF_STOCK' }],
					status_info: { status: 'APPROVED', can_appeal: true }
				}
			],
			paging: { after: 'collections-page-2' }
		})

		expect(result.nextPageCursor).toBe('collections-page-2')
		expect(result.collections[0]?.status).toEqual({ status: 'APPROVED', canAppeal: true })
		expect(result.collections[0]?.products[0]?.availability).toBe('out of stock')
	})

	it('maps order totals and line items', () => {
		const result = parseMexOrderDetails(orderResponse)

		expect(result).toEqual({
			price: { currency: 'MXN', total: 300000 },
			products: [
				{
					id: 'product-1',
					name: 'Notebook',
					currency: 'MXN',
					price: 150000,
					quantity: 2,
					imageUrl: 'https://example.invalid/thumb.jpg'
				}
			]
		})
	})

	it('throws a 502 Boom instead of treating a malformed catalog as empty', () => {
		let captured: unknown
		try {
			parseMexCatalog({ product_catalog: {} })
		} catch (error) {
			captured = error
		}

		expect(captured).toBeInstanceOf(Boom)
		expect((captured as Boom).output.statusCode).toBe(502)
	})
})

describe('business MEX order lookup', () => {
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
		expect(result.price).toEqual({ currency: 'MXN', total: 300000 })
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
		const firstFailure = mexBadRequest()
		const finalFailure = mexBadRequest()
		const executeQuery = jest
			.fn<(variables: Record<string, unknown>) => Promise<unknown>>()
			.mockRejectedValueOnce(firstFailure)
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
})
