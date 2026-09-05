import { Boom } from '@hapi/boom'
import { parseMexOrderDetails } from '../Utils/business-mex'
import type { ILogger } from '../Utils/logger'
import { jidNormalizedUser } from '../WABinary'

export const BUSINESS_ORDER_MEX_QUERY = {
	queryId: '26593811266898374',
	dataPath: 'xwa_checkout_get_order_info'
} as const

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
	logger: Pick<ILogger, 'debug'>
}

export const getOrderMexJidCandidates = (requestedJid: string, ownJids: readonly (string | undefined)[]) => {
	const requested = jidNormalizedUser(requestedJid)
	if (!requested) return []

	const ownAliases = ownJids.map(jidNormalizedUser).filter((jid): jid is string => !!jid)
	return [...new Set([requested, ...(ownAliases.includes(requested) ? ownAliases : [])])]
}

export const isMexOrderAliasFallbackError = (error: unknown) => {
	if (!(error instanceof Boom) || error.output.statusCode !== 400) return false
	if (!error.message.startsWith('GraphQL server error:')) return false

	const data = error.data
	if (typeof data !== 'object' || data === null || Array.isArray(data)) return false
	const extensions = 'extensions' in data ? data.extensions : undefined
	if (typeof extensions !== 'object' || extensions === null || Array.isArray(extensions)) return false

	return 'error_code' in extensions && extensions.error_code === 400
}

export const fetchMexOrderDetails = async ({
	orderId,
	token,
	requestedJid,
	ownJids,
	executeQuery,
	logger
}: FetchMexOrderDetailsOptions) => {
	// Order messages can identify the local catalog by either alias, independently of the alias accepted by MEX.
	const candidates = getOrderMexJidCandidates(requestedJid, ownJids)
	if (!candidates.length) throw new Boom('Order details require a valid seller JID', { statusCode: 400 })

	for (const [index, candidate] of candidates.entries()) {
		try {
			const result = await executeQuery(
				orderMexVariables(candidate, orderId, token),
				BUSINESS_ORDER_MEX_QUERY.queryId,
				BUSINESS_ORDER_MEX_QUERY.dataPath
			)
			return parseMexOrderDetails(result)
		} catch (error) {
			const hasAnotherAlias = index < candidates.length - 1
			if (!hasAnotherAlias || !isMexOrderAliasFallbackError(error)) throw error
			logger.debug({ orderId, attempt: index + 1 }, 'order lookup rejected own-account alias; trying the next alias')
		}
	}

	throw new Boom('Order lookup did not attempt a seller JID', { statusCode: 500 })
}
