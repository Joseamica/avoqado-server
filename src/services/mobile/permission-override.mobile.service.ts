/**
 * PIN de autorización de gerente (manager override).
 *
 * Cambia un PIN + un permiso por un TOKEN de un solo uso, 60 s de vida, atado a
 * ESE permiso y ESE venue. `checkPermission` lo consume desde el header
 * `X-Permission-Override` y deja pasar la acción una vez.
 *
 * 🔴 El PIN se compara en TEXTO PLANO. Es una decisión explícita del founder
 * (2026-08-15) y no se re-propone. Consecuencia honesta: quien tenga lectura de
 * la base puede usar el PIN de un gerente y la bitácora diría su nombre igual.
 * La auditoría sirve para reconstruir qué pasó, NO como prueba de quién autorizó.
 */

import { randomUUID } from 'crypto'
import { StaffRole } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { evaluatePermissionList, hasPermission } from '@/lib/permissions'
import { llaveDelDescuentoDelCliente } from '@/services/shared/descuentoDelCliente.service'

/** Vida del token. Suficiente para reintentar la request, corto para no dejar la terminal elevada. */
export const OVERRIDE_TTL_MS = 60_000

/**
 * Vida de una autorización ATADA a una operación (`operationKey`).
 *
 * 🔴 7 días porque el retiro de caja se encola SIN RED: el gerente teclea su PIN en el aparato, el retiro sale
 * del cajón y el POS puede tardar días en reconectar. La autorización tiene que seguir valiendo cuando el POST
 * por fin llegue. Sólo sirve para SU llave, así que el riesgo de dejarla viva es el de esa única operación.
 */
export const OVERRIDE_TTL_ATADO_MS = 7 * 24 * 60 * 60 * 1000

export class OverrideInvalidPinError extends Error {
  readonly code = 'OVERRIDE_INVALID_PIN' as const
  constructor() {
    super('Código incorrecto')
    this.name = 'OverrideInvalidPinError'
  }
}

/**
 * El venue no tiene activada la autorización por PIN.
 *
 * 🔴 Existe porque el switch tiene que valer en el SERVER, no sólo en el POS.
 * Antes sólo se consultaba para adornar el 403 con `overridable`, así que un
 * negocio con la función apagada seguía emitiendo y aceptando tokens para
 * cualquiera que mandara la petición a mano (curl, un APK viejo). "Apagado"
 * ahora significa apagado.
 */
export class OverrideDisabledError extends Error {
  readonly code = 'OVERRIDE_DISABLED' as const
  constructor() {
    super('Este negocio no tiene activada la autorización con código de encargado')
    this.name = 'OverrideDisabledError'
  }
}

export class OverrideInsufficientError extends Error {
  readonly code = 'OVERRIDE_INSUFFICIENT' as const
  /**
   * Quién es el dueño del PIN que se tecleó. NO se serializa al cliente: sirve
   * para que el controlador lo deje escrito en `ActivityLog`. Un PIN válido sin
   * el permiso es la señal clásica de fraude interno (alguien probando códigos
   * ajenos) y el rate limiter sólo lo frena, no lo deja registrado.
   */
  constructor(readonly authorizer?: { staffVenueId: string; role: StaffRole }) {
    super('Ese código tampoco tiene este permiso')
    this.name = 'OverrideInsufficientError'
  }
}

/**
 * Resuelve el permiso efectivo por el MISMO camino que checkPermission:
 * permissionSet asignado > VenueRolePermission + rol. Divergir aquí produciría
 * un PIN que se acepta y luego la acción falla igual (o al revés).
 *
 * 🔴 El Json de `StaffVenue.permissions` NO participa: hoy `checkPermission`
 * tampoco lo mira, así que tomarlo en cuenta aceptaría PINs para acciones que
 * el middleware seguiría rechazando.
 *
 * 🔴 Lo que el negocio le QUITÓ al rol (`deniedPermissions`) también cuenta, igual
 * que en `checkPermission`. Sin eso (Codex, B3b código r1, P1 #2) un ADMIN al que
 * el dueño le retiró `cfdi:configure` recibía 403 sin PIN, pero tecleaba SU PROPIO
 * PIN, obtenía un token de ese permiso y pasaba el middleware presentándolo.
 */
async function staffVenueCan(params: {
  venueId: string
  role: StaffRole
  permissionSet: { permissions: unknown } | null
  requiredPermission: string
}): Promise<boolean> {
  const { venueId, role, permissionSet, requiredPermission } = params

  if (permissionSet) {
    return evaluatePermissionList(permissionSet.permissions as string[], requiredPermission)
  }

  const venueRolePermission = await prisma.venueRolePermission.findUnique({
    where: { venueId_role: { venueId, role } },
    select: { permissions: true, deniedPermissions: true },
  })

  const customPermissions = venueRolePermission ? (venueRolePermission.permissions as string[]) : null
  const deniedPermissions = venueRolePermission ? ((venueRolePermission.deniedPermissions as string[]) ?? null) : null
  // 🔴 Las DOS lecturas, con AND (Codex, B3b código r2, N1): aplicar exclusiones re-resuelve dependencias —excluir
  // `scale:use` abre `scale:*` y `scale:configure` agrega `tpv-settings:*`—, así que la lectura con exclusiones sola
  // podía HABILITAR un token que sin ellas se rechazaba. Quitar un permiso sólo puede quitar: el PIN exige las dos.
  return (
    hasPermission(role, customPermissions, requiredPermission) &&
    hasPermission(role, customPermissions, requiredPermission, deniedPermissions)
  )
}

export async function createPermissionOverride(params: {
  venueId: string
  pin: string
  permission: string
  requestedById?: string | null
  /** `pay-out:<localId>:<centavos>`: ata la autorización a UNA operación (vive 7 días, ver `OVERRIDE_TTL_ATADO_MS`). */
  operationKey?: string | null
  now?: Date
}): Promise<{ token: string; expiresAt: Date; authorizedBy: { id: string; name: string } }> {
  const { venueId, pin, permission, requestedById = null, operationKey = null } = params
  const now = params.now ?? new Date()

  // 🔴 La puerta va ANTES de mirar el PIN: si el negocio no activó la función,
  // ni siquiera se compara un código. Fail-closed — `isManagerPinOverrideEnabled`
  // ya devuelve false si la lectura truena.
  if (!(await isManagerPinOverrideEnabled(venueId))) {
    throw new OverrideDisabledError()
  }

  const staffVenue = await prisma.staffVenue.findFirst({
    // 🔴 Las DOS banderas, igual que el reloj checador
    // (`time-entry.mobile.service.ts`, sus cinco búsquedas): `active` es la
    // membresía en ESTE venue, `staff.active` es la cuenta de la persona. Con
    // sólo la primera, a un gerente dado de baja se le impedía checar entrada
    // mientras su código seguía autorizando reembolsos.
    where: { venueId, pin, active: true, staff: { active: true } },
    select: {
      id: true,
      role: true,
      permissionSetId: true,
      permissionSet: true,
      staff: { select: { firstName: true, lastName: true } },
    },
  })

  if (!staffVenue) {
    logger.warn('Override rechazado: ningún empleado activo de este venue tiene ese PIN', { venueId, permission })
    throw new OverrideInvalidPinError()
  }

  const can = await staffVenueCan({
    venueId,
    role: staffVenue.role,
    permissionSet: staffVenue.permissionSetId ? (staffVenue.permissionSet as any) : null,
    requiredPermission: permission,
  })

  if (!can) {
    // Auto-autorizarse es imposible por construcción: si TU PIN tuviera el
    // permiso, nunca habría habido 403 y este endpoint no se habría llamado.
    logger.warn('Override rechazado: ese PIN tampoco tiene el permiso', {
      venueId,
      permission,
      authorizerRole: staffVenue.role,
    })
    throw new OverrideInsufficientError({ staffVenueId: staffVenue.id, role: staffVenue.role })
  }

  const token = randomUUID()
  const expiresAt = new Date(now.getTime() + (operationKey ? OVERRIDE_TTL_ATADO_MS : OVERRIDE_TTL_MS))

  await prisma.permissionOverride.create({
    data: {
      venueId,
      token,
      permission,
      authorizedById: staffVenue.id,
      requestedById,
      operationKey,
      expiresAt,
    },
  })

  return {
    token,
    expiresAt,
    authorizedBy: {
      id: staffVenue.id,
      name: `${staffVenue.staff.firstName} ${staffVenue.staff.lastName}`.trim(),
    },
  }
}

/**
 * Consumo del token.
 *
 * SIN llave (todas las rutas de siempre): ATÓMICO y de UN uso. El `updateMany` con `consumedAt: null` en el WHERE
 * garantiza un solo uso aunque dos requests lleguen a la vez: la base decide, y sólo una recibe count 1. Nunca
 * separes esto en un read + un write. Honra el interruptor del negocio y exige `operationKey: null`: una
 * autorización atada a un retiro no sirve en otra ruta.
 *
 * CON llave (`operationKey`, hoy sólo el retiro de caja): sirve para ESA llave y ese permiso, vigente (7 días), y es
 * REUTILIZABLE. Es seguro porque el `@@unique([venueId, localId])` de `CashDrawerEvent` garantiza un solo retiro por
 * llave: reintentar el mismo POST no puede sacar dinero dos veces. `consumedAt` se marca la primera vez, sólo como rastro.
 * NO mira el interruptor: el retiro se autorizó cuando estaba prendido, y apagarlo después no puede rechazar un retiro
 * que ya salió del cajón (el POS lo reintenta desde su cola).
 *
 * 🔴 NUNCA lanza: corre dentro del camino de un 403 y un fallo de base no puede
 * convertir un "no tienes permiso" en un 500. Sin token válido → null → 403.
 */
export async function consumePermissionOverride(params: {
  token: string
  venueId: string
  permission: string
  route: string
  operationKey?: string | null
  now?: Date
}): Promise<{ authorizedById: string } | null> {
  const { token, venueId, permission, route, operationKey = null } = params
  const now = params.now ?? new Date()
  // A3 (cierre): sin query string, también si quien llama la mandara (un código de tarjeta viajaba en una).
  const consumedRoute = route.split('?')[0]

  try {
    if (operationKey) {
      const row = await prisma.permissionOverride.findFirst({
        where: { token, venueId, permission, operationKey, expiresAt: { gt: now } },
        select: { authorizedById: true },
      })
      if (!row) return null

      // Sólo la primera vez escribe (consumedAt: null en el where); las demás son un no-op.
      await prisma.permissionOverride.updateMany({
        where: { token, consumedAt: null },
        data: { consumedAt: now, consumedRoute },
      })
      return { authorizedById: row.authorizedById }
    }

    // 🔴 El switch también manda al CONSUMIR, no sólo al emitir: si el negocio
    // apagó la función, un token vivo emitido hace 40 s deja de servir. Va antes
    // del updateMany a propósito — apagar el switch no puede QUEMAR los tokens
    // de quien alcanzó a pedirlos, sólo dejarlos sin efecto.
    if (!(await isManagerPinOverrideEnabled(venueId))) {
      logger.warn('Token de override presentado en un venue con la función apagada', { venueId, permission, route })
      return null
    }

    const claimed = await prisma.permissionOverride.updateMany({
      where: { token, venueId, permission, consumedAt: null, operationKey: null, expiresAt: { gt: now } },
      data: { consumedAt: now, consumedRoute },
    })

    if (claimed.count !== 1) return null

    const row = await prisma.permissionOverride.findUnique({
      where: { token },
      select: { authorizedById: true },
    })

    return row ? { authorizedById: row.authorizedById } : null
  } catch (error) {
    logger.error('No se pudo consumir el token de override — se trata como no autorizado', { venueId, permission, error })
    return null
  }
}

/**
 * Descuento del cliente (fase 1): el gerente cuyo PIN autorizó el descuento de ESTE cliente (`descuento-cliente:<customerId>:
 * <discountId>`, `discounts:apply`, vigente y de este negocio), para guardarlo en `OrderDiscount.authorizedById`.
 *
 * 🔴 LEE sin gastar: la autorización está atada al cliente y su descuento, no a la venta (la cajera puede editar el carrito
 * después del PIN). Y NUNCA hace fallar la venta: el servidor no exige el permiso, así que una autorización que no sirve
 * (otro cliente, otro descuento, vencida, de otro negocio) o una base caída sólo dejan el autorizador en `null`, con aviso.
 */
export async function autorizadorDelDescuentoDelCliente(p: {
  venueId: string
  token: string | null | undefined
  customerId: string | null | undefined
  discountId: string
  ahora?: Date
}): Promise<string | null> {
  const token = p.token?.trim()
  if (!token) return null
  const contexto = { venueId: p.venueId, customerId: p.customerId ?? null, discountId: p.discountId }
  if (!p.customerId) {
    logger.warn('Autorización del descuento del cliente sin cliente en la venta: se guarda sin autorizador', contexto)
    return null
  }
  try {
    const fila = await prisma.permissionOverride.findFirst({
      where: {
        token,
        venueId: p.venueId,
        permission: 'discounts:apply',
        operationKey: llaveDelDescuentoDelCliente(p.customerId, p.discountId),
        expiresAt: { gt: p.ahora ?? new Date() },
      },
      select: { authorizedById: true },
    })
    if (!fila) logger.warn('Autorización del descuento del cliente que no sirve: se guarda sin autorizador', contexto)
    return fila?.authorizedById ?? null
  } catch (error) {
    logger.error('No se pudo leer la autorización del descuento del cliente: se guarda sin autorizador', { ...contexto, error })
    return null
  }
}

/**
 * ¿El venue activó el PIN de autorización? Nace OFF.
 * 🔴 NUNCA lanza: se llama en el camino de un 403 y un fallo de base no puede
 * convertir un "no tienes permiso" en un 500.
 */
export async function isManagerPinOverrideEnabled(venueId: string): Promise<boolean> {
  try {
    const settings = await prisma.venueSettings.findUnique({
      where: { venueId },
      select: { managerPinOverrideEnabled: true },
    })
    return settings?.managerPinOverrideEnabled === true
  } catch (error) {
    logger.error('No se pudo leer managerPinOverrideEnabled — se asume apagado', { venueId, error })
    return false
  }
}
