import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import AppError from '@/errors/AppError'
import { existingId } from '@/schemas/common/existingId.schema'
import {
  type DeviceMenusTerminalRow,
  DEVICE_MENUS_CODE,
  MENU_NO_DISPONIBLE_MESSAGE,
  POS_TERMINAL_TYPES,
  listDeviceMenuOptions,
  listDeviceMenus,
  listVenueMenuUsage,
  setTerminalMenus,
} from '@/services/devices/deviceMenus.service'
import { MENU_SIN_USO_MESSAGE, updateMenu } from '@/services/dashboard/menu.dashboard.service'
import { operationHash } from '@/utils/operationHash'
import type { McpScope } from '../scope'
import { ScopeError, createGuard } from '../guard'
import { text } from '../respond'
import { planGateMessage } from '../planGate'
import { auditMcpWrite, mcpProvenance } from '../audit'

/* Free mode only (`/mcp`): none of these is in the certified directory catalog. */

const CAPABILITY = 'Elegir qué menús muestra cada aparato'
const MENU_PAGE_SIZE = 100
const DEVICE_PAGE_SIZE = 50
const SIN_ELECCION = 'Todos los menús'

/** Rejections written for the operator go back as ok:false; anything else is rethrown so instrument.ts redacts it. */
function operatorError(err: unknown) {
  if (err instanceof ScopeError) return text({ ok: false, error: err.message })
  if (!(err instanceof AppError) || !err.isOperational) throw err
  return text({ ok: false, error: err.message, ...(err.code ? { code: err.code } : {}) })
}

const lista = (nombres: string[]) => (nombres.length ? nombres.join(', ') : SIN_ELECCION)
const lugares = (devices: boolean, online: boolean) => lista([...(devices ? ['Aparatos'] : []), ...(online ? ['Tienda en línea'] : [])])

export function registerDeviceMenuTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'list_device_menus',
    'Which menus each point-of-sale device of a venue shows ("Qué muestra cada aparato"): per device the chosen menus (none chosen = all menus), how many categories and products are in what the device\'s sales grid shows today (sees) and, when its app still needs an update to apply the choice, what it will show after updating the app (seesAfterUpdate; otherwise null), plus what "all menus" shows and the menus that can be chosen. It also lists every menu of the venue, on and off, with where each one is used (allMenus: on devices and/or on the online store), the ids to use with set_menu_usage. Devices come 50 per page, the selectable menus and allMenus 100 per page, each with its total so you can ask for the next page (page, menuPage, allMenusPage); menuSearch filters the selectable menus by name. Reading is open on every plan. Requires tpv:read.',
    {
      venueId: existingId().describe('Venue (must be in your scope)'),
      page: z.number().int().min(1).max(10_000).optional().describe('Device page, 50 per page (default 1)'),
      menuSearch: z.string().max(120).optional().describe('Filter the selectable menus by name'),
      menuPage: z.number().int().min(1).max(10_000).optional().describe('Selectable-menu page, 100 per page (default 1)'),
      allMenusPage: z
        .number()
        .int()
        .min(1)
        .max(10_000)
        .optional()
        .describe('Page of every menu of the venue (allMenus), 100 per page (default 1)'),
    },
    async ({ venueId, page, menuSearch, menuPage, allMenusPage }) => {
      try {
        guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
        guard.requirePermission('tpv:read', venueId)
        const [devices, options, allMenus] = await Promise.all([
          listDeviceMenus(venueId, page ?? 1, DEVICE_PAGE_SIZE),
          listDeviceMenuOptions(venueId, { search: menuSearch, page: menuPage ?? 1, pageSize: MENU_PAGE_SIZE }),
          listVenueMenuUsage(venueId, allMenusPage ?? 1),
        ])
        return text({ ok: true, ...devices, menuOptions: options, allMenus })
      } catch (err) {
        return operatorError(err)
      }
    },
  )

  server.tool(
    'set_device_menus',
    'Choose which menus up to 20 point-of-sale devices of a venue show in their sales grid (it only hides items from the grid; search and barcode still reach the whole catalog). It REPLACES each device\'s choice; an empty menuIds list means "all menus". Only active menus that are used on devices can be chosen (see list_device_menus). On a device whose app still needs an update (needsAppUpdate in the result) the choice is saved but the device keeps showing the whole catalog until its app is updated; seesAfterUpdate says what it will show then. By DEFAULT it only PREVIEWS the change per device (current → new): show it to the user and, after their OK, call again with confirm:true and the confirmation arguments the preview returns. This WRITES — requires tpv:update and a plan that includes it.',
    {
      venueId: existingId().describe('Venue (must be in your scope)'),
      terminalIds: z.array(existingId()).min(1).max(20).describe('Devices to change (ids from list_device_menus)'),
      menuIds: z.array(existingId()).max(50).describe('Menus those devices will show; [] = all menus'),
      expectedSourceFingerprint: z.string().max(128).optional().describe('Exact fingerprint returned by the preview'),
      confirm: z.boolean().optional().describe('Must be true to actually save; without it you get a preview'),
    },
    async ({ venueId, terminalIds, menuIds, expectedSourceFingerprint, confirm }) => {
      try {
        guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
        guard.requirePermission('tpv:update', venueId)
        const gate = await planGateMessage(venueId, DEVICE_MENUS_CODE, CAPABILITY)
        if (gate) return text({ ok: false, planRequired: true, error: gate })

        const idsAparatos = [...new Set(terminalIds)]
        const idsMenus = [...new Set(menuIds)]
        const aparatos = await prisma.terminal.findMany({
          where: { id: { in: idsAparatos }, venueId, type: { in: POS_TERMINAL_TYPES } },
          select: {
            id: true,
            name: true,
            // Como la regla: una fila hacia un menú de otro negocio (el aparato cambió de sucursal), apagado o sólo en línea no cuenta.
            menus: {
              where: { menu: { venueId, active: true, appliesToDevices: true } },
              select: { menu: { select: { name: true } } },
              take: 50,
            },
          },
          orderBy: [{ name: 'asc' }, { id: 'asc' }],
          take: 20,
        })
        if (aparatos.length !== idsAparatos.length)
          return text({
            ok: false,
            error: 'Alguno de esos aparatos no existe en este local o no es un punto de venta.',
            code: 'TERMINAL_NOT_FOUND',
          })
        const menus = idsMenus.length
          ? await prisma.menu.findMany({
              where: { id: { in: idsMenus }, venueId, active: true, appliesToDevices: true },
              select: { id: true, name: true },
              orderBy: [{ name: 'asc' }, { id: 'asc' }],
              take: 50,
            })
          : []
        if (menus.length !== idsMenus.length) return text({ ok: false, error: MENU_NO_DISPONIBLE_MESSAGE, code: 'MENU_NO_DISPONIBLE' })

        const fingerprint = operationHash({ terminalIds: idsAparatos, menuIds: idsMenus })
        if (!confirm) {
          const nuevo = lista(menus.map(m => m.name))
          return text({
            ok: false,
            requiresConfirmation: true,
            expectedSourceFingerprint: fingerprint,
            preview: aparatos.map(a => ({ id: a.id, device: a.name, current: lista(a.menus.map(m => m.menu.name)), new: nuevo })),
            message: `Esto cambiará lo que muestran ${aparatos.length} aparato(s): quedarán con «${nuevo}». Confirma con el operador; luego vuelve a llamar con confirm:true.`,
          })
        }
        if (expectedSourceFingerprint !== fingerprint)
          return text({
            ok: false,
            needsInput: true,
            question: 'Los aparatos o menús elegidos cambiaron desde la vista previa. Pide la vista previa otra vez y confirma.',
          })

        // Sin `auditMcpWrite`: el servicio deja UNA fila por aparato (sólo si cambió), con la procedencia del MCP.
        const procedencia = await mcpProvenance(scope)
        const saved: Array<
          { id: string; name: string } & Partial<Pick<DeviceMenusTerminalRow, 'needsAppUpdate' | 'sees' | 'seesAfterUpdate'>>
        > = []
        for (const [i, a] of aparatos.entries()) {
          let fila: DeviceMenusTerminalRow
          try {
            fila = await setTerminalMenus(venueId, a.id, idsMenus, scope.staffId, procedencia)
          } catch (err) {
            // Parcial: cada aparato va en su propia transacción. Se dice qué quedó, qué falló y qué falta (reintentar es idempotente).
            const known = err instanceof ScopeError || (err instanceof AppError && err.isOperational)
            return text({
              ok: false,
              updated: saved,
              failed: {
                id: a.id,
                name: a.name,
                error: known ? err.message : 'Error interno al guardar este aparato.',
                ...(err instanceof AppError && err.isOperational && err.code ? { code: err.code } : {}),
              },
              remaining: aparatos.slice(i + 1).map(r => ({ id: r.id, name: r.name })),
              message: `Se guardaron ${saved.length} aparato(s), falló «${a.name}» y faltan ${aparatos.length - i - 1}. Se puede volver a intentar con el que falló y los que faltan (repetir es seguro: reemplaza la elección completa).`,
            })
          }
          saved.push({
            id: a.id,
            name: a.name,
            needsAppUpdate: fila.needsAppUpdate,
            sees: fila.sees,
            seesAfterUpdate: fila.seesAfterUpdate,
          })
        }
        const nuevo = lista(menus.map(m => m.name))
        // Una app que todavía no aplica la elección la guarda, pero sigue mostrando todo (Ruling 11): no se dice «ahora muestran».
        // Volver a «Todos los menús» sí es inmediato: ya mostraba todo.
        const pendientes = idsMenus.length ? saved.filter(f => f.needsAppUpdate) : []
        if (!pendientes.length)
          return text({ ok: true, updated: saved, message: `Listo: ${saved.length} aparato(s) ahora muestran «${nuevo}».` })
        const detalle = pendientes
          .map(f =>
            f.seesAfterUpdate
              ? `«${f.name}» mostrará ${f.seesAfterUpdate.categories} categorías y ${f.seesAfterUpdate.products} productos`
              : `«${f.name}»`,
          )
          .join('; ')
        return text({
          ok: true,
          updated: saved,
          message: `Elección guardada: ${saved.length} aparato(s) quedan con «${nuevo}». En ${pendientes.length} de ellos la app necesita actualizarse: hoy siguen mostrando todo el catálogo y lo aplicarán al actualizar la app (${detalle}).`,
        })
      } catch (err) {
        return operatorError(err)
      }
    },
  )

  server.tool(
    'set_menu_usage',
    'Choose where a menu is used ("¿Dónde se usa?"): on devices (point-of-sale apps), on the online store, or both; at least one must stay on (to not use a menu anywhere, turn the menu off instead). Pass only the boxes to change. By DEFAULT it only PREVIEWS (current → new): show it to the user and, after their OK, call again with confirm:true and the confirmation arguments the preview returns. This WRITES — requires menu:update; available on every plan.',
    {
      venueId: existingId().describe('Venue (must be in your scope)'),
      menuId: existingId().describe('Menu to change (id from allMenus in list_device_menus, which lists every menu, on and off)'),
      appliesToDevices: z.boolean().optional().describe('true = shown on devices (Aparatos)'),
      appliesToOnline: z.boolean().optional().describe('true = sold on the online store (Tienda en línea)'),
      expectedSourceFingerprint: z.string().max(128).optional().describe('Exact fingerprint returned by the preview'),
      confirm: z.boolean().optional().describe('Must be true to actually save; without it you get a preview'),
    },
    async ({ venueId, menuId, appliesToDevices, appliesToOnline, expectedSourceFingerprint, confirm }) => {
      try {
        guard.venueFilter(venueId) // throws ScopeError if the venue is out of scope
        guard.requirePermission('menu:update', venueId)
        if (appliesToDevices === undefined && appliesToOnline === undefined)
          return text({ ok: false, needsInput: true, question: '¿Dónde se usa el menú: en Aparatos, en Tienda en línea o en los dos?' })
        const menu = await prisma.menu.findFirst({
          where: { id: menuId, venueId },
          select: { id: true, name: true, appliesToDevices: true, appliesToOnline: true },
        })
        if (!menu) return text({ ok: false, error: 'Ese menú no existe en este local.' })
        const devices = appliesToDevices ?? menu.appliesToDevices
        const online = appliesToOnline ?? menu.appliesToOnline
        if (!devices && !online) return text({ ok: false, error: MENU_SIN_USO_MESSAGE, code: 'MENU_SIN_USO' })

        const fingerprint = operationHash({ menuId, appliesToDevices: devices, appliesToOnline: online })
        if (!confirm)
          return text({
            ok: false,
            requiresConfirmation: true,
            expectedSourceFingerprint: fingerprint,
            preview: { menu: menu.name, current: lugares(menu.appliesToDevices, menu.appliesToOnline), new: lugares(devices, online) },
            message: `Esto cambiará dónde se usa «${menu.name}»: de «${lugares(menu.appliesToDevices, menu.appliesToOnline)}» a «${lugares(devices, online)}». Confirma con el operador; luego vuelve a llamar con confirm:true.`,
          })
        if (expectedSourceFingerprint !== fingerprint)
          return text({
            ok: false,
            needsInput: true,
            question: 'El menú o lo elegido cambió desde la vista previa. Pide la vista previa otra vez y confirma.',
          })

        await updateMenu(venueId, menuId, { appliesToDevices: devices, appliesToOnline: online }, scope.staffId)
        await auditMcpWrite(scope, {
          action: 'MENU_USAGE_UPDATED',
          entity: 'Menu',
          entityId: menuId,
          venueId,
          data: {
            name: menu.name,
            antes: { appliesToDevices: menu.appliesToDevices, appliesToOnline: menu.appliesToOnline },
            despues: { appliesToDevices: devices, appliesToOnline: online },
          },
        })
        return text({
          ok: true,
          menu: menu.name,
          usedIn: lugares(devices, online),
          message: `Listo: «${menu.name}» se usa en «${lugares(devices, online)}».`,
        })
      } catch (err) {
        return operatorError(err)
      }
    },
  )
}
