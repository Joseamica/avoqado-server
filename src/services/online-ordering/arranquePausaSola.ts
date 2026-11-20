import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'

/**
 * D662 parte 2 (v4, «cero huecos», founder 20-nov): el INICIO de la pausa sola, uno solo para toda la plataforma. Reemplaza a la gracia
 * del despliegue por fila (20 min) que el founder no aceptó.
 *
 * - La primera petición HTTP que atiende ESTE código (cualquiera menos `/health`) guarda su hora, una sola vez en la vida
 *   (`ArranqueDeFuncion`, `INSERT … ON CONFLICT DO NOTHING`). Render sólo le manda `/health` a una instancia nueva hasta que queda sana:
 *   un despliegue que falla antes del cambio nunca la escribe; uno que se repite la escribe al quedar. Los trabajos programados nunca la
 *   escriben.
 * - La pausa sola cuenta desde `primerServicioAt + 120 s`: Render manda `SIGTERM` al SERVIDOR anterior 60 s después del cambio y le da
 *   30 s más (90 s), más lo que tarda en terminar una transacción (15 s), con holgura (Codex p2v4-r1 #2). Ese servidor no conoce la
 *   pausa sola: lo que contestó no trae la marca, y todo lo que hizo queda guardado antes de este inicio (`presence.service`,
 *   `contestadoPorElAnterior`).
 * Sin fila (código nuevo que todavía no atiende), la pausa sola no existe: la tienda se comporta como antes de publicar.
 */
export const CLAVE_PAUSA_SOLA = 'pausa-sola'
export const MARGEN_DEL_ARRANQUE_MS = 120_000

export interface ArranqueDeLaPausaSola {
  /** La primera petición que atendió este código: lo creado antes pudo contestarlo el SERVIDOR anterior. */
  primerServicio: Date
  /** Desde cuándo cuenta la pausa sola (`primerServicio + MARGEN_DEL_ARRANQUE_MS`). */
  inicio: Date
}

let escrita = false
let arranque: ArranqueDeLaPausaSola | null = null

export function __resetArranqueParaPruebas(): void {
  escrita = false
  arranque = null
}

/** ¿Esta petición cuenta como «el SERVIDOR nuevo ya atiende»? Todas menos la revisión de salud de Render. */
export function cuentaComoServicio(path: string): boolean {
  return path !== '/health'
}

/** La primera petición atendida deja su hora (una vez; nunca lanza ni demora la petición). */
export async function marcarPrimerServicio(ahora: Date = new Date()): Promise<void> {
  if (escrita) return
  try {
    await prisma.arranqueDeFuncion.createMany({
      data: [{ clave: CLAVE_PAUSA_SOLA, primerServicioAt: ahora }],
      skipDuplicates: true,
    })
    escrita = true
  } catch (error) {
    logger.warn('[OnlineOrdering] no se pudo guardar el arranque de la pausa sola (se reintenta con la siguiente petición)', {
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/** Middleware: nunca espera ni falla la petición. */
export function marcarPrimerServicioMiddleware(req: { path: string }, _res: unknown, next: () => void): void {
  if (!escrita && cuentaComoServicio(req.path)) void marcarPrimerServicio()
  next()
}

/** El arranque de la pausa sola, o `null` si este código todavía no atiende. Una vez conocido no cambia (se recuerda). */
export async function arranqueDeLaPausaSola(): Promise<ArranqueDeLaPausaSola | null> {
  if (arranque) return arranque
  const fila = await prisma.arranqueDeFuncion.findUnique({ where: { clave: CLAVE_PAUSA_SOLA }, select: { primerServicioAt: true } })
  if (!fila) return null
  arranque = { primerServicio: fila.primerServicioAt, inicio: new Date(fila.primerServicioAt.getTime() + MARGEN_DEL_ARRANQUE_MS) }
  return arranque
}
