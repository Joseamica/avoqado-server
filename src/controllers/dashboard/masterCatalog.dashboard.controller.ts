import type { NextFunction, Request, Response } from 'express'
import AppError from '../../errors/AppError'
import {
  catalogOrganizationParamsSchema,
  catalogActivityLogQuerySchema,
  catalogItemListQuerySchema,
  catalogPublicationListQuerySchema,
  catalogPublicationLookupParamsSchema,
  catalogPublicationParamsSchema,
  catalogReferenceListQuerySchema,
  catalogVenueChangesQuerySchema,
  catalogCommandBodySchemas,
  catalogCommandRequestSchemas,
} from '../../schemas/dashboard/masterCatalog.schema'
import type { z } from 'zod'
import { authorizeCatalogRequest } from '../../services/master-catalog/catalogAuthorization.service'
import { catalogPublicationService } from '../../services/master-catalog/catalogPublication.service'
import {
  getCatalogPublication,
  getCatalogVenueAccess,
  listCatalogPublications,
  resolveCatalogVenueContext,
} from '../../services/master-catalog/masterCatalogRead.service'
import { resolveMasterCatalogAccess } from '../../services/master-catalog/masterCatalogAccess.service'
import {
  createCatalogItem,
  getCatalogItem,
  listCatalogItems,
  retireCatalogItem,
  updateCatalogItem,
} from '../../services/master-catalog/catalogItem.service'
import {
  createCatalogBrand,
  createCatalogFamily,
  createCatalogManufacturer,
  listCatalogReferences,
  retireCatalogBrand,
  retireCatalogFamily,
  retireCatalogManufacturer,
  updateCatalogBrand,
  updateCatalogFamily,
  updateCatalogManufacturer,
} from '../../services/master-catalog/catalogReference.service'
import { confirmCatalogValidationProfile, previewCatalogValidationProfile } from '../../services/master-catalog/catalogValidation.service'
import { confirmCatalogImport, previewCatalogImport } from '../../services/master-catalog/catalogImport.service'
import { confirmCatalogBindings, previewCatalogBindings } from '../../services/master-catalog/catalogBinding.service'
import { getCatalogImport, listCatalogValidationProfiles } from '../../services/master-catalog/masterCatalogRead.service'
import { getCatalogVenueProvenance, listCatalogVenueChanges } from '../../services/master-catalog/catalogOverrideRead.service'
import { confirmCatalogOverrideRequest, previewCatalogOverrideRequest } from '../../services/master-catalog/catalogOverride.service'
import { getDistinctActions, queryActivityLogs } from '../../services/dashboard/activity-log.service'

function parsed<T>(result: { success: true; data: T } | { success: false; error: { issues: unknown[] } }): T {
  if (result.success) return result.data
  throw new AppError('Solicitud de catálogo inválida', 422, true, 'CATALOG_REQUEST_INVALID', result.error.issues)
}

function assertQueryContract(req: Request, allowedKeys: readonly string[] = [], venueScoped = false) {
  const keys = Object.keys(req.query)
  const scopeKeys = venueScoped ? ['organizationId', 'orgId', 'venueId'] : ['organizationId', 'orgId']
  if (keys.some(key => scopeKeys.includes(key))) {
    throw new AppError('El scope sólo puede venir de la ruta', 422, true, 'CATALOG_SCOPE_FORGED')
  }
  const unknown = keys.filter(key => !allowedKeys.includes(key))
  if (unknown.length) {
    throw new AppError('Solicitud de catálogo inválida', 422, true, 'CATALOG_REQUEST_INVALID', { unknownQueryKeys: unknown })
  }
}

async function readContext(req: Request, allowedQueryKeys: readonly string[] = []) {
  assertQueryContract(req, allowedQueryKeys)
  const { orgId } = parsed(catalogOrganizationParamsSchema.safeParse(req.params))
  return authorizeCatalogRequest({ authContext: req.authContext, routeOrganizationId: orgId, capability: 'READ', requiredGate: 'CORE' })
}

async function commandContext(req: Request, commandCapability: 'MUTATE_CONTENT' | 'MANAGE_PROFILE' = 'MUTATE_CONTENT') {
  assertQueryContract(req)
  const { orgId } = parsed(catalogOrganizationParamsSchema.safeParse(req.params))
  return authorizeCatalogRequest({
    authContext: req.authContext,
    routeOrganizationId: orgId,
    capability: 'COMMAND',
    commandCapability,
    requiredGate: 'CORE',
  })
}

function requestBody(req: Request): Record<string, unknown> {
  const value = req.body
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AppError('El cuerpo de catálogo debe ser un objeto', 422, true, 'CATALOG_REQUEST_INVALID')
  }
  const body = value as Record<string, unknown>
  if ('organizationId' in body || 'orgId' in body) {
    throw new AppError('La organización sólo puede venir de la ruta', 422, true, 'CATALOG_SCOPE_FORGED')
  }
  return body
}

function commandBody<Schema extends z.ZodTypeAny>(req: Request, schema: Schema): z.infer<Schema> {
  return parsed(schema.safeParse(requestBody(req)))
}

function venueRequestBody(req: Request): Record<string, unknown> {
  const body = requestBody(req)
  if ('venueId' in body) throw new AppError('La sucursal sólo puede venir de la ruta', 422, true, 'CATALOG_SCOPE_FORGED')
  return body
}

async function venueContext(req: Request, allowedQueryKeys: readonly string[] = []) {
  assertQueryContract(req, allowedQueryKeys, true)
  if (!req.authContext?.userId) throw new AppError('Autenticación requerida', 401, true, 'AUTHENTICATION_REQUIRED')
  return resolveCatalogVenueContext(idParam(req, 'venueId'), {
    type: 'HUMAN',
    staffId: req.authContext.userId,
    impersonating: req.authContext.isImpersonating === true,
  })
}

function idParam(req: Request, key: string): string {
  const value = req.params[key]
  if (typeof value !== 'string' || !value.trim() || value.length > 256) {
    throw new AppError(`${key} no válido`, 422, true, 'CATALOG_REQUEST_INVALID')
  }
  return value
}

export { readContext as readMasterCatalogContext, idParam as readMasterCatalogIdParam }

async function respond(res: Response, work: Promise<unknown>, status = 200) {
  res.status(status).json({ success: true, data: await work })
}

function endpoint(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => void handler(req, res).catch(next)
}

export const getAccess = endpoint(async (req, res) => {
  const context = await readContext(req)
  // The envelope reports one verdict per capability, so each one has to be
  // asked for. `canMutateContent` only ever comes back true from a
  // MUTATE_CONTENT resolution, so resolving READ_CONTENT alone reported every
  // caller as read-only — including OWNER — and the writer screens never
  // rendered for anyone.
  const [read, mutate] = await Promise.all([
    resolveMasterCatalogAccess({
      organizationId: context.organizationId,
      principal: context.actor,
      capability: 'READ_CONTENT',
      requiredGate: 'CORE',
    }),
    resolveMasterCatalogAccess({
      organizationId: context.organizationId,
      principal: context.actor,
      capability: 'MUTATE_CONTENT',
      requiredGate: 'CORE',
    }),
  ])
  // Read is the floor: a caller who cannot see the catalog cannot write it,
  // whatever the mutation resolver answers on its own.
  const access = { ...read, canMutateContent: read.canRead && mutate.canMutateContent }
  res.status(200).json({ success: true, data: access })
})

export const getPublicationByIdempotencyKey = endpoint(async (req, res) => {
  const input = parsed(catalogPublicationLookupParamsSchema.safeParse(req.params))
  const context = await readContext(req)
  const data = await catalogPublicationService.getByIdempotencyKey(context, {
    operation: input.operation,
    idempotencyKey: input.idempotencyKey,
  })
  res.status(200).json({ success: true, data })
})

export const getPublication = endpoint(async (req, res) => {
  const { publicationBatchId } = parsed(catalogPublicationParamsSchema.safeParse(req.params))
  const context = await readContext(req)
  const data = await getCatalogPublication(context, publicationBatchId)
  res.status(200).json({ success: true, data })
})

export const listPublications = endpoint(async (req, res) => {
  const input = parsed(catalogPublicationListQuerySchema.safeParse(req.query))
  const context = await readContext(req, ['cursor', 'pageSize', 'operation', 'state'])
  const data = await listCatalogPublications(context, input)
  res.status(200).json({ success: true, data })
})

export const listItems = endpoint(async (req, res) => {
  const context = await readContext(req, ['cursor', 'pageSize', 'status'])
  await respond(res, listCatalogItems(context, parsed(catalogItemListQuerySchema.safeParse(req.query))))
})

export const createItem = endpoint(async (req, res) => {
  const context = await commandContext(req)
  await respond(res, createCatalogItem(context, commandBody(req, catalogCommandBodySchemas.createItem)), 201)
})

export const getItem = endpoint(async (req, res) => {
  await respond(res, getCatalogItem(await readContext(req), idParam(req, 'catalogItemId')))
})

export const updateItem = endpoint(async (req, res) => {
  const context = await commandContext(req)
  await respond(
    res,
    updateCatalogItem(context, { ...commandBody(req, catalogCommandBodySchemas.updateItem), catalogItemId: idParam(req, 'catalogItemId') }),
  )
})

export const retireItem = endpoint(async (req, res) => {
  const context = await commandContext(req)
  await respond(
    res,
    retireCatalogItem(context, { ...commandBody(req, catalogCommandBodySchemas.retireItem), catalogItemId: idParam(req, 'catalogItemId') }),
  )
})

export const listValidationProfiles = endpoint(async (req, res) => {
  await respond(res, listCatalogValidationProfiles(await readContext(req)))
})

export const previewValidationProfile = endpoint(async (req, res) => {
  await respond(
    res,
    previewCatalogValidationProfile(
      await commandContext(req, 'MANAGE_PROFILE'),
      commandBody(req, catalogCommandBodySchemas.previewValidationProfile),
    ),
  )
})

export const confirmValidationProfile = endpoint(async (req, res) => {
  await respond(
    res,
    confirmCatalogValidationProfile(await commandContext(req, 'MANAGE_PROFILE'), {
      ...commandBody(req, catalogCommandBodySchemas.confirmValidationProfile),
      profileBatchId: idParam(req, 'profileBatchId'),
    } as never),
  )
})

type ReferenceKind = 'BRAND' | 'MANUFACTURER' | 'FAMILY'

async function listReference(req: Request, res: Response, referenceType: ReferenceKind) {
  const query = parsed(catalogReferenceListQuerySchema.safeParse(req.query))
  await respond(res, listCatalogReferences(await readContext(req, ['cursor', 'pageSize', 'status']), { ...query, referenceType }))
}

export const listBrands = endpoint((req, res) => listReference(req, res, 'BRAND'))
export const listManufacturers = endpoint((req, res) => listReference(req, res, 'MANUFACTURER'))
export const listFamilies = endpoint((req, res) => listReference(req, res, 'FAMILY'))

export const createBrand = endpoint(async (req, res) =>
  respond(res, createCatalogBrand(await commandContext(req), commandBody(req, catalogCommandBodySchemas.createBrand)), 201),
)
export const createManufacturer = endpoint(async (req, res) =>
  respond(res, createCatalogManufacturer(await commandContext(req), commandBody(req, catalogCommandBodySchemas.createManufacturer)), 201),
)
export const createFamily = endpoint(async (req, res) =>
  respond(res, createCatalogFamily(await commandContext(req), commandBody(req, catalogCommandBodySchemas.createFamily)), 201),
)

export const updateBrand = endpoint(async (req, res) =>
  respond(
    res,
    updateCatalogBrand(await commandContext(req), {
      ...commandBody(req, catalogCommandBodySchemas.updateBrand),
      referenceId: idParam(req, 'brandId'),
    }),
  ),
)
export const updateManufacturer = endpoint(async (req, res) =>
  respond(
    res,
    updateCatalogManufacturer(await commandContext(req), {
      ...commandBody(req, catalogCommandBodySchemas.updateManufacturer),
      referenceId: idParam(req, 'manufacturerId'),
    }),
  ),
)
export const updateFamily = endpoint(async (req, res) =>
  respond(
    res,
    updateCatalogFamily(await commandContext(req), {
      ...commandBody(req, catalogCommandBodySchemas.updateFamily),
      referenceId: idParam(req, 'familyId'),
    }),
  ),
)

export const retireBrand = endpoint(async (req, res) =>
  respond(
    res,
    retireCatalogBrand(await commandContext(req), {
      ...commandBody(req, catalogCommandBodySchemas.retireBrand),
      referenceId: idParam(req, 'brandId'),
    }),
  ),
)
export const retireManufacturer = endpoint(async (req, res) =>
  respond(
    res,
    retireCatalogManufacturer(await commandContext(req), {
      ...commandBody(req, catalogCommandBodySchemas.retireManufacturer),
      referenceId: idParam(req, 'manufacturerId'),
    }),
  ),
)
export const retireFamily = endpoint(async (req, res) =>
  respond(
    res,
    retireCatalogFamily(await commandContext(req), {
      ...commandBody(req, catalogCommandBodySchemas.retireFamily),
      referenceId: idParam(req, 'familyId'),
    }),
  ),
)

export const previewImport = endpoint(async (req, res) => {
  if (!req.file) throw new AppError('El archivo XLSX es requerido', 422, true, 'CATALOG_IMPORT_REQUEST_INVALID')
  requestBody(req)
  const input = parsed(catalogCommandRequestSchemas.previewImport.safeParse({ params: req.params, file: req.file }))
  const context = await commandContext(req)
  await respond(
    res,
    previewCatalogImport(context, {
      buffer: input.file.buffer,
      mimeType: input.file.mimetype,
      originalFilename: input.file.originalname,
    }),
  )
})

export const getImport = endpoint(async (req, res) => {
  await respond(res, getCatalogImport(await readContext(req), idParam(req, 'importBatchId')))
})

export const confirmImport = endpoint(async (req, res) => {
  await respond(
    res,
    confirmCatalogImport(await commandContext(req), {
      ...commandBody(req, catalogCommandBodySchemas.confirmImport),
      importBatchId: idParam(req, 'importBatchId'),
    }),
  )
})

export const previewBindings = endpoint(async (req, res) =>
  respond(res, previewCatalogBindings(await commandContext(req), commandBody(req, catalogCommandBodySchemas.previewBindings))),
)
export const confirmBindings = endpoint(async (req, res) =>
  respond(res, confirmCatalogBindings(await commandContext(req), commandBody(req, catalogCommandBodySchemas.confirmBindings))),
)
export const previewPublication = endpoint(async (req, res) =>
  respond(
    res,
    catalogPublicationService.preview(await commandContext(req), commandBody(req, catalogCommandBodySchemas.previewPublication)),
  ),
)
export const confirmPublication = endpoint(async (req, res) =>
  respond(
    res,
    catalogPublicationService.confirm(await commandContext(req), {
      ...commandBody(req, catalogCommandBodySchemas.confirmPublication),
      publicationBatchId: idParam(req, 'publicationBatchId'),
    } as never),
  ),
)
export const previewPublicationReversal = endpoint(async (req, res) => {
  const context = await commandContext(req)
  await respond(
    res,
    catalogPublicationService.preview(context, {
      operation: 'CATALOG_FIELDS_REVERSION',
      sourcePublicationBatchId: idParam(req, 'publicationBatchId'),
      ...commandBody(req, catalogCommandBodySchemas.previewPublicationReversal),
    }),
  )
})

export const listAudit = endpoint(async (req, res) => {
  const context = await readContext(req, ['venueId', 'staffId', 'action', 'entity', 'search', 'startDate', 'endDate', 'page', 'pageSize'])
  const { venueId, staffId, action, entity, search, startDate, endDate, page, pageSize } = parsed(
    catalogActivityLogQuerySchema.safeParse(req.query),
  )
  await respond(
    res,
    queryActivityLogs({
      organizationId: context.organizationId,
      venueId: venueId as string | undefined,
      staffId: staffId as string | undefined,
      action: action as string | undefined,
      entity: entity as string | undefined,
      search: search as string | undefined,
      startDate: startDate as string | undefined,
      endDate: endDate as string | undefined,
      page,
      pageSize,
    }),
  )
})

export const listAuditActions = endpoint(async (req, res) => {
  const context = await readContext(req)
  await respond(res, getDistinctActions(context.organizationId))
})

export const getVenueAccess = endpoint(async (req, res) => {
  const context = await venueContext(req)
  await respond(res, getCatalogVenueAccess(context))
})

export const getVenueProvenance = endpoint(async (req, res) =>
  respond(res, getCatalogVenueProvenance(await venueContext(req), { productId: idParam(req, 'productId') })),
)

export const listVenueChanges = endpoint(async (req, res) =>
  respond(
    res,
    listCatalogVenueChanges(await venueContext(req, ['cursor', 'pageSize']), parsed(catalogVenueChangesQuerySchema.safeParse(req.query))),
  ),
)

export const previewVenueOverride = endpoint(async (req, res) =>
  respond(
    res,
    previewCatalogOverrideRequest(
      await venueContext(req),
      parsed(catalogCommandBodySchemas.previewVenueOverride.safeParse(venueRequestBody(req))),
    ),
  ),
)

export const confirmVenueOverride = endpoint(async (req, res) =>
  respond(
    res,
    confirmCatalogOverrideRequest(await venueContext(req), {
      ...parsed(catalogCommandBodySchemas.confirmVenueOverride.safeParse(venueRequestBody(req))),
      requestBatchId: idParam(req, 'requestBatchId'),
    } as never),
  ),
)
