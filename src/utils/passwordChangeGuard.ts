/**
 * Echar de las sesiones abiertas a quien ya no debe estar.
 *
 * DOS DISPARADORES, UN SOLO CORTE. El corte nacio con uno solo —cambiar la
 * contrasena— y hoy tiene dos: tambien lo mueve la propia persona con "cerrar
 * sesion en todos mis dispositivos" (`sessionsRevokedAt`), que es el caso de la
 * tablet olvidada en un taxi: hasta ahora el dueno tenia que cambiarse la
 * contrasena para salir de un aparato que ya no tiene. Se compara contra el MAS
 * RECIENTE de los dos; el resto del mecanismo no cambia.
 *
 * PROBLEMA: cambiar la contrasena no cerraba ninguna sesion. El caso caro no es
 * el prospecto nuevo — es el dueno que corre a un gerente, le cambia la
 * contrasena creyendo que lo dejo fuera, y el gerente sigue entrando desde su
 * celular hasta 90 dias (lo que dura el refresh token con "recordarme"), viendo
 * ventas y cortes de caja. Lo mismo con una cuenta que alguien cree robada.
 *
 * POR QUE ASI: los tokens son JWT autonomos — no hay tabla de sesiones ni
 * Redis, asi que no existe una lista de "sesiones activas" que revocar. Lo que
 * si existe es la marca de CUANDO se cambio la contrasena (`lastPasswordReset`,
 * que hasta hoy se escribia y nadie leia). Comparando esa fecha contra el `iat`
 * del token —cuando se emitio— se sabe si el token es de antes del cambio.
 *
 * COSTO: una lectura por staff cacheada unos segundos (ver `TTL_MS`), no una
 * consulta por request. El precio de la ventana: una sesion echada puede tardar
 * hasta ese TTL en enterarse. Es el intercambio a cambio de no meterle una
 * consulta a la base a CADA request autenticado del dashboard y de las TPV.
 */
import prisma from './prismaClient'

/**
 * Margen para relojes desfasados entre procesos. Sin el, alguien que cambia su
 * contrasena y entra en el mismo instante podria echarse a si mismo por un
 * redondeo de milisegundos.
 */
const MARGEN_RELOJ_MS = 5_000

/** Cuanto se recuerda la fecha de cambio de un staff antes de volver a leerla. */
const TTL_MS = 30_000

/**
 * Decision pura: ¿este token nacio antes del corte?
 *
 * Ante la duda NUNCA echa a nadie. Un token sin `iat`, o una cuenta que jamas
 * ha movido su corte (la enorme mayoria hoy), pasan. Equivocarse hacia el otro
 * lado significaria sacar a todos los clientes al mismo tiempo.
 */
export function tokenEmitidoAntesDelCambio(iatSegundos: number | undefined, cambio: Date | null | undefined): boolean {
  if (!cambio) return false
  if (typeof iatSegundos !== 'number' || !Number.isFinite(iatSegundos)) return false
  return iatSegundos * 1000 < cambio.getTime() - MARGEN_RELOJ_MS
}

/**
 * Por que se corto la sesion. Importa porque es lo que se le dice a la persona:
 * ensenarle "tu contrasena cambio" a quien acaba de tocar "cerrar mis sesiones"
 * lo manda a recuperar una contrasena que nadie toco.
 */
export type MotivoDeCorte = 'PASSWORD_CHANGED' | 'SESSIONS_REVOKED'

/** El mensaje que ven las tres rieles, para que no se separen. */
export function mensajeDeCorte(motivo: MotivoDeCorte): string {
  return motivo === 'SESSIONS_REVOKED'
    ? 'Cerraste la sesión en todos tus dispositivos. Vuelve a iniciar sesión.'
    : 'Tu contraseña cambió. Vuelve a iniciar sesión.'
}

const cache = new Map<string, { corte: Corte | null; expira: number }>()

interface Corte {
  fecha: Date
  motivo: MotivoDeCorte
}

/** El corte es el MAS RECIENTE de los dos disparadores; null si ninguno se ha usado. */
function corteEfectivo(reset: Date | null | undefined, revocacion: Date | null | undefined): Corte | null {
  if (!reset && !revocacion) return null
  if (!reset) return { fecha: revocacion!, motivo: 'SESSIONS_REVOKED' }
  if (!revocacion) return { fecha: reset, motivo: 'PASSWORD_CHANGED' }
  // Empate: gana el cambio de contrasena. Es el mensaje mas util de los dos —
  // dice que la contrasena vieja ya no sirve.
  return reset.getTime() >= revocacion.getTime()
    ? { fecha: reset, motivo: 'PASSWORD_CHANGED' }
    : { fecha: revocacion, motivo: 'SESSIONS_REVOKED' }
}

/** Solo para tests: deja la cache como recien arrancada. */
export function _limpiarCacheDeCambiosDeContrasena(): void {
  cache.clear()
}

async function ultimoCambio(staffId: string): Promise<Corte | null> {
  const ahora = Date.now()
  const enCache = cache.get(staffId)
  if (enCache && enCache.expira > ahora) return enCache.corte

  const staff = await prisma.staff.findUnique({
    where: { id: staffId },
    select: { lastPasswordReset: true, sessionsRevokedAt: true },
  })
  const corte = corteEfectivo(staff?.lastPasswordReset, staff?.sessionsRevokedAt)
  cache.set(staffId, { corte, expira: ahora + TTL_MS })

  // La cache crece con los usuarios activos, no sin limite; aun asi se poda
  // cuando se pasa de un tamano razonable para un proceso.
  if (cache.size > 5_000) {
    for (const [k, v] of cache.entries()) {
      if (v.expira <= ahora) cache.delete(k)
    }
  }
  return corte
}

/**
 * Como `sesionInvalidadaPorCambioDeContrasena`, pero dice POR QUE — para que el
 * mensaje que ve la persona sea el que de verdad le paso.
 */
export async function motivoDeSesionInvalidada(
  staffId: string | undefined,
  iatSegundos: number | undefined,
): Promise<MotivoDeCorte | null> {
  if (!staffId || typeof iatSegundos !== 'number') return null
  try {
    const corte = await ultimoCambio(staffId)
    return corte && tokenEmitidoAntesDelCambio(iatSegundos, corte.fecha) ? corte.motivo : null
  } catch {
    // Igual que abajo: la base caida NUNCA puede convertirse en un cierre de
    // sesion masivo de todos los clientes.
    return null
  }
}

/**
 * ¿Hay que echar esta sesion? Se usa en el middleware de autenticacion.
 *
 * Si la consulta falla, deja pasar: la base caida no puede convertirse en un
 * cierre de sesion masivo de todos los clientes.
 */
export async function sesionInvalidadaPorCambioDeContrasena(
  staffId: string | undefined,
  iatSegundos: number | undefined,
): Promise<boolean> {
  return (await motivoDeSesionInvalidada(staffId, iatSegundos)) !== null
}

/**
 * "Cerrar sesion en todos mis dispositivos": mueve el corte de esta persona a
 * AHORA, asi que todo token vivo suyo —dashboard, TPV, Android, iOS— muere en
 * la siguiente peticion.
 *
 * 🔴 Mata TAMBIEN la sesion desde la que se pidio, a proposito. Es lo que hace
 * Square (al cerrar sesion te deja elegir "esta" o "todas", y "todas" incluye
 * el dashboard, el POS y el KDS) y es lo unico honesto: si el motivo es que la
 * cuenta pudo quedar expuesta, dejar viva una sesion —justo la que un intruso
 * podria estar usando para pedirlo— seria dejar el hueco abierto.
 *
 * 🔴 Vive AQUI, junto a la cache, y no en un servicio: sin borrar la entrada
 * cacheada el corte nuevo tarda hasta `TTL_MS` en verse, y la persona que
 * acaba de tocar el boton es justo la que tiene su entrada recien calentada.
 * Serian 30 segundos mas de vida para la tablet que se quiere apagar.
 */
export async function revokeAllSessions(staffId: string): Promise<Date> {
  const ahora = new Date()
  await prisma.staff.update({ where: { id: staffId }, data: { sessionsRevokedAt: ahora } })
  cache.delete(staffId)
  return ahora
}
