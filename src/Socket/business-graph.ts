import { Boom } from '@hapi/boom'
import type { CatalogCollection, Product, ProductCreate, ProductUpdate } from '../Types'

type JsonObject = Record<string, unknown>

export const BUSINESS_GRAPH_QUERIES = {
	createCatalog: '29232780583035464',
	catalog: '9957894520961099',
	collections: '9687699931342731',
	addProduct: '24249359867999500',
	editProduct: '9889773371084956',
	deleteProduct: '9376108569185474',
	updateCommerceSettings: '9797519763673469',
	createCollection: '29361942130088470',
	updateCollection: '24486970300891371',
	deleteCollections: '29970196299234260'
} as const

const GRAPH_URL = 'https://graph.facebook.com/graphql'

const objectAt = (value: unknown, path: string): JsonObject => {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Boom(`Malformed business GraphQL response: ${path} is not an object`, { statusCode: 502 })
	}

	return value as JsonObject
}

const objectArray = (value: unknown): JsonObject[] =>
	Array.isArray(value)
		? (value.filter(item => typeof item === 'object' && item !== null && !Array.isArray(item)) as JsonObject[])
		: []

const optionalString = (value: unknown) => (typeof value === 'string' ? value : undefined)
const requiredString = (value: unknown, path: string) => {
	const result = optionalString(value)
	if (result === undefined)
		throw new Boom(`Malformed business GraphQL response: ${path} is not a string`, { statusCode: 502 })
	return result
}

const parseBoolean = (value: unknown) =>
	value === true || value === 'true' || value === 'TRUE' || value === 'ISHIDDEN_TRUE'

const parseAvailability = (value: unknown): Product['availability'] => {
	switch (value) {
		case 'OUT_OF_STOCK':
		case 'out of stock':
			return 'out of stock'
		case 'AVAILABLE_FOR_ANOTHER_POSTCODE':
		case 'available for another postcode':
			return 'available for another postcode'
		case 'IN_STOCK':
		case 'in stock':
			return 'in stock'
		default:
			return 'unknown'
	}
}

export const parseBusinessGraphProduct = (value: unknown, path = 'product'): Product => {
	const product = objectAt(value, path)
	const media =
		typeof product.media === 'object' && product.media !== null ? objectAt(product.media, `${path}.media`) : {}
	const images = objectArray(media.images)
	const firstImage = images[0]
	const statusInfo =
		typeof product.status_info === 'object' && product.status_info !== null
			? objectAt(product.status_info, `${path}.status_info`)
			: {}
	const price = Number(product.price)
	if (!Number.isFinite(price)) {
		throw new Boom(`Malformed business GraphQL response: ${path}.price is not numeric`, { statusCode: 502 })
	}

	const imageUrls: Record<string, string> = {}
	const requested = optionalString(firstImage?.request_image_url)
	const original = optionalString(firstImage?.original_image_url)
	if (requested) imageUrls.requested = requested
	if (original) imageUrls.original = original

	const reviewStatus: Record<string, string> = {}
	const status = optionalString(statusInfo.status)
	if (status) reviewStatus.whatsapp = status

	return {
		id: requiredString(product.id, `${path}.id`),
		name: requiredString(product.name, `${path}.name`),
		description: optionalString(product.description) ?? '',
		price,
		currency: requiredString(product.currency, `${path}.currency`),
		retailerId: optionalString(product.retailer_id),
		url: optionalString(product.url),
		isHidden: parseBoolean(product.is_hidden),
		availability: parseAvailability(product.availability ?? product.product_availability),
		imageUrls,
		reviewStatus
	}
}

type GraphError = {
	message?: string
	code?: number
	extensions?: { error_code?: number }
}

const graphErrors = (payload: JsonObject): GraphError[] => {
	const errors = Array.isArray(payload.errors) ? payload.errors : payload.error ? [payload.error] : []
	return errors.filter(error => typeof error === 'object' && error !== null) as GraphError[]
}

export const isBusinessGraphAuthError = (error: unknown) => {
	if (!(error instanceof Boom)) return false
	return (error.data as { authFailure?: boolean } | undefined)?.authFailure === true
}

export const isBusinessGraphMissingCatalogError = (error: unknown) => {
	if (!(error instanceof Boom)) return false
	return (error.data as { graphCode?: number } | undefined)?.graphCode === 2498052
}

export const executeBusinessGraphQuery = async <T>(
	accessToken: string,
	documentId: string,
	variables: Record<string, unknown>,
	deviceId?: number
): Promise<T> => {
	const body = new URLSearchParams({
		access_token: accessToken,
		doc_id: documentId,
		variables: JSON.stringify(variables),
		locale: 'es_MX'
	})
	const response = await fetch(GRAPH_URL, {
		method: 'POST',
		headers: {
			accept: 'application/json',
			'content-type': 'application/x-www-form-urlencoded',
			...(deviceId ? { 'x-wa-device-id': String(deviceId) } : {})
		},
		body
	})
	let payload: JsonObject
	try {
		const text = (await response.text()).replace(/^for\s*\(\s*;;\s*\)\s*;\s*/, '')
		payload = objectAt(JSON.parse(text) as unknown, 'response')
	} catch (error) {
		throw new Boom('Business GraphQL returned invalid JSON', {
			statusCode: 502,
			data: { httpStatus: response.status, parserError: error instanceof Error ? error.message : String(error) }
		})
	}

	const errors = graphErrors(payload)
	if (!response.ok || errors.length) {
		const first = errors[0]
		const code = first?.extensions?.error_code ?? first?.code
		const authFailure = response.status === 401 || response.status === 403 || code === 102 || code === 190
		throw new Boom(`Business GraphQL error: ${first?.message ?? `HTTP ${response.status}`}`, {
			statusCode: authFailure ? 401 : 502,
			data: { httpStatus: response.status, graphCode: code, authFailure }
		})
	}

	return objectAt(payload.data, 'response.data') as T
}

export const catalogGraphRequest = (jid: string, limit: number, cursor?: string) => ({
	request: {
		product_catalog: {
			jid,
			after: cursor ?? null,
			limit: String(limit),
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

export const parseBusinessGraphCatalog = (data: unknown) => {
	const root = objectAt(data, 'data')
	const envelope = objectAt(root.xfb_whatsapp_catalog, 'data.xfb_whatsapp_catalog')
	const catalog = objectAt(envelope.product_catalog, 'data.xfb_whatsapp_catalog.product_catalog')
	const paging = typeof catalog.paging === 'object' && catalog.paging !== null ? objectAt(catalog.paging, 'paging') : {}
	return {
		catalogId: optionalString(catalog.catalog_id),
		catalogName: optionalString(catalog.catalog_name),
		catalogType: optionalString(catalog.catalog_type),
		products: objectArray(catalog.products).map((product, index) =>
			parseBusinessGraphProduct(product, `product_catalog.products[${index}]`)
		),
		nextPageCursor: optionalString(paging.after)
	}
}

export const collectionsGraphRequest = (jid: string, limit: number, cursor?: string) => ({
	request: {
		collections: {
			biz_jid: jid,
			after: cursor ?? null,
			collection_limit: String(limit),
			item_limit: String(limit),
			width: '100',
			height: '100',
			direct_connection_encrypted_info: null,
			variant_info_fields: null,
			variant_thumbnail_height: null,
			variant_thumbnail_width: null
		}
	}
})

export const parseBusinessGraphCollections = (data: unknown) => {
	const root = objectAt(data, 'data')
	const envelope = objectAt(root.xfb_whatsapp_catalog_collections, 'data.xfb_whatsapp_catalog_collections')
	const paging =
		typeof envelope.paging === 'object' && envelope.paging !== null ? objectAt(envelope.paging, 'paging') : {}
	const collections = objectArray(envelope.collections).map<CatalogCollection>((collection, collectionIndex) => {
		const statusInfo =
			typeof collection.status_info === 'object' && collection.status_info !== null
				? objectAt(collection.status_info, `collections[${collectionIndex}].status_info`)
				: {}
		return {
			id: requiredString(collection.id, `collections[${collectionIndex}].id`),
			name: requiredString(collection.name, `collections[${collectionIndex}].name`),
			products: objectArray(collection.products).map((product, productIndex) =>
				parseBusinessGraphProduct(product, `collections[${collectionIndex}].products[${productIndex}]`)
			),
			status: {
				status: optionalString(statusInfo.status) ?? '',
				canAppeal: parseBoolean(statusInfo.can_appeal)
			}
		}
	})
	return { collections, nextPageCursor: optionalString(paging.after) }
}

export const productGraphInput = (product: ProductCreate | ProductUpdate) => {
	const image = product.images
		.map(item => ('url' in item ? { url: item.url.toString() } : undefined))
		.filter((item): item is { url: string } => item !== undefined)
	if (!image.length)
		throw new Boom('Business GraphQL requires at least one uploaded product image', { statusCode: 400 })
	const info: JsonObject = {
		name: product.name,
		description: product.description || undefined,
		media: { image },
		is_hidden: !!product.isHidden,
		currency: product.currency,
		price: String(product.price),
		retailer_id: product.retailerId || undefined
	}
	if ('originCountryCode' in product) {
		if (product.originCountryCode) info.compliance_info = { country_code_origin: product.originCountryCode }
		else info.compliance_category = 'COUNTRY_ORIGIN_EXEMPT'
	}

	return Object.fromEntries(Object.entries(info).filter(([, value]) => value !== undefined))
}
