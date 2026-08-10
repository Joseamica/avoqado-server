import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StaffRole } from '@prisma/client'
import { z } from 'zod'
import { authorizeCatalogRequest } from '@/services/master-catalog/catalogAuthorization.service'
import { getCatalogItem, listCatalogItems } from '@/services/master-catalog/catalogItem.service'
import { confirmCatalogImport, previewCatalogImport } from '@/services/master-catalog/catalogImport.service'
import {
  CATALOG_OVERRIDE_REQUEST_CAP,
  confirmCatalogOverrideRequest,
  previewCatalogOverrideRequest,
} from '@/services/master-catalog/catalogOverride.service'
import {
  CATALOG_PUBLICATION_TARGET_CAP,
  isCatalogPublicationIdempotencyKey,
} from '@/services/master-catalog/catalogPublicationPreview.service'
import { catalogPublicationService } from '@/services/master-catalog/catalogPublication.service'
import { resolveCatalogVenueContext } from '@/services/master-catalog/masterCatalogRead.service'
import { ScopeError, requireCatalogWriteScope } from '../guard'
import { text } from '../respond'
import type { McpScope } from '../scope'

function authContext(scope: McpScope) {
  return {
    userId: scope.staffId,
    orgId: scope.activeOrg,
    venueId: '',
    role: StaffRole.VIEWER,
    realUserId: scope.staffId,
    realRole: StaffRole.VIEWER,
    isImpersonating: false,
    impersonation: null,
  }
}

function organizationId(scope: McpScope): string {
  if (!scope.organizationId || !scope.orgRole || scope.isSuperAdmin) throw new ScopeError('Active organization membership required')
  return scope.organizationId
}

function readContext(scope: McpScope) {
  return authorizeCatalogRequest({
    authContext: authContext(scope),
    routeOrganizationId: organizationId(scope),
    capability: 'READ',
    requiredGate: 'CORE',
  })
}

function commandContext(scope: McpScope) {
  requireCatalogWriteScope(scope)
  return authorizeCatalogRequest({
    authContext: authContext(scope),
    routeOrganizationId: organizationId(scope),
    capability: 'COMMAND',
    commandCapability: 'MUTATE_CONTENT',
    requiredGate: 'CORE',
  })
}

export function registerMasterCatalogTools(server: McpServer, scope: McpScope) {
  server.tool(
    'list_catalog_items',
    'List corporate catalog items in the active organization.',
    {
      cursor: z.string().max(512).optional(),
      pageSize: z.number().int().min(1).max(100).optional(),
      status: z.enum(['ACTIVE', 'RETIRED']).optional(),
    },
    async input => text(await listCatalogItems(await readContext(scope), input as never)),
  )

  server.tool(
    'get_catalog_item',
    'Get one corporate catalog item by id.',
    { catalogItemId: z.string().min(1).max(256) },
    async ({ catalogItemId }) => text(await getCatalogItem(await readContext(scope), catalogItemId)),
  )

  server.tool(
    'preview_catalog_import',
    'Validate a base64 XLSX import and create a confirmation preview.',
    {
      fileBase64: z
        .string()
        .min(1)
        .max(14 * 1024 * 1024),
      originalFilename: z.string().min(1).max(255),
    },
    async ({ fileBase64, originalFilename }) =>
      text(
        await previewCatalogImport(await commandContext(scope), {
          buffer: Buffer.from(fileBase64, 'base64'),
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          originalFilename,
        }),
      ),
  )

  server.tool(
    'confirm_catalog_import',
    'Confirm a previously previewed catalog import.',
    {
      importBatchId: z.string().min(1).max(256),
      previewToken: z.string().min(1).max(512),
      idempotencyKey: z.string().min(1).max(200),
      confirm: z.literal(true),
    },
    async input => text(await confirmCatalogImport(await commandContext(scope), input)),
  )

  server.tool(
    'preview_catalog_publication',
    'Preview a catalog publication operation.',
    {
      operation: z.enum(['CATALOG_FIELDS_PUBLISH', 'CATALOG_PRODUCT_ACTIVATION', 'CATALOG_FIELDS_REVERSION']),
      idempotencyKey: z.string().refine(isCatalogPublicationIdempotencyKey),
      targets: z.array(z.record(z.string(), z.unknown())).min(1).max(CATALOG_PUBLICATION_TARGET_CAP),
    },
    async input => text(await catalogPublicationService.preview(await commandContext(scope), input as never)),
  )

  server.tool(
    'confirm_catalog_publication',
    'Confirm a previously previewed catalog publication.',
    {
      publicationBatchId: z.string().min(1).max(256),
      previewToken: z.string().min(1).max(512),
      idempotencyKey: z.string().refine(isCatalogPublicationIdempotencyKey),
      confirm: z.literal(true),
    },
    async input => text(await catalogPublicationService.confirm(await commandContext(scope), input as never)),
  )

  server.tool(
    'request_catalog_override',
    'Request a local managed-field override for a catalog-bound venue product.',
    {
      phase: z.enum(['PREVIEW', 'CONFIRM']),
      venueId: z.string().min(1).max(256),
      bindingId: z.string().min(1).max(256).optional(),
      idempotencyKey: z.string().min(1).max(200),
      requests: z
        .array(
          z.object({
            field: z.enum([
              'cost',
              'description',
              'imageUrl',
              'name',
              'objetoImp',
              'satProductKey',
              'satUnitKey',
              'taxRate',
              'type',
              'unit',
            ]),
            reason: z.string().min(1).max(1000),
          }),
        )
        .min(1)
        .max(CATALOG_OVERRIDE_REQUEST_CAP)
        .optional(),
      requestBatchId: z.string().min(1).max(256).optional(),
      previewToken: z.string().min(1).max(512).optional(),
      confirm: z.literal(true).optional(),
    },
    async input => {
      const previewSchema = z
        .object({
          phase: z.literal('PREVIEW'),
          venueId: z.string().min(1).max(256),
          bindingId: z.string().min(1).max(256),
          idempotencyKey: z.string().min(1).max(200),
          requests: z
            .array(
              z.object({
                field: z.enum([
                  'cost',
                  'description',
                  'imageUrl',
                  'name',
                  'objetoImp',
                  'satProductKey',
                  'satUnitKey',
                  'taxRate',
                  'type',
                  'unit',
                ]),
                reason: z.string().min(1).max(1000),
              }),
            )
            .min(1)
            .max(CATALOG_OVERRIDE_REQUEST_CAP),
        })
        .strict()
      const confirmSchema = z
        .object({
          phase: z.literal('CONFIRM'),
          venueId: z.string().min(1).max(256),
          requestBatchId: z.string().min(1).max(256),
          previewToken: z.string().min(1).max(512),
          idempotencyKey: z.string().min(1).max(200),
          confirm: z.literal(true),
        })
        .strict()
      const parsed = input.phase === 'PREVIEW' ? previewSchema.parse(input) : confirmSchema.parse(input)
      // Local override authority is the live Task 8 StaffVenue/custom-permission
      // check. Recheck active organization/gate with READ, not corporate mutate,
      // so an org VIEWER who is a venue MANAGER keeps the same HTTP permission.
      requireCatalogWriteScope(scope)
      const context = await readContext(scope)
      const venueContext = await resolveCatalogVenueContext(parsed.venueId, context.actor, context.organizationId)
      if (parsed.phase === 'PREVIEW') {
        const { bindingId, idempotencyKey, requests } = parsed
        return text(await previewCatalogOverrideRequest(venueContext, { bindingId, idempotencyKey, requests }))
      }
      const { requestBatchId, previewToken, idempotencyKey, confirm } = parsed
      return text(await confirmCatalogOverrideRequest(venueContext, { requestBatchId, previewToken, idempotencyKey, confirm }))
    },
  )
}
