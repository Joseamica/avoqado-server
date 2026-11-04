import { createHash } from 'node:crypto'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import { esDuenoDeEstaOrganizacionOSuperadmin } from '@/services/access/duenoDeEstaOrganizacion'
import { duplicateVenue, getVenueDuplicationOptions } from '@/services/organization-dashboard/venueDuplication.service'
import { duplicateVenueSchema } from '@/schemas/dashboard/venueDuplication.schema'
import type { McpScope } from '../scope'
import { ScopeError, enforceWriteScope } from '../guard'
import { CONFIRMATION_TTL, issueConfirmation, validConfirmation } from '../confirmation'
import { auditMcpWrite } from '../audit'
import { text } from '../respond'

/** uuid con forma v4 sacado de un hash: la misma vista previa confirmada dos veces da la MISMA llave. */
function uuidDe(semilla: string): string {
  const h = createHash('sha256').update(semilla).digest('hex')
  const variante = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variante}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

// Mismas reglas que el cuerpo del POST del panel (no se aceptan campos de más: plan, tarifa o cuentas jamás llegan a Venue).
const cuerpo = duplicateVenueSchema.shape.body
const argsDeLaTool = {
  templateVenueId: cuerpo.shape.templateVenueId.describe('Id de la tienda MODELO de tu organización (de la lista de plantillas)'),
  name: cuerpo.shape.name.describe('Nombre de la tienda nueva (3 a 120 caracteres)'),
  address: cuerpo.shape.address.describe(
    'Dirección de la tienda nueva: address, city, state, zipCode, country (opcional), latitude, longitude',
  ),
  supervisorStaffId: cuerpo.shape.supervisorStaffId.describe('Id del supervisor (MANAGER) que quedará a cargo de la tienda nueva'),
  previewDigest: z.string().max(2048).optional().describe('Huella que dio la vista previa — sólo al confirmar'),
  confirm: z.boolean().optional().describe('true sólo tras la confirmación expresa del dueño; sin esto sólo hay vista previa'),
}

export function registerOrganizationTools(server: McpServer, scope: McpScope) {
  server.tool(
    'list_my_organizations',
    'The organizations you belong to and which ONE this connection is scoped to. Each connection is bound to a single active organization; the others are listed here so you know they exist — to act on a different one, reconnect choosing that org. Returns each org with your role there, whether it is your primary, and whether it is the one currently connected. Answers "¿qué organizaciones tengo? ¿a cuál estoy conectado?". No arguments.',
    {},
    async () => {
      // Self-data: only the caller's own active memberships — inherently scoped to scope.staffId, no venue filter applies.
      const memberships = await prisma.staffOrganization.findMany({
        where: { staffId: scope.staffId, isActive: true },
        select: { role: true, isPrimary: true, organization: { select: { id: true, name: true, slug: true } } },
        orderBy: [{ isPrimary: 'desc' }, { joinedAt: 'asc' }],
      })
      return text({
        connectedOrgId: scope.activeOrg,
        count: memberships.length,
        organizations: memberships.map(m => ({
          id: m.organization.id,
          name: m.organization.name,
          slug: m.organization.slug,
          yourRole: m.role,
          isPrimary: m.isPrimary,
          connected: m.organization.id === scope.activeOrg, // the org THIS connection can read/act on
        })),
      })
    },
  )

  server.tool(
    'duplicate_venue',
    'Duplicar tienda: crea una tienda NUEVA en tu organización copiando la configuración de otra tuya (cuenta de cobro, tarifa, SIMs y ajustes). No copia ventas, terminales ni promotores. Sólo el DUEÑO de la organización (o un superadmin) y sólo si el módulo está activo. Pasa templateVenueId, name, address y supervisorStaffId. Por DEFAULT sólo da la VISTA PREVIA; muéstrasela al dueño y, si la aprueba, vuelve a llamar con los mismos datos, confirm:true y el previewDigest que dio la vista previa. Confirmar dos veces la misma vista previa no crea dos tiendas. Esto ESCRIBE.',
    argsDeLaTool,
    async ({ previewDigest, confirm, ...datos }) => {
      enforceWriteScope(scope, 'organizations:duplicate-venue')
      const sesion = { userId: scope.staffId, role: scope.isSuperAdmin ? 'SUPERADMIN' : undefined }
      if (!(await esDuenoDeEstaOrganizacionOSuperadmin(sesion, scope.activeOrg))) {
        throw new ScopeError('Sólo el dueño de la organización puede duplicar una tienda')
      }

      const opciones = await getVenueDuplicationOptions(scope.activeOrg)
      if (!opciones.enabled) {
        return text({ ok: false, error: 'Duplicar tiendas no está activo para esta organización. Pídele a Avoqado que lo active.' })
      }
      const modelo = opciones.templates.find(t => t.id === datos.templateVenueId)
      if (!modelo) return text({ ok: false, error: 'Esa tienda modelo no existe o no está activa en tu organización.' })
      const supervisor = opciones.supervisors.find(p => p.staffId === datos.supervisorStaffId)
      if (!supervisor) return text({ ok: false, error: 'Ese supervisor no es un encargado (MANAGER) activo de tu organización.' })

      const a = datos.address
      const direccion = `${a.address}, ${a.city}, ${a.state}, C.P. ${a.zipCode}`
      // Lo que ve el dueño en la vista previa es lo que se firma: si algo cambia al confirmar, la huella ya no vale.
      const firmado = { org: scope.activeOrg, ...datos }

      if (!confirm) {
        return text({
          ok: false,
          requiresConfirmation: true,
          previewDigest: issueConfirmation(scope, 'duplicate_venue', firmado),
          change: { copiaDe: modelo.name, nombreNuevo: datos.name, direccion, supervisor: supervisor.name },
          message:
            `Voy a crear la tienda «${datos.name}» copiando la configuración de «${modelo.name}». ` +
            `Dirección: ${direccion}. Supervisor: ${supervisor.name}. ` +
            'Se copia: cuenta de cobro, tarifa, SIMs y ajustes. No se copian ventas, terminales ni promotores. ' +
            `Vuelve a llamar con los mismos datos, confirm:true y este previewDigest (vence a los ${CONFIRMATION_TTL / 60} minutos).`,
        })
      }

      if (!validConfirmation(previewDigest, scope, 'duplicate_venue', firmado)) {
        throw new ScopeError(
          `La vista previa venció (dura ${CONFIRMATION_TTL / 60} minutos) o los datos no son los que vio el dueño. Pide una vista previa nueva y confírmala tal cual.`,
        )
      }

      const hecha = await duplicateVenue({
        orgId: scope.activeOrg,
        actorStaffId: scope.staffId,
        // Determinista desde la huella de ESTA vista previa: reintentar o confirmar dos veces devuelve la misma tienda.
        idempotencyKey: uuidDe(`duplicate_venue:${scope.activeOrg}:${scope.staffId}:${previewDigest}`),
        ...datos,
      })

      await auditMcpWrite(scope, {
        action: 'VENUE_DUPLICATED_VIA_MCP',
        entity: 'Venue',
        entityId: hecha.venueId,
        venueId: hecha.venueId,
        data: { copiaDe: modelo.id, name: hecha.name, supervisorStaffId: datos.supervisorStaffId },
      })

      return text({ ok: true, venueId: hecha.venueId, slug: hecha.slug, name: hecha.name, message: `Tienda «${hecha.name}» creada.` })
    },
  )
}
