import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { McpScope } from '../scope'
import { text } from '../respond'
import { requireWriteScopeAlways } from '../requireWriteScopeAlways'
import {
  createRequest,
  getAdminRequest,
  listRequests,
  renewRequest,
  revokeRequest,
} from '@/services/document-requests/documentRequests.service'

const denied = () => text({ ok: false, error: 'Sólo el equipo de Avoqado puede consultar expedientes de afiliación.' })

export function registerDocumentRequestTools(server: McpServer, scope: McpScope): void {
  if (!scope.isSuperAdmin) return

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
