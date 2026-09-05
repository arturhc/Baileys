import { Boom } from '@hapi/boom'
import type {
	CatalogCollectionMutationResult,
	CreateCatalogCollectionOptions,
	GetCatalogOptions,
	ProductCreate,
	ProductUpdate,
	SocketConfig,
	UpdateCatalogCollectionOptions,
	WAMediaUpload
} from '../Types'
import type { UpdateBussinesProfileProps } from '../Types/Bussines'
import { getRawMediaUploadData } from '../Utils'
import { uploadingNecessaryImagesOfProduct } from '../Utils/business'
import { parseMexCatalog, parseMexCollections } from '../Utils/business-mex'
import { type BinaryNode, jidDecode, jidNormalizedUser, S_WHATSAPP_NET } from '../WABinary'
import { getBinaryNodeChild, getBinaryNodeChildString } from '../WABinary/generic-utils'
import {
	BUSINESS_GRAPH_QUERIES,
	catalogGraphRequest,
	collectionsGraphRequest,
	executeBusinessGraphQuery,
	isBusinessGraphAuthError,
	isBusinessGraphMissingCatalogError,
	parseBusinessGraphCatalog,
	parseBusinessGraphCollections,
	parseBusinessGraphProduct,
	productGraphInput
} from './business-graph'
import {
	BUSINESS_MEX_QUERIES,
	catalogMexVariables,
	collectionsMexVariables,
	fetchMexOrderDetails
} from './business-mex'
import { makeMessagesRecvSocket } from './messages-recv'
import { executeWMexQuery as genericExecuteWMexQuery } from './mex'

export const makeBusinessSocket = (config: SocketConfig) => {
	const sock = makeMessagesRecvSocket(config)
	const { authState, generateMessageTag, query, waUploadToServer, ws } = sock
	const executeWMexQuery = <T>(variables: Record<string, unknown>, queryId: string, dataPath: string): Promise<T> =>
		genericExecuteWMexQuery<T>(variables, queryId, dataPath, query, generateMessageTag)

	let businessAccessToken: string | undefined
	let businessAccessTokenRequest: Promise<string> | undefined

	const findNode = (node: BinaryNode, tag: string): BinaryNode | undefined => {
		if (node.tag === tag) return node
		if (!Array.isArray(node.content)) return undefined
		for (const child of node.content) {
			const found = findNode(child, tag)
			if (found) return found
		}
	}

	const requestBusinessAccessToken = async () => {
		let nonceListener: ((node: BinaryNode) => void) | undefined
		let nonceTimer: NodeJS.Timeout | undefined
		const nonce = new Promise<string>((resolve, reject) => {
			nonceListener = (node: BinaryNode) => {
				if (node.attrs.type !== 'business') return
				const value = getBinaryNodeChildString(node, 'wa_ad_account_nonce')
				if (value) resolve(value)
			}

			ws.on('CB:notification', nonceListener)
			nonceTimer = setTimeout(
				() => reject(new Boom('Timed out waiting for business token nonce', { statusCode: 504 })),
				15_000
			)
		})

		try {
			const nonceResponse = await query({
				tag: 'iq',
				attrs: {
					id: generateMessageTag(),
					to: S_WHATSAPP_NET,
					type: 'get',
					xmlns: 'fb:thrift_iq',
					smax_id: '118'
				}
			})
			const result = getBinaryNodeChild(nonceResponse, 'result')
			if (result?.attrs.status && result.attrs.status.toLowerCase() !== 'success') {
				throw new Boom('Business token nonce request was rejected', { statusCode: 502 })
			}

			const code = await nonce
			const tokenResponse = await query({
				tag: 'iq',
				attrs: {
					id: generateMessageTag(),
					to: S_WHATSAPP_NET,
					type: 'get',
					xmlns: 'fb:thrift_iq',
					smax_id: '104'
				},
				content: [
					{
						tag: 'parameters',
						attrs: {},
						content: [{ tag: 'code', attrs: {}, content: Buffer.from(code) }]
					}
				]
			})
			const accessTokenNode = findNode(tokenResponse, 'access_token')
			const accessToken =
				typeof accessTokenNode?.content === 'string'
					? accessTokenNode.content
					: Buffer.isBuffer(accessTokenNode?.content)
						? accessTokenNode.content.toString()
						: undefined
			if (!accessToken) throw new Boom('Business token response did not contain an access token', { statusCode: 502 })
			return accessToken
		} finally {
			if (nonceListener) ws.off('CB:notification', nonceListener)
			if (nonceTimer) clearTimeout(nonceTimer)
		}
	}

	const getBusinessAccessToken = async () => {
		if (businessAccessToken) return businessAccessToken
		businessAccessTokenRequest ??= requestBusinessAccessToken()
		try {
			businessAccessToken = await businessAccessTokenRequest
			return businessAccessToken
		} finally {
			businessAccessTokenRequest = undefined
		}
	}

	const executeBusinessGraph = async <T>(documentId: string, variables: Record<string, unknown>) => {
		for (let attempt = 0; attempt < 2; attempt++) {
			const token = await getBusinessAccessToken()
			try {
				return await executeBusinessGraphQuery<T>(
					token,
					documentId,
					variables,
					jidDecode(authState.creds.me?.id)?.device
				)
			} catch (error) {
				if (!isBusinessGraphAuthError(error) || attempt > 0) throw error
				businessAccessToken = undefined
			}
		}

		throw new Boom('Unable to authenticate business GraphQL request', { statusCode: 401 })
	}

	const ownBusinessJid = () =>
		jidNormalizedUser(
			sock.serverProps.catalogGraphqlUseLid
				? authState.creds.me?.lid || authState.creds.me?.id || ''
				: authState.creds.me?.id || authState.creds.me?.lid || ''
		)
	const isOwnBusinessJid = (jid: string) => {
		const normalized = jidNormalizedUser(jid)
		return [authState.creds.me?.id, authState.creds.me?.lid]
			.filter((value): value is string => !!value)
			.map(jidNormalizedUser)
			.includes(normalized)
	}

	const updateBussinesProfile = async (args: UpdateBussinesProfileProps) => {
		const node: BinaryNode[] = []
		const simpleFields: (keyof UpdateBussinesProfileProps)[] = ['address', 'email', 'description']

		node.push(
			...simpleFields
				.filter(key => args[key] !== undefined && args[key] !== null)
				.map(key => ({
					tag: key,
					attrs: {},
					content: args[key] as string
				}))
		)

		if (args.websites !== undefined) {
			node.push(
				...args.websites.map(website => ({
					tag: 'website',
					attrs: {},
					content: website
				}))
			)
		}

		if (args.hours !== undefined) {
			node.push({
				tag: 'business_hours',
				attrs: { timezone: args.hours.timezone },
				content: args.hours.days.map(dayConfig => {
					const base = {
						tag: 'business_hours_config',
						attrs: {
							day_of_week: dayConfig.day,
							mode: dayConfig.mode
						}
					} as const

					if (dayConfig.mode === 'specific_hours') {
						return {
							...base,
							attrs: {
								...base.attrs,
								open_time: dayConfig.openTimeInMinutes,
								close_time: dayConfig.closeTimeInMinutes
							}
						}
					}

					return base
				})
			})
		}

		const result = await query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'set',
				xmlns: 'w:biz'
			},
			content: [
				{
					tag: 'business_profile',
					attrs: {
						v: '3',
						mutation_type: 'delta'
					},
					content: node
				}
			]
		})

		return result
	}

	const updateCoverPhoto = async (photo: WAMediaUpload) => {
		const { fileSha256, filePath } = await getRawMediaUploadData(photo, 'biz-cover-photo')
		const fileSha256B64 = fileSha256.toString('base64')

		const { meta_hmac, fbid, ts } = await waUploadToServer(filePath, {
			fileEncSha256B64: fileSha256B64,
			mediaType: 'biz-cover-photo'
		})

		await query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'set',
				xmlns: 'w:biz'
			},
			content: [
				{
					tag: 'business_profile',
					attrs: {
						v: '3',
						mutation_type: 'delta'
					},
					content: [
						{
							tag: 'cover_photo',
							attrs: { id: String(fbid), op: 'update', token: meta_hmac!, ts: String(ts) }
						}
					]
				}
			]
		})

		return fbid!
	}

	const removeCoverPhoto = async (id: string) => {
		return await query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'set',
				xmlns: 'w:biz'
			},
			content: [
				{
					tag: 'business_profile',
					attrs: {
						v: '3',
						mutation_type: 'delta'
					},
					content: [
						{
							tag: 'cover_photo',
							attrs: { op: 'delete', id }
						}
					]
				}
			]
		})
	}

	const getCatalog = async ({ jid, limit, cursor }: GetCatalogOptions) => {
		jid = jid || authState.creds.me?.id
		jid = jidNormalizedUser(jid)
		if (isOwnBusinessJid(jid)) {
			const data = await executeBusinessGraph<Record<string, unknown>>(
				BUSINESS_GRAPH_QUERIES.catalog,
				catalogGraphRequest(ownBusinessJid(), limit || 10, cursor)
			)
			return parseBusinessGraphCatalog(data)
		}

		const mex = BUSINESS_MEX_QUERIES.catalog
		const result = await executeWMexQuery<unknown>(
			catalogMexVariables(jid, limit || 10, cursor),
			mex.queryId,
			mex.dataPath
		)
		return parseMexCatalog(result)
	}

	const createCatalog = async () => {
		const data = await executeBusinessGraph<Record<string, unknown>>(BUSINESS_GRAPH_QUERIES.createCatalog, {
			input: {
				product_catalog: { biz_jid: ownBusinessJid() },
				platform: 'WEB'
			}
		})
		const envelope = data.xfb_whatsapp_catalog_create as Record<string, unknown> | undefined
		return { created: envelope?.success === true }
	}

	const updateCartEnabled = async (enabled: boolean) => {
		const data = await executeBusinessGraph<Record<string, unknown>>(BUSINESS_GRAPH_QUERIES.updateCommerceSettings, {
			input: { biz_jid: ownBusinessJid(), cart_enabled: enabled }
		})
		const envelope = data.xfb_whatsapp_smb_commerce_settings as Record<string, unknown> | undefined
		if (typeof envelope?.cart_enabled !== 'boolean')
			throw new Boom('Update commerce settings response did not contain cart_enabled', { statusCode: 502 })
		return { cartEnabled: envelope.cart_enabled }
	}

	const getCollections = async (jid?: string, limit = 51, cursor?: string) => {
		jid = jid || authState.creds.me?.id
		jid = jidNormalizedUser(jid)
		if (isOwnBusinessJid(jid)) {
			const data = await executeBusinessGraph<Record<string, unknown>>(
				BUSINESS_GRAPH_QUERIES.collections,
				collectionsGraphRequest(ownBusinessJid(), limit, cursor)
			)
			return parseBusinessGraphCollections(data)
		}

		const mex = BUSINESS_MEX_QUERIES.collections
		const result = await executeWMexQuery<unknown>(
			collectionsMexVariables(jid, limit, cursor),
			mex.queryId,
			mex.dataPath
		)
		return parseMexCollections(result)
	}

	const getOrderDetails = async (orderId: string, tokenBase64: string, jid?: string) => {
		return fetchMexOrderDetails({
			orderId,
			token: tokenBase64,
			requestedJid: jid || ownBusinessJid(),
			ownJids: [authState.creds.me?.id, authState.creds.me?.lid],
			executeQuery: executeWMexQuery,
			logger: config.logger
		})
	}

	const productUpdate = async (productId: string, update: ProductUpdate) => {
		update = await uploadingNecessaryImagesOfProduct(update, waUploadToServer)
		const data = await executeBusinessGraph<Record<string, unknown>>(BUSINESS_GRAPH_QUERIES.editProduct, {
			input: {
				product: {
					biz_jid: ownBusinessJid(),
					product_id: productId,
					width: 100,
					height: 100,
					product_info: productGraphInput(update)
				}
			}
		})
		const envelope = data.xfb_whatsapp_catalog_edit_product as Record<string, unknown> | undefined
		return parseBusinessGraphProduct(envelope?.product, 'xfb_whatsapp_catalog_edit_product.product')
	}

	const productCreate = async (create: ProductCreate) => {
		// ensure isHidden is defined
		create.isHidden = !!create.isHidden
		create = await uploadingNecessaryImagesOfProduct(create, waUploadToServer)
		const variables = {
			input: {
				product: {
					biz_jid: ownBusinessJid(),
					width: 100,
					height: 100,
					product_info: productGraphInput(create)
				}
			}
		}
		let data: Record<string, unknown>
		try {
			data = await executeBusinessGraph<Record<string, unknown>>(BUSINESS_GRAPH_QUERIES.addProduct, variables)
		} catch (error) {
			if (!isBusinessGraphMissingCatalogError(error)) throw error
			await createCatalog()
			data = await executeBusinessGraph<Record<string, unknown>>(BUSINESS_GRAPH_QUERIES.addProduct, variables)
		}

		const envelope = data.xfb_whatsapp_catalog_add_product as Record<string, unknown> | undefined
		return parseBusinessGraphProduct(envelope?.product, 'xfb_whatsapp_catalog_add_product.product')
	}

	const productDelete = async (productIds: string[]) => {
		const data = await executeBusinessGraph<Record<string, unknown>>(BUSINESS_GRAPH_QUERIES.deleteProduct, {
			input: { biz_jid: ownBusinessJid(), product_ids: productIds }
		})
		const envelope = data.xfb_whatsapp_catalog_delete_product as Record<string, unknown> | undefined
		return { deleted: Number(envelope?.deleted_count ?? 0) }
	}

	const createCollection = async (
		options: CreateCatalogCollectionOptions
	): Promise<CatalogCollectionMutationResult> => {
		const data = await executeBusinessGraph<Record<string, unknown>>(BUSINESS_GRAPH_QUERIES.createCollection, {
			input: {
				collection: {
					name: options.name,
					product_ids: options.productIds,
					biz_jid: ownBusinessJid(),
					catalog_session_id: options.catalogSessionId ?? null
				}
			}
		})
		const envelope = data.xfb_whatsapp_catalog_create_collection as Record<string, unknown> | undefined
		const collection = envelope?.collection as Record<string, unknown> | undefined
		const status = collection?.status_info as Record<string, unknown> | undefined
		if (typeof collection?.id !== 'string')
			throw new Boom('Create collection response did not contain an id', { statusCode: 502 })
		return { id: collection.id, reviewStatus: typeof status?.status === 'string' ? status.status : '' }
	}

	const updateCollection = async (
		options: UpdateCatalogCollectionOptions
	): Promise<CatalogCollectionMutationResult> => {
		const collection: Record<string, unknown> = {
			id: options.collectionId,
			biz_jid: ownBusinessJid(),
			catalog_session_id: options.catalogSessionId ?? null
		}
		if (options.name !== undefined) collection.name = options.name
		if (options.addProductIds?.length) collection.add = { ids: options.addProductIds }
		if (options.removeProductIds?.length) collection.remove = { ids: options.removeProductIds }
		const data = await executeBusinessGraph<Record<string, unknown>>(BUSINESS_GRAPH_QUERIES.updateCollection, {
			input: { collection }
		})
		const envelope = data.xfb_whatsapp_catalog_update_collection as Record<string, unknown> | undefined
		const result = envelope?.collection as Record<string, unknown> | undefined
		const status = result?.status_info as Record<string, unknown> | undefined
		if (typeof result?.id !== 'string')
			throw new Boom('Update collection response did not contain an id', { statusCode: 502 })
		return { id: result.id, reviewStatus: typeof status?.status === 'string' ? status.status : '' }
	}

	const deleteCollections = async (collectionIds: string[], catalogSessionId?: string) => {
		const data = await executeBusinessGraph<Record<string, unknown>>(BUSINESS_GRAPH_QUERIES.deleteCollections, {
			input: {
				collections: {
					collection_ids: collectionIds,
					biz_jid: ownBusinessJid(),
					catalog_session_id: catalogSessionId ?? null
				}
			}
		})
		const envelope = data.xfb_whatsapp_catalog_delete_collections as Record<string, unknown> | undefined
		return { deleted: envelope?.success === true ? collectionIds.length : 0 }
	}

	return {
		...sock,
		logger: config.logger,
		getOrderDetails,
		createCatalog,
		updateCartEnabled,
		getCatalog,
		getCollections,
		productCreate,
		productDelete,
		productUpdate,
		createCollection,
		updateCollection,
		deleteCollections,
		updateBussinesProfile,
		updateCoverPhoto,
		removeCoverPhoto
	}
}
