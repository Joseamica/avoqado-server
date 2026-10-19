import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { McpScope } from '../scope'
import { text } from '../respond'
import { requireWriteScopeAlways } from '../requireWriteScopeAlways'
import {
  createRequest,
  getAdminRequest,
  getPreviewUrl,
  listRequests,
  renewRequest,
  revokeRequest,
} from '@/services/document-requests/documentRequests.service'

import * as venueLinks from '@/services/document-requests/venueLinks.service'

const previewTarget = z.union([
  z.object({ requestId: z.string().cuid(), documentId: z.string().cuid() }).strict(),
  z.object({ venueId: z.string().cuid(), linkId: z.string().cuid(), documentId: z.string().cuid() }).strict(),
])

const denied = () => text({ ok: false, error: 'Sólo el equipo de Avoqado puede consultar expedientes de afiliación.' })

export function registerDocumentRequestTools(server: McpServer, scope: McpScope): void {
  if (!scope.isSuperAdmin) return

  server.tool(
    'preview_document_request_document',
    'Abre temporalmente un PDF o foto privada del expediente indicado o de una entrega anexada a un negocio. Elige un solo ámbito completo. Sólo para el equipo de Avoqado.',
    { target: previewTarget },
    async ({ target }) => {
      if (!scope.isSuperAdmin) return denied()
      const selected = previewTarget.parse(target)
      return text(
        'requestId' in selected
          ? await getPreviewUrl(selected.requestId, selected.documentId)
          : await venueLinks.getVenueDocumentPreview(selected.venueId, selected.linkId, selected.documentId),
      )
    },
  )

  const pageFields = { page: z.number().int().min(1).default(1), pageSize: z.number().int().min(1).max(100).default(10) }
  server.tool(
    'list_venue_document_requests',
    'Consulta los expedientes y versiones anexados a un negocio, con páginas. Sólo para el equipo de Avoqado.',
    { venueId: z.string().cuid(), ...pageFields },
    async ({ venueId, ...page }) => {
      if (!scope.isSuperAdmin) return denied()
      return text(await venueLinks.listVenueDocumentRequests(venueId, page))
    },
  )
  server.tool(
    'list_document_request_venue_options',
    'Busca negocios por nombre y organización para elegir dónde anexar un expediente. Sólo para el equipo de Avoqado.',
    { search: z.string().max(160).optional(), ...pageFields },
    async input => {
      if (!scope.isSuperAdmin) return denied()
      return text(await venueLinks.listVenueOptions(input))
    },
  )
  server.tool(
    'list_document_request_venue_links',
    'Consulta los negocios a los que se anexó un expediente, con versiones y páginas. Sólo para el equipo de Avoqado.',
    { id: z.string().cuid(), ...pageFields },
    async ({ id, ...page }) => {
      if (!scope.isSuperAdmin) return denied()
      return text(await venueLinks.listRequestVenueLinks(id, page))
    },
  )
  server.tool(
    'get_venue_document_request',
    'Consulta el contacto y los archivos de una entrega anexada a un negocio. Si indicas un documento de esa entrega, devuelve su descarga temporal privada. Sólo para Avoqado.',
    { venueId: z.string().cuid(), linkId: z.string().cuid(), documentId: z.string().cuid().optional() },
    async ({ venueId, linkId, documentId }) => {
      if (!scope.isSuperAdmin) return denied()
      return text(
        documentId
          ? await venueLinks.getVenueDocumentDownload(venueId, linkId, documentId)
          : await venueLinks.getVenueDocumentRequest(venueId, linkId),
      )
    },
  )
  server.tool(
    'link_document_request_to_venue',
    'Anexa una versión enviada de un expediente al negocio elegido. Revisa negocio y organización en la vista previa y confirma expresamente; no aprueba la afiliación. Sólo para Avoqado.',
    { id: z.string().cuid(), venueId: z.string().cuid(), submissionVersion: z.number().int().min(1), confirm: z.boolean().default(false) },
    async ({ id, venueId, submissionVersion, confirm }) => {
      if (!scope.isSuperAdmin) return denied()
      requireWriteScopeAlways(scope, 'document-requests:link', 'anexa documentos privados a un negocio')
      if (!confirm)
        return text({
          ok: false,
          requiresConfirmation: true,
          preview: await venueLinks.previewRequestVenueLink(id, { venueId, submissionVersion, confirmed: true }),
          change: 'Expediente recibido → documentos privados anexados al negocio y su organización. No cambia la aprobación ni los cobros.',
        })
      return text(await venueLinks.linkRequestToVenue(id, { venueId, submissionVersion, confirmed: true }, scope.staffId))
    },
  )

  server.tool(
    'list_document_requests',
    'Lista expedientes de afiliación a AngelPay y Blumon recibidos o pendientes, con búsqueda y páginas. Sólo para el equipo de Avoqado.',
    {
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(100).default(25),
      search: z.string().max(100).optional(),
      status: z.enum(['DRAFT', 'SUBMITTED', 'REVOKED']).optional(),
    },
    async ({ page, pageSize, search, status }) => {
      if (!scope.isSuperAdmin) return denied()
      return text(await listRequests({ page, pageSize, search, status }))
    },
  )

  server.tool(
    'get_document_request',
    'Consulta el contacto y los documentos entregados en un expediente de afiliación. Sólo para el equipo de Avoqado.',
    { id: z.string().cuid().describe('Expediente devuelto por list_document_requests') },
    async ({ id }) => {
      if (!scope.isSuperAdmin) return denied()
      return text(await getAdminRequest(id))
    },
  )

  server.tool(
    'create_document_request',
    'Crea una liga para que un cliente entregue sus documentos de afiliación sin iniciar sesión. Devuelve la liga una sola vez; compártela sólo con el destinatario. Sólo para Avoqado.',
    {
      provider: z.enum(['ANGELPAY', 'BLUMON']),
      entityType: z.enum(['PERSONA_FISICA', 'PERSONA_MORAL']),
      businessName: z.string().trim().min(1).max(160),
    },
    async ({ provider, entityType, businessName }) => {
      if (!scope.isSuperAdmin) return denied()
      requireWriteScopeAlways(scope, 'document-requests:create', 'crea un acceso para entregar documentos personales')
      return text(await createRequest({ provider, entityType, businessName }, scope.staffId))
    },
  )

  server.tool(
    'manage_document_request',
    'Revoca una liga de entrega o genera una nueva para corregir y completar documentos. Renovar invalida la liga anterior y conserva lo recibido. Requiere revisar la vista previa y confirmar. Sólo para Avoqado.',
    {
      id: z.string().cuid().describe('Expediente devuelto por list_document_requests'),
      action: z.enum(['revoke', 'renew']),
      confirm: z.boolean().default(false),
    },
    async ({ id, action, confirm }) => {
      if (!scope.isSuperAdmin) return denied()
      requireWriteScopeAlways(scope, `document-requests:${action}`, 'cambia el acceso a un expediente personal')
      if (!confirm) {
        const { request } = await getAdminRequest(id)
        return text({
          ok: false,
          requiresConfirmation: true,
          current: request,
          change:
            action === 'revoke'
              ? 'Liga vigente → revocada. El cliente ya no podrá entregar documentos con ella.'
              : 'Liga anterior → nueva liga por 14 días. Se conservan los documentos y se permite corregirlos.',
        })
      }
      return text(action === 'revoke' ? await revokeRequest(id, scope.staffId) : await renewRequest(id, scope.staffId))
    },
  )
}
