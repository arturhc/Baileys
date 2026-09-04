import {
	BUSINESS_GRAPH_QUERIES,
	catalogGraphRequest,
	collectionsGraphRequest,
	executeBusinessGraphQuery,
	parseBusinessGraphCatalog,
	parseBusinessGraphCollections,
	productGraphInput
} from '../../Socket/business-graph'

describe('current owner-catalog GraphQL protocol', () => {
	it('uses the persisted operations and variable shapes exposed by WhatsApp Web', () => {
		expect(BUSINESS_GRAPH_QUERIES.catalog).toBe('9957894520961099')
		expect(BUSINESS_GRAPH_QUERIES.addProduct).toBe('24249359867999500')
		expect(BUSINESS_GRAPH_QUERIES.updateCommerceSettings).toBe('9797519763673469')
		expect(catalogGraphRequest('123@lid', 25)).toEqual({
			request: {
				product_catalog: {
					jid: '123@lid',
					after: null,
					limit: '25',
					width: '100',
					height: '100',
					belongs_to: {},
					allow_shop_source: false,
					direct_connection_encrypted_info: null,
					variant_thumbnail_height: null,
					variant_thumbnail_width: null
				},
				platform: 'WEB'
			}
		})
		expect(collectionsGraphRequest('123@lid', 10, 'next').request.collections.after).toBe('next')
	})

	it('uses the form-encoded Facebook GraphQL transport used by WhatsApp Web', async () => {
		const originalFetch = globalThis.fetch
		let request: RequestInit | undefined
		globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			request = init
			return new Response('for(;;);{"data":{"ok":true}}', { status: 200 })
		}) as typeof fetch
		try {
			await expect(executeBusinessGraphQuery('secret-token', '123', { input: { value: 1 } }, 15)).resolves.toEqual({
				ok: true
			})
			const headers = new Headers(request?.headers)
			expect(headers.get('content-type')).toBe('application/x-www-form-urlencoded')
			expect(headers.get('x-wa-device-id')).toBe('15')
			const body = new URLSearchParams(request?.body?.toString())
			expect(body.get('access_token')).toBe('secret-token')
			expect(body.get('doc_id')).toBe('123')
			expect(JSON.parse(body.get('variables') || '')).toEqual({ input: { value: 1 } })
		} finally {
			globalThis.fetch = originalFetch
		}
	})

	it('builds mutation product input with uploaded media and parses catalog responses', () => {
		const input = productGraphInput({
			name: 'Torta',
			description: 'Con todo',
			currency: 'MXN',
			price: 85000,
			retailerId: 'TOR-01',
			isHidden: false,
			originCountryCode: 'MX',
			images: [{ url: 'https://mmg.whatsapp.net/image.jpg' }]
		})
		expect(input).toMatchObject({
			name: 'Torta',
			price: '85000',
			media: { image: [{ url: 'https://mmg.whatsapp.net/image.jpg' }] },
			compliance_info: { country_code_origin: 'MX' }
		})
		const parsed = parseBusinessGraphCatalog({
			xfb_whatsapp_catalog: {
				product_catalog: {
					catalog_id: 'catalog-1',
					catalog_name: 'Menú',
					catalog_type: 'PRODUCT',
					products: [
						{
							id: '1',
							name: 'Torta',
							description: 'Con todo',
							price: '85000',
							currency: 'MXN',
							availability: 'IN_STOCK',
							is_hidden: 'ISHIDDEN_FALSE',
							media: { images: [] }
						}
					],
					paging: { after: 'next' }
				}
			}
		})
		expect(parsed.products[0]).toMatchObject({ id: '1', name: 'Torta', price: 85000, availability: 'in stock' })
		expect(parsed).toMatchObject({ catalogId: 'catalog-1', catalogName: 'Menú', catalogType: 'PRODUCT' })
		expect(parsed.nextPageCursor).toBe('next')
	})

	it('parses collection products and rejects mutations without an image', () => {
		const parsed = parseBusinessGraphCollections({
			xfb_whatsapp_catalog_collections: {
				collections: [{ id: 'c1', name: 'Comida', products: [], status_info: { status: 'APPROVED' } }],
				paging: {}
			}
		})
		expect(parsed.collections[0]).toMatchObject({ id: 'c1', name: 'Comida', products: [] })
		expect(() =>
			productGraphInput({
				name: 'Sin imagen',
				description: '',
				currency: 'MXN',
				price: 1000,
				originCountryCode: 'MX',
				images: []
			})
		).toThrow('requires at least one uploaded product image')
	})
})
