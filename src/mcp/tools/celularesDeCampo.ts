import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { auditMcpWrite } from '../audit'
import { moduleService, MODULE_CODES } from '@/services/modules/module.service'
import { esSupervisorOMasDeLaOrganizacion } from '@/services/access/supervisorDeLaOrganizacion'
import { listarCelularesDeCampo } from '@/services/tpv/campo/celular/celularesDeLaOrganizacion.service'
import { generarCodigos } from '@/services/tpv/campo/celular/codigoDeCelular.service'
import { desvincularCelular } from '@/services/tpv/campo/celular/desvincularCelular.service'
import { listarRetenidos, resolverRetenido } from '@/services/tpv/campo/celular/graciaDelCelular.service'

const SERIALIZED_OFF_MSG = 'El inventario serializado no está activo en este local (módulo SERIALIZED_INVENTORY apagado).'
const NO_SUPERVISOR_MSG = 'Se requiere rol de supervisor o superior en la organización.'
const PAGE_SIZE = 25

const ACCIONES = ['GENERAR_CODIGO', 'DESVINCULAR', 'APLICAR_RETENIDO', 'DESCARTAR_RETENIDO'] as const

export function registerCelularesDeCampoTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  /** Alcance, módulo, permiso y supervisor; devuelve la organización o la respuesta de rechazo. */
  async function entrar(venueId: string, permiso: 'teams:read' | 'teams:update') {
    guard.venueFilter(venueId) // ScopeError si el venue no es del alcance
    if (!(await moduleService.isModuleEnabled(venueId, MODULE_CODES.SERIALIZED_INVENTORY))) {
      return { rechazo: text({ ok: false, moduleRequired: true, error: SERIALIZED_OFF_MSG }) }
    }
    guard.requirePermission(permiso, venueId) // en escritura también exige mcp:write
    const organizationId = scope.perVenueAccess.get(venueId)?.organizationId
    if (!organizationId) return { rechazo: text({ ok: false, error: 'No pude resolver la organización de este venue.' }) }
    if (!(await esSupervisorOMasDeLaOrganizacion({ userId: scope.staffId }, organizationId))) {
      return { rechazo: text({ ok: false, error: NO_SUPERVISOR_MSG }) }
    }
    return { organizationId }
  }

  server.tool(
    'promoter_phones',
    'Field-app phones of the org promoters (PlayTelecom "App de campo"): per promoter, whether they have no phone, an unused activation code, or an active linked phone (brand/model/app version, last seen, uploads pending), plus counts per state. Filter by name (q) or estado SIN_CELULAR | CODIGO_SIN_USAR | ACTIVO. Paginated (25 per page). Only for venues with the SERIALIZED_INVENTORY module; supervisor or above. Answers "¿quién ya activó su celular?".',
    {
      venueId: z.string().describe('A venue of the org (must be in your scope) — used for the module gate and to resolve the org'),
      q: z.string().optional().describe('Promoter name or phone to search'),
      estado: z.enum(['SIN_CELULAR', 'CODIGO_SIN_USAR', 'ACTIVO']).optional().describe('Only promoters in this state'),
      page: z.number().int().min(1).optional().describe('Page, starting at 1'),
    },
    async ({ venueId, q, estado, page }) => {
      const e = await entrar(venueId, 'teams:read')
      if (e.rechazo) return e.rechazo
      const r = await listarCelularesDeCampo(e.organizationId!, { q, estado, page: page ?? 1, pageSize: PAGE_SIZE })
      return text({ ok: true, page: page ?? 1, pageSize: PAGE_SIZE, ...r })
    },
  )

  server.tool(
    'promoter_phone_held_uploads',
    'Uploads (sales, check-ins, custody, evidence) that a promoter phone sent after being unlinked and that are HELD for review (PENDIENTE / APLICANDO). Optionally for one promoter (staffId). Paginated (25 per page). Use manage_promoter_phone APLICAR_RETENIDO / DESCARTAR_RETENIDO to resolve one. Only for venues with the SERIALIZED_INVENTORY module; supervisor or above.',
    {
      venueId: z.string().describe('A venue of the org (must be in your scope)'),
      staffId: z.string().optional().describe('Only the held uploads of this promoter'),
      page: z.number().int().min(1).optional().describe('Page, starting at 1'),
    },
    async ({ venueId, staffId, page }) => {
      const e = await entrar(venueId, 'teams:read')
      if (e.rechazo) return e.rechazo
      const r = await listarRetenidos(e.organizationId!, {
        staffId,
        estado: ['PENDIENTE', 'APLICANDO'],
        page: page ?? 1,
        pageSize: PAGE_SIZE,
      })
      return text({ ok: true, page: page ?? 1, pageSize: PAGE_SIZE, ...r })
    },
  )

  server.tool(
    'manage_promoter_phone',
    "Manage a promoter's field-app phone: GENERAR_CODIGO (new activation code for the promoter — returned to you, 24 h validity), DESVINCULAR (unlink the phone: it keeps a 24 h grace to upload what it had pending; the PAX terminal of the same person is untouched), APLICAR_RETENIDO / DESCARTAR_RETENIDO (apply or discard one held upload, by retenidoId). Identify the promoter by staffId or by promoterName — an ambiguous name returns the candidates instead of guessing; DESVINCULAR also accepts celularId. Only for venues with the SERIALIZED_INVENTORY module; supervisor or above. By DEFAULT it only PREVIEWS; call again with confirm:true to apply. This WRITES — requires teams:update.",
    {
      venueId: z.string().describe('A venue of the org (must be in your scope)'),
      accion: z.enum(ACCIONES),
      staffId: z.string().optional().describe('Promoter staff id (GENERAR_CODIGO / DESVINCULAR)'),
      promoterName: z.string().optional().describe('Promoter name when the id is unknown'),
      celularId: z.string().optional().describe('Phone id (DESVINCULAR)'),
      retenidoId: z.string().optional().describe('Held upload id (APLICAR_RETENIDO / DESCARTAR_RETENIDO)'),
      nota: z.string().max(500).optional().describe('Optional note for the audit trail (held uploads)'),
      confirm: z.boolean().optional().describe('Must be true to actually apply; without it you get a preview'),
    },
    async ({ venueId, accion, staffId, promoterName, celularId, retenidoId, nota, confirm }) => {
      const e = await entrar(venueId, 'teams:update')
      if (e.rechazo) return e.rechazo
      const organizationId = e.organizationId!

      try {
        // --- retenidos: se identifican por su id ---
        if (accion === 'APLICAR_RETENIDO' || accion === 'DESCARTAR_RETENIDO') {
          if (!retenidoId) return text({ ok: false, error: 'Indica retenidoId.' })
          const aplicar = accion === 'APLICAR_RETENIDO'
          if (!confirm) {
            return text({
              ok: false,
              requiresConfirmation: true,
              change: { accion, retenidoId },
              message: aplicar
                ? 'Esto aplicará el envío retenido como si el celular lo hubiera mandado a tiempo (venta, checada, etc.). Confirma con el operador; luego vuelve a llamar con confirm:true.'
                : 'Esto descartará el envío retenido: no se aplicará. Confirma con el operador; luego vuelve a llamar con confirm:true.',
            })
          }
          const r = await resolverRetenido({
            retenidoId,
            organizationId,
            accion: aplicar ? 'APLICAR' : 'DESCARTAR',
            nota,
            porStaffId: scope.staffId,
          })
          await auditMcpWrite(scope, {
            action: aplicar ? 'CAMPO_RETENIDO_APLICADO_MCP' : 'CAMPO_RETENIDO_DESCARTADO_MCP',
            entity: 'EnvioRetenidoDeCampo',
            entityId: retenidoId,
            venueId,
            organizationId,
            data: { estado: r.estado, repetida: r.repetida },
          })
          return text({ ok: true, ...r })
        }

        // --- celular: se identifica la persona (id o nombre) ---
        let personaId = staffId ?? null
        let personaNombre: string | null = null
        if (!personaId && !(accion === 'DESVINCULAR' && celularId)) {
          if (!promoterName)
            return text({ ok: false, error: 'Indica staffId, promoterName' + (accion === 'DESVINCULAR' ? ' o celularId.' : '.') })
          const { items } = await listarCelularesDeCampo(organizationId, { q: promoterName, page: 1, pageSize: 10 })
          if (items.length === 0) return text({ ok: false, error: `No encontré un promotor "${promoterName}" en esta organización.` })
          if (items.length > 1) {
            // resolve-don't-guess: se devuelven los candidatos y se frena
            return text({
              ok: false,
              ambiguous: true,
              candidates: items.map(i => ({ staffId: i.staffId, name: i.nombre })),
              error: `"${promoterName}" coincide con más de un promotor: indica staffId.`,
            })
          }
          personaId = items[0].staffId
          personaNombre = items[0].nombre
        }

        if (accion === 'GENERAR_CODIGO') {
          if (!confirm) {
            return text({
              ok: false,
              requiresConfirmation: true,
              change: { accion, staffId: personaId, promoter: personaNombre },
              message: `Esto generará un código nuevo de activación de celular para ${personaNombre ?? 'el promotor'} (vale 24 h; si ya tenía uno sin usar, se reemplaza). Confirma con el operador; luego vuelve a llamar con confirm:true.`,
            })
          }
          const r = await generarCodigos({ organizationId, generadoPor: scope.staffId, staffIds: [personaId!] })
          await auditMcpWrite(scope, {
            action: 'CAMPO_CODIGO_GENERADO_MCP',
            entity: 'CodigoDeCelular',
            entityId: personaId!,
            venueId,
            organizationId,
            data: { omitidos: r.omitidos?.length ?? 0 }, // nunca el código
          })
          return text({ ok: true, ...r })
        }

        // DESVINCULAR
        let celular = celularId ?? null
        if (!celular) {
          const fila = await prisma.celularDeCampo.findFirst({
            where: { organizationId, staffIdVinculado: personaId },
            select: { id: true },
          })
          if (!fila) return text({ ok: false, error: 'Esa persona no tiene un celular vinculado.' })
          celular = fila.id
        }
        if (!confirm) {
          return text({
            ok: false,
            requiresConfirmation: true,
            change: { accion, celularId: celular, promoter: personaNombre },
            message: `Esto desvinculará el celular${personaNombre ? ` de ${personaNombre}` : ''}: dejará de entrar y tendrá 24 h para subir lo que traiga pendiente. La terminal PAX de la misma persona no se toca. Confirma con el operador; luego vuelve a llamar con confirm:true.`,
          })
        }
        const r = await desvincularCelular({ celularId: celular, organizationId, motivo: 'MCP', porStaffId: scope.staffId })
        await auditMcpWrite(scope, {
          action: 'CAMPO_CELULAR_DESVINCULADO_MCP',
          entity: 'CelularDeCampo',
          entityId: celular,
          venueId,
          organizationId,
          data: { yaEstaba: r.yaEstaba },
        })
        return text({ ok: true, ...r })
      } catch (err) {
        // Errores de negocio de los servicios (AppError con code): se devuelven como respuesta, no como caída.
        const a = err as { message?: string; code?: string; statusCode?: number }
        if (a.statusCode && a.statusCode < 500) return text({ ok: false, error: a.message, code: a.code })
        throw err
      }
    },
  )
}
