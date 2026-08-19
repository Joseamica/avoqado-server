/**
 * Echar de las sesiones abiertas a quien ya no debe estar.
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
 * Decision pura: ¿este token nacio antes del ultimo cambio de contrasena?
 *
 * Ante la duda NUNCA echa a nadie. Un token sin `iat`, o una cuenta que jamas
 * ha cambiado su contrasena (la enorme mayoria hoy), pasan. Equivocarse hacia
 * el otro lado significaria sacar a todos los clientes al mismo tiempo.
 */
export function tokenEmitidoAntesDelCambio(iatSegundos: number | undefined, cambio: Date | null | undefined): boolean {
  if (!cambio) return false
  if (typeof iatSegundos !== 'number' || !Number.isFinite(iatSegundos)) return false
  return iatSegundos * 1000 < cambio.getTime() - MARGEN_RELOJ_MS
}

const cache = new Map<string, { cambio: Date | null; expira: number }>()

/** Solo para tests: deja la cache como recien arrancada. */
export function _limpiarCacheDeCambiosDeContrasena(): void {
  cache.clear()
}

async function ultimoCambio(staffId: string): Promise<Date | null> {
  const ahora = Date.now()
  const enCache = cache.get(staffId)
  if (enCache && enCache.expira > ahora) return enCache.cambio

  const staff = await prisma.staff.findUnique({
    where: { id: staffId },
    select: { lastPasswordReset: true },
  })
  const cambio = staff?.lastPasswordReset ?? null
  cache.set(staffId, { cambio, expira: ahora + TTL_MS })

  // La cache crece con los usuarios activos, no sin limite; aun asi se poda
  // cuando se pasa de un tamano razonable para un proceso.
  if (cache.size > 5_000) {
    for (const [k, v] of cache.entries()) {
      if (v.expira <= ahora) cache.delete(k)
    }
  }
  return cambio
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
  if (!staffId || typeof iatSegundos !== 'number') return false
  try {
    return tokenEmitidoAntesDelCambio(iatSegundos, await ultimoCambio(staffId))
  } catch {
    return false
  }
}
