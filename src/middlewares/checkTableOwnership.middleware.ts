import { Request, Response, NextFunction } from 'express'
import { evaluatePermissionList, hasPermission } from '@/lib/permissions'
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { resolveUserRoleForVenue } from './checkPermission.middleware'
import { esSuperadminReal } from '@/services/access/rolVigente'
import { hayDineroQueSeGuarda } from '@/services/shared/orderBalance'
import { cuerpoMesaAjena, esCobroCompletadoDeLaOrden } from '@/services/shared/cuentaCancelada'

/**
 * Propiedad de mesa — "Solo el propietario puede modificar sus mesas".
 *
 * Con `VenueSettings.enforceTableOwnership` encendido (switch PRO del venue),
 * solo el mesero dueño de la orden (`Order.servedById`) puede mutarla:
 * agregar items, descuentos, cortesías, cargos por servicio, mover, dividir,
 * fusionar, cobrar, cancelar y liberar la mesa. Los demás la ven read-only.
 *
 * Override: permiso `tables:manage-all` (MANAGER+ por default; OWNER/ADMIN via
 * `tables:*`; SUPERADMIN bypass). Espejado por nombre EXACTO en iOS/Android.
 *
 * Solo aplica a órdenes de mesa (`tableId != null`) — ventas de mostrador y
 * cobros rápidos no tienen dueño de mesa. Con el switch apagado (default) el
 * middleware es un no-op de una sola query.
 *
 * Rechazo: 403 con `code: 'TABLE_OWNED_BY_OTHER'` + nombre del dueño, para que
 * los clientes muestren "Mesa de {mesero} — solo lectura" en vez de un error
 * genérico. Corre DESPUÉS de authenticate/checkFeatureAccess/checkPermission.
 */

/**
 * Override por DEFAULT: administrar mesas ajenas de punta a punta (MANAGER+).
 * `tables:pay-any` es el override ACOTADO que sólo monta la ruta de COBRO.
 */
export const DEFAULT_OWNERSHIP_OVERRIDES = ['tables:manage-all'] as const
/** Cobro: la caja liquida cualquier cheque sin poder editarlo (Toast/Square hacen igual). */
export const PAYMENT_OWNERSHIP_OVERRIDES = ['tables:manage-all', 'tables:pay-any'] as const

/**
 * ¿El staff puede saltarse la regla de propiedad en este venue?
 *
 * @param overridePermissions cualquiera de estos permisos exime. Por default sólo
 *        `tables:manage-all`; la ruta de cobro añade `tables:pay-any`.
 */
export async function staffCanManageAllTables(
  userId: string,
  venueId: string,
  tokenVenueId?: string,
  tokenRole?: string,
  overridePermissions: readonly string[] = DEFAULT_OWNERSHIP_OVERRIDES,
  /**
   * La petición en curso, SOLO para que `resolveUserRoleForVenue` memoice y no
   * consulte la base una vez por middleware. Opcional a propósito: el reducer offline
   * (`sync.mobile.service.ts`) llama a esta función SIN request, y ahí no debe haber
   * memoria compartida — cada intent se evalúa por su cuenta.
   */
  req?: Request,
): Promise<boolean> {
  // SUPERADMIN bypass (mismo criterio que checkPermission)
  // Superadmin de verdad: fila activa de una persona activa (Codex H6, 24-sep).
  if (await esSuperadminReal(userId)) return true

  const { role: userRole, permissionSet } = await resolveUserRoleForVenue({
    userId,
    targetVenueId: venueId,
    tokenVenueId,
    tokenRole,
    req,
  })
  if (!userRole) return false

  if (permissionSet) {
    return overridePermissions.some(perm => evaluatePermissionList(permissionSet.permissions, perm))
  }

  const venueRolePermission = await prisma.venueRolePermission.findUnique({
    where: { venueId_role: { venueId, role: userRole } },
    select: { permissions: true, deniedPermissions: true },
  })
  const customPermissions = venueRolePermission ? (venueRolePermission.permissions as string[]) : null
  const deniedPermissions = venueRolePermission ? ((venueRolePermission.deniedPermissions as string[]) ?? null) : null
  return overridePermissions.some(perm => hasPermission(userRole, customPermissions, perm, deniedPermissions))
}

/** ¿El venue tiene encendida la regla de propiedad de mesa? */
export async function isTableOwnershipEnforced(venueId: string): Promise<boolean> {
  const settings = await prisma.venueSettings.findUnique({
    where: { venueId },
    select: { enforceTableOwnership: true },
  })
  return settings?.enforceTableOwnership === true
}

type OwnershipSource = 'order' | 'table'

/**
 * @param source 'order' = la ruta trae `:orderId`; 'table' = trae `:tableId`
 *               (open/clear) y la regla evalúa la(s) orden(es) abierta(s) de esa mesa.
 * @param overridePermissions permisos que eximen del candado. La ruta de COBRO monta
 *        `PAYMENT_OWNERSHIP_OVERRIDES` para que la caja pueda liquidar un cheque ajeno
 *        sin ganar el derecho a editarlo; todas las demás se quedan con el default.
 * @param opciones.dineroCapturado 🔴 R2-6 (founder 3-oct: el dinero capturado nunca se rechaza ni se pierde). SÓLO la ruta de
 *        cobro: la propiedad de mesa decide quién INICIA un cobro, no quién REGISTRA dinero ya capturado. Ana cobró sin red y un
 *        encargado pasó la mesa a Beto: su cola (`isOfflineReplay`) pasa, con la mesa ajena en `res.locals.mesaAjena` para el
 *        rastro en `ActivityLog`. Autenticación, sucursal, `payments:create` e idempotencia se conservan; el cobro EN VIVO sigue 403.
 *        R3-1: sólo con importe + propina > 0 (`esDineroCapturado`); un $0 + $0 sobre mesa ajena sigue 403.
 *        R4-1: el reintento cuya llave YA tiene pago de esta orden pasa siempre (`laLlaveYaTienePagoDeEstaOrden`): es idempotente.
 *        R5-1: y pasa SÓLO a recuperar ese pago (`res.locals.soloRecuperarPago`): si desapareció, el servicio responde este 403.
 */
/**
 * 🔴 R3-1 (Codex r2, P2): ¿el cuerpo trae dinero de verdad? Importe y propina válidos (las mismas reglas del controller de cobro) y
 * su suma estrictamente positiva. $0 + $0 NO es dinero capturado: con una cuenta ajena en $0 (descuento del 100 %) dejaba cerrar la
 * mesa de otro (PAID, inventario, mesa libre) sin un peso de por medio.
 */
function esDineroCapturado(body: { amount?: unknown; tip?: unknown }): boolean {
  const { amount, tip = 0 } = body
  const valido = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0
  // R4-4: con la precisión con que se guarda (centavos enteros): 0.001 ¢ se guarda $0.00 y no es dinero.
  return valido(amount) && valido(tip) && hayDineroQueSeGuarda(amount, tip)
}

/**
 * 🔴 R4-1 (Codex r3, P2): ¿la llave de este cobro YA tiene un pago de ESTA orden en ESTE negocio? Es el reintento de una operación
 * confirmada (la respuesta se perdió): el servicio devuelve ese pago sin cobrar otra vez, así que la propiedad de mesa no lo rechaza
 * aunque la mesa haya cambiado de dueño — con R3-1 un reintento de $0 recibía 403 antes de mirar la llave. Mismo criterio que
 * `payCashOrder` (llave de texto no vacía, `venueId_idempotencyKey`), y además la orden debe ser la misma: una llave de otra orden, o
 * una nueva, sigue con el 403 de siempre.
 * R5-2 (Codex r4): y el pago debe ser un COBRO COMPLETADO (`esCobroCompletadoDeLaOrden`): un intento FAILED o una devolución con esa
 * llave no son «ya cobrada».
 */
async function laLlaveYaTienePagoDeEstaOrden(venueId: string, orderId: string | undefined, llave: unknown): Promise<boolean> {
  if (!orderId || typeof llave !== 'string' || !llave) return false
  const pago = await prisma.payment.findUnique({
    where: { venueId_idempotencyKey: { venueId, idempotencyKey: llave } },
    select: { orderId: true, status: true, type: true },
  })
  return !!pago && esCobroCompletadoDeLaOrden(pago, orderId)
}

export const checkTableOwnership = (
  source: OwnershipSource = 'order',
  overridePermissions: readonly string[] = DEFAULT_OWNERSHIP_OVERRIDES,
  opciones: { dineroCapturado?: boolean } = {},
) => {
  const middleware = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const authContext = (req as any).authContext
      if (!authContext?.userId) {
        return res.status(401).json({ error: 'Unauthorized', message: 'Authentication required' })
      }

      const venueId = req.params?.venueId
      if (!venueId) {
        return res.status(400).json({ error: 'Bad Request', message: 'Venue ID required' })
      }

      // Switch apagado (default) → no-op.
      if (!(await isTableOwnershipEnforced(venueId))) return next()

      // 🔴 R6-3 (Codex r5 #3): lo de abajo se decide ANTES del candado del cobro; si la cuenta cambia de dueño en esa ventana, el cobro
      // vuelve a revisar la propiedad bajo el candado con la MISMA regla. Marca interna (nunca del body), sólo en la ruta de cobro.
      if (opciones.dineroCapturado) {
        res.locals.propiedadDeMesa = {
          userId: authContext.userId,
          puedeCobrarAjena: () =>
            staffCanManageAllTables(authContext.userId, venueId, authContext.venueId, authContext.role, overridePermissions, req),
        }
      }

      // Dueño(s) de la(s) orden(es) afectada(s).
      let owners: { servedById: string | null; servedBy: { firstName: string; lastName: string } | null }[] = []
      if (source === 'order') {
        const orderId = req.params?.orderId
        if (!orderId) return next() // ruta mal cableada — que el controller responda
        const order = await prisma.order.findFirst({
          where: { id: orderId, venueId },
          select: {
            tableId: true,
            servedById: true,
            servedBy: { select: { firstName: true, lastName: true } },
          },
        })
        // Orden inexistente → 404 del controller. Sin mesa → venta de mostrador,
        // la regla de propiedad no aplica.
        if (!order || !order.tableId) return next()
        owners = [order]
      } else {
        const tableId = req.params?.tableId
        if (!tableId) return next()
        owners = await prisma.order.findMany({
          where: {
            venueId,
            tableId,
            status: { notIn: ['COMPLETED', 'CANCELLED', 'DELETED'] },
          },
          select: {
            servedById: true,
            servedBy: { select: { firstName: true, lastName: true } },
          },
        })
        // Mesa libre (sin órdenes abiertas) → abrirla es de quien llegue primero.
        if (owners.length === 0) return next()
      }

      // Sin dueño registrado (servedById null) → no hay a quién proteger.
      const foreign = owners.find(o => o.servedById && o.servedById !== authContext.userId)
      if (!foreign) return next()

      if (await staffCanManageAllTables(authContext.userId, venueId, authContext.venueId, authContext.role, overridePermissions, req)) {
        logger.debug(`checkTableOwnership: override [${overridePermissions.join(', ')}] para ${authContext.userId} en venue ${venueId}`)
        return next()
      }

      const ownerName = foreign.servedBy ? `${foreign.servedBy.firstName} ${foreign.servedBy.lastName}`.trim() : 'otro mesero'
      if (opciones.dineroCapturado && req.body?.isOfflineReplay === true && esDineroCapturado(req.body)) {
        res.locals.mesaAjena = { ownerId: foreign.servedById, ownerName }
        return next()
      }
      if (opciones.dineroCapturado && (await laLlaveYaTienePagoDeEstaOrden(venueId, req.params?.orderId, req.body?.idempotencyKey))) {
        // 🔴 R5-1 (Codex r4, P2): esta excepción autoriza SÓLO recuperar ese pago. Si lo borran antes de que el servicio lo relea,
        // el servicio responde este mismo 403 en vez de crear un pago nuevo en la mesa ajena. Marca interna (nunca del body).
        res.locals.soloRecuperarPago = { ownerId: foreign.servedById, ownerName }
        return next()
      }
      logger.info(
        `checkTableOwnership: ${authContext.userId} bloqueado — mesa propiedad de ${foreign.servedById} (${ownerName}) en venue ${venueId}`,
      )
      return res.status(403).json(cuerpoMesaAjena({ ownerId: foreign.servedById, ownerName }))
    } catch (error) {
      logger.error('checkTableOwnership: error evaluando propiedad de mesa', error)
      return res.status(500).json({ error: 'Internal Server Error', message: 'Failed to verify table ownership' })
    }
  }

  // Expuesto para tests de auditoría de rutas: permite afirmar QUÉ override monta cada
  // endpoint sin ejecutar el middleware (mismo patrón que `requiredPermission`).
  ;(middleware as any).ownershipOverridePermissions = [...overridePermissions]
  ;(middleware as any).dejaPasarDineroCapturado = opciones.dineroCapturado === true
  return middleware
}
