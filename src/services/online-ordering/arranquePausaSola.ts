import { Prisma } from '@prisma/client'
import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'
import { utcTs } from '@/utils/sqlDates'

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
/** La escritura en curso del arranque: todas las peticiones que llegan mientras tanto esperan ESTA (Codex p2v4-r4 #2). */
let escribiendo: Promise<void> | null = null
let arranque: ArranqueDeLaPausaSola | null = null
/**
 * La hora de la PRIMERA petición que atendió este proceso, fija aunque su escritura falle o tarde: todo reintento escribe ESTA hora
 * (Codex p2v4-r2 #1: si no, una segunda petición que insertara primero fijaría una hora posterior y dejaría fuera lo que venció entre
 * las dos).
 */
let primeraPeticion: Date | null = null

export function __resetArranqueParaPruebas(): void {
  escrita = false
  escribiendo = null
  arranque = null
  primeraPeticion = null
}

/** ¿Esta petición cuenta como «el SERVIDOR nuevo ya atiende»? Todas menos la revisión de salud de Render. */
export function cuentaComoServicio(path: string): boolean {
  // Express también sirve `/health/` como la misma ruta (Codex p2v4-r2 #1).
  return !/^\/health\/?$/i.test(path)
}

/** La primera petición atendida deja su hora (una vez; nunca lanza ni demora la petición). Una sola escritura a la vez. */
export function marcarPrimerServicio(ahora: Date = new Date()): Promise<void> {
  if (escrita) return Promise.resolve()
  if (!primeraPeticion) primeraPeticion = ahora
  if (escribiendo) return escribiendo
  const hora = primeraPeticion
  escribiendo = prisma.arranqueDeFuncion
    .createMany({ data: [{ clave: CLAVE_PAUSA_SOLA, primerServicioAt: hora }], skipDuplicates: true })
    .then(() => {
      escrita = true
    })
    .catch(error => {
      logger.warn('[OnlineOrdering] no se pudo guardar el arranque de la pausa sola (se reintenta con la siguiente petición)', {
        error: error instanceof Error ? error.message : String(error),
      })
    })
    .finally(() => {
      escribiendo = null
    })
  return escribiendo
}

/**
 * Middleware: nunca falla la petición. La PRIMERA espera su escritura (una vez en la vida del proceso; Codex p2v4-r3 #2: si el proceso cae
 * antes de guardarla, el reemplazo fijaría una hora posterior); si la base no contesta, sigue igual y la siguiente petición reintenta.
 */
export function marcarPrimerServicioMiddleware(req: { path: string }, _res: unknown, next: () => void): void {
  if (escrita || !cuentaComoServicio(req.path)) {
    next()
    return
  }
  void marcarPrimerServicio().then(() => next())
}

/**
 * Lo que contestó el SERVIDOR anterior (que no pone la marca) en pedidos creados antes del primer servicio: aceptado, listo, entregado,
 * cancelado por el personal o por otra vía, rechazado por una persona, la tarjeta pasó a cobrarse o falló al cobrarse (eso sólo lo dispara
 * el toque de aceptar) o, todavía por aceptar, con su cuenta ya anulada. NO `CAPTURED` solo (p2v4-r1 #3). Aceptado/listo/entregado sólo con
 * `acceptedAt`: el cobro tardío de un pedido VENCIDO lo pasa a entregado sin aceptación (p2v4-r3 #1), aunque ocurra antes del sello.
 */
const evidenciaDelAnterior = Prisma.sql`(
  (oo.status IN ('ACCEPTED', 'READY', 'COMPLETED') AND oo."acceptedAt" IS NOT NULL)
  OR oo.status = 'CANCELLED_BY_STAFF'
  OR (oo.status = 'REJECTED' AND oo."rejectReason" IS DISTINCT FROM 'PAYMENT_FAILED')
  OR EXISTS (SELECT 1 FROM "OnlineOrderCharge" c WHERE c."onlineOrderId" = oo.id AND c.status IN ('CAPTURING', 'CAPTURE_FAILED'))
  OR (
    oo.status = 'PENDING_ACCEPTANCE'
    AND EXISTS (SELECT 1 FROM "Order" o WHERE o.id = oo."orderId" AND o.status IN ('CANCELLED', 'DELETED'))
  )
)`

/**
 * v4 (Codex p2v4-r3 #1): al llegar el inicio, UNA vez en la vida, se SELLA lo que contestó el SERVIDOR anterior: los pedidos creados antes
 * del primer servicio, sin marca, con hora límite después del inicio y con evidencia de persona reciben `staffAnsweredAt = primerServicio`
 * (a tiempo, y antes de cualquier hora límite que cuente). Desde ahí la lectura sólo mira la marca: un cobro tardío que pase un pedido
 * VENCIDO a entregado ya no lo convierte en «contestado» (la evidencia se lee una vez, cuando el anterior ya no existe). Bajo candado
 * para que dos lecturas no lo hagan a la vez; idempotente.
 */
async function sellarLoDelServidorAnterior(a: ArranqueDeLaPausaSola): Promise<void> {
  await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'pausa-sola:sello'}))`
    const fila = await tx.arranqueDeFuncion.findUnique({ where: { clave: CLAVE_PAUSA_SOLA }, select: { legadoSelladoAt: true } })
    if (fila?.legadoSelladoAt) return
    const sellados = await tx.$executeRaw`
      UPDATE "OnlineOrder" oo SET "staffAnsweredAt" = ${utcTs(a.primerServicio)}
      WHERE oo."requiresAcceptance" = true
        AND oo."staffAnsweredAt" IS NULL
        AND oo."createdAt" < ${utcTs(a.primerServicio)}
        AND oo."acceptDeadlineAt" > ${utcTs(a.inicio)}
        AND ${evidenciaDelAnterior}`
    await tx.arranqueDeFuncion.updateMany({
      where: { clave: CLAVE_PAUSA_SOLA, legadoSelladoAt: null },
      data: { legadoSelladoAt: new Date() },
    })
    logger.info('[OnlineOrdering] pausa sola: sellado lo que contestó el SERVIDOR anterior', { sellados })
  })
}

/**
 * El arranque de la pausa sola, o `null` si este código todavía no atiende. Antes del inicio devuelve el arranque sin sellar (la lectura no
 * cuenta nada); desde el inicio, sella una vez y lo recuerda. Si el sello falla, LANZA (la lectura falla; la siguiente reintenta).
 */
export async function arranqueDeLaPausaSola(): Promise<ArranqueDeLaPausaSola | null> {
  if (arranque) return arranque
  const fila = await prisma.arranqueDeFuncion.findUnique({
    where: { clave: CLAVE_PAUSA_SOLA },
    select: { primerServicioAt: true, legadoSelladoAt: true },
  })
  if (!fila) return null
  const a = { primerServicio: fila.primerServicioAt, inicio: new Date(fila.primerServicioAt.getTime() + MARGEN_DEL_ARRANQUE_MS) }
  if (!fila.legadoSelladoAt) {
    if (Date.now() < a.inicio.getTime()) return a
    // Si el sello falla, la lectura FALLA (Codex p2v4-r4 #1): nunca se contesta «sin pausa» por no haber podido sellar; la admisión de
    // un pedido nuevo no pasa y la siguiente lectura reintenta.
    await sellarLoDelServidorAnterior(a)
  }
  arranque = a
  return arranque
}
