import type { GetCatalogOptions, ProductCreate, ProductUpdate, SocketConfig, WAMediaUpload } from '../Types'
import type { UpdateBussinesProfileProps } from '../Types/Bussines'
import { getRawMediaUploadData } from '../Utils'
import { parseProductNode, toProductNode, uploadingNecessaryImagesOfProduct } from '../Utils/business'
import { parseMexCatalog, parseMexCollections, parseMexOrderDetails } from '../Utils/business-mex'
import { type BinaryNode, jidNormalizedUser, S_WHATSAPP_NET } from '../WABinary'
import { getBinaryNodeChild } from '../WABinary/generic-utils'
import { BUSINESS_MEX_QUERIES, catalogMexVariables, collectionsMexVariables, orderMexVariables } from './business-mex'
import { makeMessagesRecvSocket } from './messages-recv'
import { executeWMexQuery as genericExecuteWMexQuery } from './mex'

export const makeBusinessSocket = (config: SocketConfig) => {
	const sock = makeMessagesRecvSocket(config)
	const { authState, generateMessageTag, query, waUploadToServer } = sock
	const executeWMexQuery = <T>(variables: Record<string, unknown>, queryId: string, dataPath: string): Promise<T> =>
		genericExecuteWMexQuery<T>(variables, queryId, dataPath, query, generateMessageTag)

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
		const mex = BUSINESS_MEX_QUERIES.catalog
		const result = await executeWMexQuery<unknown>(
			catalogMexVariables(jid, limit || 10, cursor),
			mex.queryId,
			mex.dataPath
		)
		return parseMexCatalog(result)
	}

	const getCollections = async (jid?: string, limit = 51, cursor?: string) => {
		jid = jid || authState.creds.me?.id
		jid = jidNormalizedUser(jid)
		const mex = BUSINESS_MEX_QUERIES.collections
		const result = await executeWMexQuery<unknown>(
			collectionsMexVariables(jid, limit, cursor),
			mex.queryId,
			mex.dataPath
		)
		return parseMexCollections(result)
	}

	const getOrderDetails = async (orderId: string, tokenBase64: string, jid?: string) => {
		jid = jid || authState.creds.me?.id
		jid = jidNormalizedUser(jid)
		const mex = BUSINESS_MEX_QUERIES.order
		const result = await executeWMexQuery<unknown>(
			orderMexVariables(jid, orderId, tokenBase64),
			mex.queryId,
			mex.dataPath
		)
		return parseMexOrderDetails(result)
	}

	const productUpdate = async (productId: string, update: ProductUpdate) => {
		update = await uploadingNecessaryImagesOfProduct(update, waUploadToServer)
		const editNode = toProductNode(productId, update)

		const result = await query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'set',
				xmlns: 'w:biz:catalog'
			},
			content: [
				{
					tag: 'product_catalog_edit',
					attrs: { v: '1' },
					content: [
						editNode,
						{
							tag: 'width',
							attrs: {},
							content: '100'
						},
						{
							tag: 'height',
							attrs: {},
							content: '100'
						}
					]
				}
			]
		})

		const productCatalogEditNode = getBinaryNodeChild(result, 'product_catalog_edit')
		const productNode = getBinaryNodeChild(productCatalogEditNode, 'product')

		return parseProductNode(productNode!)
	}

	const productCreate = async (create: ProductCreate) => {
		// ensure isHidden is defined
		create.isHidden = !!create.isHidden
		create = await uploadingNecessaryImagesOfProduct(create, waUploadToServer)
		const createNode = toProductNode(undefined, create)

		const result = await query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'set',
				xmlns: 'w:biz:catalog'
			},
			content: [
				{
					tag: 'product_catalog_add',
					attrs: { v: '1' },
					content: [
						createNode,
						{
							tag: 'width',
							attrs: {},
							content: '100'
						},
						{
							tag: 'height',
							attrs: {},
							content: '100'
						}
					]
				}
			]
		})

		const productCatalogAddNode = getBinaryNodeChild(result, 'product_catalog_add')
		const productNode = getBinaryNodeChild(productCatalogAddNode, 'product')

		return parseProductNode(productNode!)
	}

	const productDelete = async (productIds: string[]) => {
		const result = await query({
			tag: 'iq',
			attrs: {
				to: S_WHATSAPP_NET,
				type: 'set',
				xmlns: 'w:biz:catalog'
			},
			content: [
				{
					tag: 'product_catalog_delete',
					attrs: { v: '1' },
					content: productIds.map(id => ({
						tag: 'product',
						attrs: {},
						content: [
							{
								tag: 'id',
								attrs: {},
								content: Buffer.from(id)
							}
						]
					}))
				}
			]
		})

		const productCatalogDelNode = getBinaryNodeChild(result, 'product_catalog_delete')
		return {
			deleted: +(productCatalogDelNode?.attrs.deleted_count || 0)
		}
	}

	return {
		...sock,
		logger: config.logger,
		getOrderDetails,
		getCatalog,
		getCollections,
		productCreate,
		productDelete,
		productUpdate,
		updateBussinesProfile,
		updateCoverPhoto,
		removeCoverPhoto
	}
}
