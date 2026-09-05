import { Boom } from '@hapi/boom'
import { parseMexOrderDetails } from '../Utils/business-mex'
import { isLidUser, isPnUser, jidNormalizedUser } from '../WABinary'

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

type ExecuteMexQuery = (variables: Record<string, unknown>, queryId: string, dataPath: string) => Promise<unknown>

type FetchMexOrderDetailsOptions = {
	orderId: string
	token: string
	requestedJid: string
	ownJids: readonly (string | undefined)[]
	executeQuery: ExecuteMexQuery
}

export const resolveOrderMexJid = (requestedJid: string, ownJids: readonly (string | undefined)[]) => {
	const requested = jidNormalizedUser(requestedJid)
	if (!requested) return undefined

	const ownAliases = ownJids.map(jidNormalizedUser).filter((jid): jid is string => !!jid)
	const ownPn = ownAliases.find(isPnUser)
	const requestedIsOwnLid = isLidUser(requested) && ownAliases.includes(requested)

	return requestedIsOwnLid && ownPn ? ownPn : requested
}

export const fetchMexOrderDetails = async ({
	orderId,
	token,
	requestedJid,
	ownJids,
	executeQuery
}: FetchMexOrderDetailsOptions) => {
	// WhatsApp Web derives this value from the current user. Incoming orders may carry the same account's LID instead.
	const jid = resolveOrderMexJid(requestedJid, ownJids)
	if (!jid) throw new Boom('Order details require a valid seller JID', { statusCode: 400 })

	const query = BUSINESS_MEX_QUERIES.order
	const result = await executeQuery(orderMexVariables(jid, orderId, token), query.queryId, query.dataPath)
	return parseMexOrderDetails(result)
}
