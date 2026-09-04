export const BUSINESS_MEX_QUERIES = {
	catalog: {
		queryId: '30445081048424116',
		dataPath: 'xwa_product_catalog_get_product_catalog'
	},
	collections: {
		queryId: '9430970660362540',
		dataPath: 'xwa_product_catalog_get_collections'
	},
	order: {
		queryId: '26593811266898374',
		dataPath: 'xwa_checkout_get_order_info'
	}
} as const

export const catalogMexVariables = (jid: string, limit: number, cursor?: string) => ({
	request: {
		product_catalog: {
			jid,
			limit: String(limit),
			width: '100',
			height: '100',
			allow_shop_source: 'ALLOWSHOPSOURCE_TRUE',
			...(cursor ? { after: cursor } : {})
		}
	}
})

export const collectionsMexVariables = (jid: string, limit: number, cursor?: string) => ({
	request: {
		collections: {
			biz_jid: jid,
			collection_limit: String(limit),
			item_limit: String(limit),
			width: '100',
			height: '100',
			...(cursor ? { after: cursor } : {})
		}
	}
})

export const orderMexVariables = (jid: string, orderId: string, token: string) => ({
	request: {
		order: {
			id: orderId,
			jid,
			token: { sensitive_string_value: token },
			image_dimensions: { width: 100, height: 100 },
			direct_connection_encrypted_info: null
		}
	}
})
