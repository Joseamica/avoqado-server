import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'
import type { DecodedPng } from './pngDecode'
import { CACHE_SELLOS_MAX, fetchDecodedPng } from './remotePng'

/**
 * Abre los sellos de los negocios AL ARRANCAR, antes de que el servidor reciba tráfico.
 *
 * 🔴 Por qué existe (medido en producción, 21-oct-2026): `fetchDecodedPng` recuerda cada sello ya
 * abierto, pero ese recuerdo vive en la memoria del proceso y el servidor se despliega 3-4 veces al
 * día. Cada instancia nueva empezaba vacía, así que la PRIMERA tarjeta de Apple (o actualización de
 * passkit, o franja de Google) tras cada despliegue volvía a abrir el sello original —2225×2550 en
 * Testarudo— en el hilo que atiende los cobros: 1.0-1.5 s, y 3,088 ms el 21-oct a las 17:39 UTC,
 * que disparó la alerta «Server congelado ≥3 s». Aquí se paga ese costo una vez, cuando todavía no
 * hay ningún cliente esperando.
 *
 * 🔴 Nunca tumba ni atora el arranque: un sello roto, la red o la base caída sólo dejan ese sello
 * sin preparar (la descarga del cliente lo abrirá como antes), y `TOPE_PRECALENTADO_MS` limita
 * cuánto puede retrasar que el servidor abra su puerto — en un reinicio por caída, ese retraso es
 * tiempo fuera de servicio.
 *
 * Abrir un sello sigue congelando el hilo ~1.4 s en Render, así que deja un aviso
 * `[event-loop] hilo retenido` al arrancar. Es esperado: cada sello se abre por separado (entre uno
 * y otro hay una descarga), lejos de los 3 s de la alerta.
 */

/** Cuánto puede retrasar, como mucho, que el servidor abra su puerto. */
export const TOPE_PRECALENTADO_MS = 15_000

export interface ResultadoPrecalentado {
  abiertos: number
  fallidos: number
  /** Los que quedaron sin preparar por el tope de tiempo. */
  omitidos: number
  ms: number
}

/**
 * Las direcciones de los sellos propios, los más recientes primero. Con tope: no tiene caso preparar
 * más de los que el caché puede recordar.
 */
export async function listarSellosAPrecalentar(): Promise<string[]> {
  const filas = await prisma.walletCardDesign.findMany({
    where: { stampImageUrl: { not: null } },
    select: { stampImageUrl: true },
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    take: CACHE_SELLOS_MAX,
  })
  return [...new Set(filas.map(f => f.stampImageUrl).filter((url): url is string => Boolean(url)))]
}

export async function precalentarSellos(
  opciones: {
    /** Costura de prueba: de dónde salen las direcciones. */
    listar?: () => Promise<string[]>
    /** Costura de prueba: cómo se abre un sello. En producción, el mismo que usan las descargas. */
    abrir?: (url: string) => Promise<DecodedPng | null>
    topeMs?: number
    /** Costura de prueba: el reloj. */
    ahoraMs?: () => number
  } = {},
): Promise<ResultadoPrecalentado> {
  const listar = opciones.listar ?? listarSellosAPrecalentar
  const abrir = opciones.abrir ?? fetchDecodedPng
  const topeMs = opciones.topeMs ?? TOPE_PRECALENTADO_MS
  const ahora = opciones.ahoraMs ?? Date.now
  const inicio = ahora()
  const resultado: ResultadoPrecalentado = { abiertos: 0, fallidos: 0, omitidos: 0, ms: 0 }

  let urls: string[]
  try {
    urls = [...new Set(await listar())]
  } catch (error) {
    logger.warn('[sellos] No se pudo leer qué sellos preparar al arrancar; se abrirán en la primera descarga', {
      error: error instanceof Error ? error.message : String(error),
    })
    resultado.ms = ahora() - inicio
    return resultado
  }

  for (let i = 0; i < urls.length; i++) {
    if (ahora() - inicio >= topeMs) {
      resultado.omitidos = urls.length - i
      break
    }
    try {
      if (await abrir(urls[i])) resultado.abiertos++
      else resultado.fallidos++
    } catch {
      // fetchDecodedPng no lanza, pero el arranque no puede depender de eso.
      resultado.fallidos++
    }
  }

  resultado.ms = ahora() - inicio
  logger.info('[sellos] Preparados al arrancar', { ...resultado, total: urls.length })
  return resultado
}
