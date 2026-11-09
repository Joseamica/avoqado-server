/**
 * La sesión del celular de campo (App de campo, bloque 1). Cada celular tiene UNA `Session` viva: su id en
 * `CelularDeCampo.sesionId` es lo que prueba que un token es de ese celular (el `deviceId` lo pone el cliente). Se
 * reemplaza con CAS sobre el valor leído: de dos entradas a la vez gana una y la otra se revoca (Codex R2-3), y la
 * credencial nueva de un reintento de activación viaja en el MISMO CAS (R3-4).
 */
import { CelularDeCampo, StaffRole } from '@prisma/client'
import { pbkdf2, randomUUID } from 'crypto'
import { promisify } from 'util'
import socketManager from '@/communication/sockets/managers/socketManager'
import { ConflictError, UnauthorizedError } from '@/errors/AppError'
import { issueGrant } from '@/services/auth/refreshGrant.service'
import { createSession, revokeSession } from '@/services/auth/session.service'
import { invalidateSession } from '@/services/auth/sessionCache'
import { refreshGrantExpiry } from '@/services/mobile/auth.mobile.service'
import prisma from '@/utils/prismaClient'
import { deviceIdDelCelular } from './credencial'
import { sucursalesDeLaPersona } from './personasDeCampo'
import { firmarAccesoDeCampo, nuevoRefreshDeCampo } from './tokenDeCampo'

export type SesionDeCelular = { accessToken: string; refreshToken: string; venueId: string; expiraEn: 86400 }
export type VerificadorDePin = { algoritmo: 'PBKDF2-SHA256'; iteraciones: 100000; sal: string; hash: string }

const pbkdf2Async = promisify(pbkdf2)

/** Revoca y corta YA (caché de 60 s y socket), como `revokeSessionsForDevice`. */
async function cerrarSesion(sessionId: string, motivo: string) {
  await revokeSession(sessionId, motivo)
  await invalidateSession(sessionId)
  socketManager.disconnectBySession(sessionId)
}

export async function crearSesionDeCelular(
  celular: CelularDeCampo,
  sucursal: { venueId: string; role: StaffRole },
  opciones: { nuevaCredencialHash?: string } = {},
): Promise<SesionDeCelular> {
  const anterior = celular.sesionId
  const sesion = await createSession({
    staffId: celular.staffId,
    venueId: sucursal.venueId,
    deviceId: deviceIdDelCelular(celular.id),
    authMethod: 'PIN',
  })
  // El grant nace antes de publicar la sesión: si el CAS gana, todo lo que el celular necesita ya existe.
  const refreshToken = nuevoRefreshDeCampo()
  await issueGrant(sesion.id, randomUUID(), refreshToken, refreshGrantExpiry())

  const { count } = await prisma.celularDeCampo.updateMany({
    where: { id: celular.id, staffIdVinculado: { not: null }, sesionId: anterior },
    data: { sesionId: sesion.id, ...(opciones.nuevaCredencialHash && { credencialHash: opciones.nuevaCredencialHash }) },
  })
  if (count === 0) {
    await cerrarSesion(sesion.id, 'campo_entrada_perdida')
    const actual = await prisma.celularDeCampo.findUnique({ where: { id: celular.id }, select: { staffIdVinculado: true } })
    if (!actual?.staffIdVinculado)
      throw new UnauthorizedError('Este celular ya no está vinculado. Pide un código nuevo a tu supervisor.', 'CELULAR_DESVINCULADO')
    throw new ConflictError('Otra entrada de este celular está en proceso. Intenta de nuevo.', 'ENTRADA_EN_PROCESO')
  }
  // Sólo la que estaba: revocar «todas menos la mía» mataría a una entrada que leyó la mía y todavía no hace su CAS.
  if (anterior) await cerrarSesion(anterior, 'campo_entrada_nueva')

  const accessToken = firmarAccesoDeCampo({
    staffId: celular.staffId,
    organizationId: celular.organizationId,
    venueId: sucursal.venueId,
    role: sucursal.role,
    sid: sesion.id,
  })
  return { accessToken, refreshToken, venueId: sucursal.venueId, expiraEn: 86400 }
}

/** Revoca las sesiones vivas del celular (sólo `celular:<id>`: la PAX de la persona sigue). Devuelve cuántas cerró. */
export async function revocarSesionesDelCelular(celularId: string, motivo: string, salvoSid?: string): Promise<number> {
  const where = { deviceId: deviceIdDelCelular(celularId), revokedAt: null, ...(salvoSid && { id: { not: salvoSid } }) }
  const vivas = await prisma.session.findMany({ where, select: { id: true } })
  if (vivas.length === 0) return 0
  const { count } = await prisma.session.updateMany({ where, data: { revokedAt: new Date(), revokedReason: motivo } })
  for (const s of vivas) {
    await invalidateSession(s.id)
    socketManager.disconnectBySession(s.id)
  }
  return count
}

/** Lo que el celular guarda para revisar el PIN sin señal. Asíncrono a propósito: 100 000 vueltas no bloquean el hilo. */
export async function verificadorDelPin(pin: string, salBase64: string): Promise<VerificadorDePin> {
  const hash = await pbkdf2Async(pin, Buffer.from(salBase64, 'base64'), 100000, 32, 'sha256')
  return { algoritmo: 'PBKDF2-SHA256', iteraciones: 100000, sal: salBase64, hash: hash.toString('base64') }
}

/** Sólo se entrega a quien ya demostró el PIN (activar, entrar) o tiene la credencial del celular vinculado (latido). */
export async function sucursalesParaElCelular(celular: Pick<CelularDeCampo, 'staffId' | 'organizationId' | 'pinSal'>) {
  const sucursales = await sucursalesDeLaPersona(celular.staffId, celular.organizationId)
  return Promise.all(
    sucursales.map(async s => ({
      venueId: s.venueId,
      nombre: s.nombre,
      verificadorPin: s.pin ? await verificadorDelPin(s.pin, celular.pinSal) : null,
    })),
  )
}
