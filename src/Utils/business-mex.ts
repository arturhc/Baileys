import { Boom } from '@hapi/boom'
import type { CatalogCollection, OrderDetails, OrderProduct, Product, ProductAvailability } from '../Types'

type JsonObject = Record<string, unknown>

const malformed = (operation: string, detail: string): never => {
	throw new Boom(`Malformed ${operation} MEX response: ${detail}`, { statusCode: 502 })
}

const objectAt = (value: unknown, operation: string, path: string, optional = false): JsonObject | undefined => {
	if ((value === undefined || value === null) && optional) {
		return undefined
	}

	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return malformed(operation, `${path} is not an object`)
	}

	return value as JsonObject
}

const objectArrayAt = (value: unknown, operation: string, path: string, optional = false): JsonObject[] => {
	if ((value === undefined || value === null) && optional) {
		return []
	}

	if (!Array.isArray(value)) {
		return malformed(operation, `${path} is not an array`)
	}

	return value.map((entry, index) => objectAt(entry, operation, `${path}[${index}]`)!)
}

const stringAt = (value: unknown, operation: string, path: string): string => {
	if (typeof value !== 'string') {
		return malformed(operation, `${path} is not a string`)
	}

	return value
}

const optionalString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

const numberAt = (value: unknown, operation: string, path: string): number => {
	if (typeof value !== 'number' && typeof value !== 'string') {
		return malformed(operation, `${path} is not numeric`)
	}

	if (typeof value === 'string' && !value.trim()) {
		return malformed(operation, `${path} is not numeric`)
	}

	const parsed = Number(value)
	if (!Number.isFinite(parsed)) {
		return malformed(operation, `${path} is not numeric`)
	}

	return parsed
}

const optionalBoolean = (value: unknown): boolean | undefined => {
	if (typeof value === 'boolean') {
		return value
	}

	if (typeof value !== 'string') {
		return undefined
	}

	if (value === 'true' || value === 'ISHIDDEN_TRUE') {
		return true
	}

	if (value === 'false' || value === 'ISHIDDEN_FALSE') {
		return false
	}
}

const parseAvailability = (value: unknown): ProductAvailability => {
	switch (value) {
		case 'OUT_OF_STOCK':
			return 'out of stock'
		case 'AVAILABLE_FOR_ANOTHER_POSTCODE':
			return 'available for another postcode'
		case 'IN_STOCK':
			return 'in stock'
		default:
			return 'unknown'
	}
}

const parseMexProduct = (value: unknown, operation: string, path: string): Product => {
	const product = objectAt(value, operation, path)!
	const media = objectAt(product.media, operation, `${path}.media`, true)
	const images = objectArrayAt(media?.images, operation, `${path}.media.images`, true)
	const firstImage = images[0]
	const statusInfo = objectAt(product.status_info, operation, `${path}.status_info`, true)
	const imageUrls: Record<string, string> = {}
	const requested = optionalString(firstImage?.request_image_url)
	const original = optionalString(firstImage?.original_image_url)

	if (requested) imageUrls.requested = requested
	if (original) imageUrls.original = original

	const reviewStatus: Record<string, string> = {}
	const whatsappStatus = optionalString(statusInfo?.status)
	if (whatsappStatus) reviewStatus.whatsapp = whatsappStatus

	return {
		id: stringAt(product.id, operation, `${path}.id`),
		imageUrls,
		reviewStatus,
		availability: parseAvailability(product.product_availability),
		name: stringAt(product.name, operation, `${path}.name`),
		retailerId: optionalString(product.retailer_id),
		url: optionalString(product.url),
		description: stringAt(product.description, operation, `${path}.description`),
		price: numberAt(product.price, operation, `${path}.price`),
		currency: stringAt(product.currency, operation, `${path}.currency`),
		isHidden: optionalBoolean(product.is_hidden) ?? false
	}
}

export const parseMexCatalog = (value: unknown) => {
	const operation = 'catalog'
	const response = objectAt(value, operation, 'response')!
	const catalog = objectAt(response.product_catalog, operation, 'product_catalog')!
	const products = objectArrayAt(catalog.products, operation, 'product_catalog.products').map((product, index) =>
		parseMexProduct(product, operation, `product_catalog.products[${index}]`)
	)
	const paging = objectAt(catalog.paging, operation, 'product_catalog.paging', true)

	return {
		products,
		nextPageCursor: optionalString(paging?.after)
	}
}

export const parseMexCollections = (value: unknown) => {
	const operation = 'collections'
	const response = objectAt(value, operation, 'response')!
	const collections = objectArrayAt(response.collections, operation, 'collections').map<CatalogCollection>(
		(collection, collectionIndex) => {
			const path = `collections[${collectionIndex}]`
			const products = objectArrayAt(collection.products, operation, `${path}.products`, true).map(
				(product, productIndex) => parseMexProduct(product, operation, `${path}.products[${productIndex}]`)
			)
			const statusInfo = objectAt(collection.status_info, operation, `${path}.status_info`, true)

			return {
				id: stringAt(collection.id, operation, `${path}.id`),
				name: stringAt(collection.name, operation, `${path}.name`),
				products,
				status: {
					status: optionalString(statusInfo?.status) ?? '',
					canAppeal: optionalBoolean(statusInfo?.can_appeal) ?? false
				}
			}
		}
	)
	const paging = objectAt(response.paging, operation, 'paging', true)

	return {
		collections,
		nextPageCursor: optionalString(paging?.after)
	}
}

export const parseMexOrderDetails = (value: unknown): OrderDetails => {
	const operation = 'order'
	const order = objectAt(objectAt(value, operation, 'MEX data-path result')!.order, operation, 'order')!
	const priceDetails = objectAt(order.price_details, operation, 'order.price_details')!
	const products = objectArrayAt(order.products, operation, 'order.products').map<OrderProduct>((product, index) => {
		const path = `order.products[${index}]`
		const media = objectAt(product.media, operation, `${path}.media`, true)
		const images = objectArrayAt(media?.images, operation, `${path}.media.images`, true)

		return {
			id: stringAt(product.id, operation, `${path}.id`),
			name: stringAt(product.name, operation, `${path}.name`),
			imageUrl: optionalString(images[0]?.request_image_url) ?? '',
			price: numberAt(product.price, operation, `${path}.price`),
			currency: stringAt(product.currency, operation, `${path}.currency`),
			quantity: numberAt(product.quantity, operation, `${path}.quantity`)
		}
	})

	return {
		price: {
			total: numberAt(priceDetails.total_amount, operation, 'order.price_details.total_amount'),
			currency: stringAt(priceDetails.currency, operation, 'order.price_details.currency')
		},
		products
	}
}
