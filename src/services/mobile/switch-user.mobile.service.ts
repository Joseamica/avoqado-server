// src/services/mobile/switch-user.mobile.service.ts

/**
 * Cambiar de usuario por PIN en el POS móvil.
 *
 * Lo que pidió el founder (2026-08-29), textual: *«en lugar de que tenga que cerrar sesión, poner
 * su mail y contraseña nuevamente para cambiar el usuario —sin quitar eso de cerrar sesión— que
 * esté un nuevo apartado cambiar usuario y salga el pinpad»*, y **«es como un logout login pero
 * con pin»**.
 *
 * 🔑 Esa última frase es el contrato de este archivo: la respuesta tiene **la misma forma que el
 * login** (`accessToken`, `refreshToken`, `staff` con sus venues). El cliente reusa su mismo
 * camino de guardado y refresca la UI entera con los permisos nuevos. Si la forma difiriera, cada
 * app tendría que escribir un SEGUNDO camino — y ahí es donde aparece la pantalla que se queda
 * con los permisos del anterior.
 *
 * 🔴 Lo que hace segura esta operación NO es el PIN: son 4 a 10 dígitos. Es que el PIN sólo se
 * acepta **encima de una sesión ya viva en ese aparato**, y esa sesión nació de un login con
 * correo y contraseña. En una tablet donde nadie entró nunca, no hay sesión sobre la cual operar
 * y esto no existe como puerta de entrada.
 *
 * Y el matiz que define el riesgo real, para quien venga a endurecer esto: **cambiar de usuario ya
 * se puede hacer hoy** cerrando sesión y volviendo a entrar con contraseña. Esto no abre una
 * puerta nueva — cambia la llave de esa puerta, de contraseña a PIN, en un aparato de confianza.
 *
 * NO confundir con el selector «Vendiendo: X» de la pantalla de cobro: ése atribuye la venta a un
 * vendedor, no da permisos, es libre y **sigue siendo libre** (decisión del founder: cambiar de
 * vendedor rápido no puede pedir PIN). Son dos velocidades a propósito.
 */
import { AuthMethod } from '@prisma/client'

import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { AuthenticationError } from '../../errors/AppError'
import { createSession, revokeSession } from '@/services/auth/session.service'
import { invalidateSession } from '@/services/auth/sessionCache'
import socketManager from '@/communication/sockets/managers/socketManager'
import { issueGrant } from '@/services/auth/refreshGrant.service'
import { refreshGrantExpiry } from './auth.mobile.service'
import { resolveStaffVenuePermissions } from '../../lib/resolveEffectivePermissions'
import { getRoleDisplayNamesForVenues } from '../dashboard/venueRoleConfig.dashboard.service'
import * as jwtService from '../../jwt.service'
import { logAction } from '../dashboard/activity-log.service'
import crypto from 'crypto'

/**
 * 🔴 UN SOLO mensaje para PIN inexistente, persona dada de baja, acceso desactivado y negocio no
 * operativo. Si el error distingue, el aparato se convierte en un buscador de PINes válidos: con
 * 10,000 combinaciones, un mensaje que dijera "ese PIN existe pero la persona está inactiva" es
 * media respuesta regalada.
 */
const ERROR_GENERICO = 'PIN incorrecto'

export interface SwitchUserParams {
  venueId: string
  pin: string
  /** `sid` de la sesión que está abierta AHORA en este aparato. Sin ella no se cambia de usuario. */
  sesionActualId?: string | null
  /** Quién estaba operando, sólo para la bitácora. */
  staffSalienteId?: string | null
  /** El aparato (`X-Device-Id`). Se hereda a la sesión entrante: el relevo ocurre en la MISMA
   *  tablet, así que sacar ese aparato desde el dashboard tiene que alcanzar también a quien
   *  entró por PIN. */
  deviceId?: string | null
}

export async function switchUserByPin(params: SwitchUserParams) {
  const { venueId, pin, sesionActualId, staffSalienteId, deviceId } = params

  // 🔴 Sin sesión viva no hay cambio de usuario. Esta línea ES el modelo de seguridad de esta
  // feature: el PIN nunca abre una tablet fría, sólo releva a quien ya estaba dentro.
  if (!sesionActualId) {
    throw new AuthenticationError(ERROR_GENERICO)
  }

  // Mismo patrón que el checador (`identifyByPin`): acotado a ESTE venue, con el acceso y la
  // persona activos. Comprobar `staff.active` aquí no es adorno — `validateStaffVenue()` no lo
  // hace, y sin él alguien dado de baja sigue entrando mientras su StaffVenue siga activo.
  const staffVenue = await prisma.staffVenue.findFirst({
    where: { venueId, pin, active: true, staff: { active: true } },
    include: {
      permissionSet: true,
      staff: { select: { id: true, firstName: true, lastName: true, email: true, photoUrl: true, phone: true, createdAt: true } },
      venue: {
        select: {
          id: true,
          name: true,
          slug: true,
          logo: true,
          type: true,
          status: true,
          kycStatus: true,
          organizationId: true,
          timezone: true,
        },
      },
    },
  })

  if (!staffVenue) {
    logger.warn(`🔐 [SWITCH-USER] PIN rechazado | venue=${venueId}`)
    throw new AuthenticationError(ERROR_GENERICO)
  }

  // Permisos EFECTIVOS de quien entra: conjunto asignado si lo tiene, si no el rol con las
  // personalizaciones del venue. Es el mismo resolutor del login, para que la app no pueda
  // acabar con un conjunto distinto según por dónde entró.
  const customPerms = await prisma.venueRolePermission.findFirst({
    where: { venueId, role: staffVenue.role },
    select: { permissions: true, deniedPermissions: true },
  })
  const permissions = resolveStaffVenuePermissions(staffVenue, customPerms as never)

  // La sesión entrante cuelga de la saliente (`parentSessionId`): así la bitácora puede
  // reconstruir la cadena de relevos de un aparato durante un turno.
  const session = await createSession({
    staffId: staffVenue.staffId,
    venueId,
    authMethod: AuthMethod.PIN,
    parentSessionId: sesionActualId,
    deviceId,
  })

  // 🔴 Revocar la saliente es lo que hace que esto sea un relevo y no una segunda llave: sin
  // esto, el token del anterior sigue vivo y quien lo tenga guardado puede seguir operando con
  // SUS permisos aunque en la pantalla ya esté otra persona.
  await revokeSession(sesionActualId, 'switch_user')

  // 🔴 Invalidar la caché NO es opcional, y esto se encontró EN VIVO: revocar escribe en la base,
  // pero el middleware pregunta a una caché de 60 s (`isSessionAliveCached`). Sin esta línea el
  // token del anterior seguía devolviendo 200 durante un minuto entero después del relevo — en un
  // mostrador, tiempo de sobra para justo lo que esta feature viene a cerrar.
  await invalidateSession(sesionActualId)

  // 🔴 Y el socket. Revocar corta el acceso HTTP, pero una conexión ya abierta vive aparte: sin
  // esto el aparato sigue recibiendo eventos en tiempo real bajo la identidad de quien acaba de
  // salir, hasta que la revalidación periódica lo cace — hasta 10 minutos. Mismo patrón que usan
  // el cambio de contraseña y la detección de reúso del refresh. Nunca lanza (ver su docstring),
  // así que no necesita su propio try/catch: un socket que no se pudo cerrar no puede impedir
  // que alguien tome el aparato.
  socketManager.disconnectBySession(sesionActualId)

  // Tokens con el MISMO criterio que el login móvil: `pos: true` (access corto, este carril lo
  // usan sólo avoqado-android y avoqado-ios) y el `sid` de la sesión recién creada en ambos.
  const accessToken = jwtService.generateAccessToken(
    staffVenue.staffId,
    staffVenue.venue.organizationId,
    venueId,
    staffVenue.role,
    undefined,
    { sid: session.id, pos: true },
  )
  const refreshToken = jwtService.generateRefreshToken(staffVenue.staffId, staffVenue.venue.organizationId, undefined, venueId, {
    sid: session.id,
  })

  // Sin este grant, el PRIMER refresco de la sesión nueva se leería como reutilización y echaría
  // a la persona que acaba de entrar. Una familia nueva por sesión.
  await issueGrant(session.id, crypto.randomUUID(), refreshToken, refreshGrantExpiry())

  // Bitácora: un relevo de aparato es exactamente lo que un dueño audita cuando algo no cuadra en
  // un turno. Fire-and-forget FUERA de cualquier transacción, como manda la regla del repo: que
  // la bitácora falle no puede impedir que alguien tome posesión de la caja.
  void logAction({
    action: 'POS_USER_SWITCHED',
    entity: 'Session',
    entityId: session.id,
    staffId: staffVenue.staffId,
    venueId,
    data: { sesionSaliente: sesionActualId, staffSaliente: staffSalienteId ?? null, method: 'pin' },
  })

  logger.info(`🔐 [SWITCH-USER] ${staffVenue.staff.email} tomó el aparato | venue=${venueId}`)

  // 🔑 La forma es la MISMA del login, y esto se verificó LLAMANDO al endpoint real, no leyendo
  // el código: el login móvil responde `{ success, message, user, accessToken, refreshToken }` —
  // con `user`, NO con `staff`, y con `lastLogin` y `roleDisplayName` dentro de cada venue. La
  // primera versión de este servicio devolvía `staff` y le faltaban esos dos campos; la app
  // habría recibido `undefined` donde espera el nombre del rol, y sin un solo error de por medio.
  //
  // Por eso tampoco se envuelve en `{ data: ... }`, que es la convención general de la casa: aquí
  // manda el contrato que puso el founder — «es como un logout login pero con pin» —, y eso sólo
  // se cumple si el cliente puede reusar EXACTAMENTE su camino de guardado del login.
  const roleDisplayNames = await getRoleDisplayNamesForVenues([{ venueId, role: staffVenue.role }])

  return {
    success: true,
    message: 'Usuario cambiado',
    accessToken,
    refreshToken,
    user: {
      id: staffVenue.staff.id,
      email: staffVenue.staff.email,
      firstName: staffVenue.staff.firstName,
      lastName: staffVenue.staff.lastName,
      organizationId: staffVenue.venue.organizationId,
      photoUrl: staffVenue.staff.photoUrl,
      phone: staffVenue.staff.phone,
      createdAt: staffVenue.staff.createdAt,
      lastLogin: new Date(),
      // 🔴 SÓLO este negocio, aunque la forma sea la del login: el relevo es de ESTE mostrador y
      // no tiene por qué revelar en qué otras sucursales trabaja la persona que acaba de entrar.
      venues: [
        {
          id: staffVenue.venue.id,
          name: staffVenue.venue.name,
          slug: staffVenue.venue.slug,
          logo: staffVenue.venue.logo,
          type: staffVenue.venue.type,
          role: staffVenue.role,
          roleDisplayName: roleDisplayNames.get(`${venueId}:${staffVenue.role}`),
          status: staffVenue.venue.status,
          kycStatus: staffVenue.venue.kycStatus,
          timezone: staffVenue.venue.timezone,
          permissions,
        },
      ],
    },
  }
}
