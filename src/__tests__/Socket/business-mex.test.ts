import { Boom } from '@hapi/boom'
import {
	BUSINESS_MEX_QUERIES,
	catalogMexVariables,
	collectionsMexVariables,
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
					image_dimensions: { width: 100, height: 100 }
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
		const result = parseMexOrderDetails({
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
		})

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
