/**
 * Entrar con PIN y renovar la sesión del celular de campo (App de campo, bloque 1). El celular ya probó ser el aparato
 * (su credencial); entrar prueba a la PERSONA. Los PINes malos se cuentan SÓLO en la fila del celular (nunca por IP ni en
 * el `StaffVenue`): el celular de otra persona en la misma sucursal no se entera.
 */
import { CelularDeCampo } from '@prisma/client'
import AppError, { ConflictError, ForbiddenError, UnauthorizedError } from '@/errors/AppError'
import { hashToken, rotateGrant } from '@/services/auth/refreshGrant.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { refreshGrantExpiry } from '@/services/mobile/auth.mobile.service'
import { mensajeDeCorte, motivoDeSesionInvalidada } from '@/utils/passwordChangeGuard'
import prisma from '@/utils/prismaClient'
import { pinCoincide } from './credencial'
import { sucursalesDeCampoDeLaPersona, sucursalesDeLaPersona } from './personasDeCampo'
import { crearSesionDeCelular, sucursalesParaElCelular } from './sesionDeCelular'
import { firmarAccesoDeCampo, nuevoRefreshDeCampo } from './tokenDeCampo'

const FALLOS_SIN_ESPERA = 5
const MINUTO_MS = 60 * 1000

/** Espera tras `fallos` PINes malos seguidos, en ms: 0 hasta 4; luego 1, 2, 4… minutos, con tope de 60. */
export function esperaTrasFallos(fallos: number): number {
  if (fallos < FALLOS_SIN_ESPERA) return 0
  return Math.min(60, 2 ** Math.min(fallos - FALLOS_SIN_ESPERA, 6)) * MINUTO_MS
}

const desvinculado = () =>
  new UnauthorizedError('Este celular ya no está vinculado. Pide un código nuevo a tu supervisor.', 'CELULAR_DESVINCULADO')
const sesionInvalida = (mensaje = 'Tu sesión del celular no es válida. Entra de nuevo con tu PIN.') =>
  new UnauthorizedError(mensaje, 'SESION_INVALIDA')

function pinBloqueado(hasta: Date, ahora: Date) {
  const reintentaEn = Math.max(1, Math.ceil((hasta.getTime() - ahora.getTime()) / 1000))
  const minutos = Math.ceil(reintentaEn / 60)
  return new AppError(
    `Demasiados PINes incorrectos. Intenta de nuevo en ${minutos} ${minutos === 1 ? 'minuto' : 'minutos'}.`,
    429,
    true,
    'PIN_BLOQUEADO',
    { reintentaEn },
  )
}

/**
 * Cuenta el intento ANTES de comparar el PIN, y lo cuenta como fallo hasta que el PIN resulte bueno. El UPDATE toma el
 * candado de la fila hasta el commit y su `where` exige no estar bloqueado: los intentos del mismo celular van en fila,
 * y el que llega después del quinto ya ve el bloqueo (Postgres reevalúa el `where` sobre la versión nueva). Sin esto,
 * una ráfaga en paralelo comparaba todos sus PINes antes de que el primero escribiera el bloqueo.
 * Devuelve los fallos contando éste.
 */
async function reservarIntento(celularId: string): Promise<number> {
  const ahora = new Date()
  const fallos = await prisma.$transaction(async tx => {
    const { count } = await tx.celularDeCampo.updateMany({
      where: { id: celularId, staffIdVinculado: { not: null }, OR: [{ pinBloqueadoHasta: null }, { pinBloqueadoHasta: { lte: ahora } }] },
      data: { pinFallos: { increment: 1 } },
    })
    if (count === 0) return null
    const { pinFallos } = await tx.celularDeCampo.findUniqueOrThrow({ where: { id: celularId }, select: { pinFallos: true } })
    const espera = esperaTrasFallos(pinFallos)
    if (espera > 0) {
      await tx.celularDeCampo.updateMany({ where: { id: celularId }, data: { pinBloqueadoHasta: new Date(ahora.getTime() + espera) } })
    }
    return pinFallos
  })
  if (fallos !== null) return fallos
  const fila = await prisma.celularDeCampo.findUnique({
    where: { id: celularId },
    select: { staffIdVinculado: true, pinBloqueadoHasta: true },
  })
  if (!fila?.staffIdVinculado) throw desvinculado()
  // Hora de AHORA, no la de antes de esperar el candado: quien esperó detrás del quinto contaría más de 60 s.
  const despues = new Date()
  throw pinBloqueado(fila.pinBloqueadoHasta ?? despues, despues)
}

export async function entrarConPin(celular: CelularDeCampo, e: { pin: string; venueId?: string }) {
  const ahora = new Date()
  if (!celular.staffIdVinculado) throw desvinculado()
  if (celular.pinBloqueadoHasta && celular.pinBloqueadoHasta > ahora) throw pinBloqueado(celular.pinBloqueadoHasta, ahora)

  // Sólo sus sucursales de promotora (S13, A8): donde es gerente, o sin el módulo, no se entra.
  const sucursales = await sucursalesDeCampoDeLaPersona(celular.staffId, celular.organizationId)
  if (sucursales.length === 0)
    throw new ForbiddenError('No tienes una sucursal activa. Pídele a tu supervisor que te asigne una.', 'SIN_SUCURSAL')
  let sucursal = sucursales[0]
  if (e.venueId) {
    const elegida = sucursales.find(s => s.venueId === e.venueId)
    if (!elegida) throw new ForbiddenError('No tienes acceso a esa sucursal.', 'SIN_ACCESO_A_LA_SUCURSAL')
    sucursal = elegida
  } else if (sucursales.length > 1) {
    throw new ConflictError('Elige en qué sucursal vas a trabajar.', 'ELIGE_SUCURSAL', {
      sucursales: sucursales.map(s => ({ venueId: s.venueId, nombre: s.nombre })),
    })
  }
  if (!sucursal.pin) throw new ConflictError('Todavía no tienes PIN en esta sucursal: pídele a tu supervisor que te ponga uno.', 'SIN_PIN')

  const fallos = await reservarIntento(celular.id)
  if (!pinCoincide(sucursal.pin, e.pin)) {
    throw new AppError('El PIN no es correcto.', 401, true, 'PIN_INCORRECTO', {
      intentosAntesDeEsperar: Math.max(0, FALLOS_SIN_ESPERA - fallos),
    })
  }
  await prisma.celularDeCampo.updateMany({ where: { id: celular.id }, data: { pinFallos: 0, pinBloqueadoHasta: null } })

  const sesion = await crearSesionDeCelular(celular, sucursal)
  // Sin el PIN: la bitácora no guarda secretos.
  void logAction({
    staffId: celular.staffId,
    venueId: sucursal.venueId,
    organizationId: celular.organizationId,
    action: 'STAFF_LOGIN',
    entity: 'Staff',
    entityId: celular.staffId,
    data: { source: 'campo', method: 'pin', celularId: celular.id },
  })
  return { sesion, sucursales: await sucursalesParaElCelular(celular), horaDelServidor: new Date().toISOString() }
}

/**
 * El refresh es opaco: su grant da la `Session`, que debe ser LA del celular (`sesionId`), viva y de su persona. La
 * sucursal de la sesión tiene que seguir siendo suya (persona y `StaffVenue` activos, sucursal operativa); si no, el
 * celular vuelve a pedir el PIN. El access nuevo lleva el rol de HOY.
 */
export async function renovarSesionDeCelular(celular: CelularDeCampo, refreshToken: string) {
  if (!celular.staffIdVinculado) throw desvinculado()
  const grant = await prisma.refreshGrant.findUnique({
    where: { tokenHash: hashToken(refreshToken) },
    select: { session: { select: { id: true, staffId: true, venueId: true, revokedAt: true, createdAt: true } } },
  })
  const sesion = grant?.session
  if (!sesion || sesion.id !== celular.sesionId || sesion.staffId !== celular.staffId || sesion.revokedAt) throw sesionInvalida()

  // Como el móvil: cambiar la contraseña o «cerrar todas mis sesiones» corta también al celular. El refresh no trae
  // `iat`: cuenta cuándo nació la sesión (cuándo se entró con el PIN).
  const motivo = await motivoDeSesionInvalidada(sesion.staffId, Math.floor(sesion.createdAt.getTime() / 1000))
  if (motivo) throw sesionInvalida(mensajeDeCorte(motivo))

  const sucursal = (await sucursalesDeLaPersona(celular.staffId, celular.organizationId)).find(s => s.venueId === sesion.venueId)
  if (!sucursal) throw new UnauthorizedError('Ya no tienes acceso a esta sucursal. Entra de nuevo con tu PIN.', 'SIN_ACCESO_A_LA_SUCURSAL')

  const r = await rotateGrant(refreshToken, nuevoRefreshDeCampo(), refreshGrantExpiry())
  if ('reutilizado' in r) throw sesionInvalida()
  const accessToken = firmarAccesoDeCampo({
    staffId: celular.staffId,
    organizationId: celular.organizationId,
    venueId: sesion.venueId,
    role: sucursal.role,
    sid: sesion.id,
  })
  return { accessToken, refreshToken: r.sucesor, venueId: sesion.venueId }
}
