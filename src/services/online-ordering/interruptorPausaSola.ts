import logger from '@/config/logger'
import prisma from '@/utils/prismaClient'

/**
 * D662 parte 2 (v5, rediseño B, founder 20-nov): el INTERRUPTOR de la pausa sola, «pausa sola desde <hora>». Reemplaza al arranque
 * automático (`ArranqueDeFuncion`, el sello y los 120 s), que no convergió en 5 rondas de Codex.
 *
 * Sin fila (o con `desde` vacío) la pausa sola no existe: la tienda se porta como antes de esta función. Con una hora, sólo cuentan los
 * pedidos cuya hora límite es ≥ esa hora, y antes de ella tampoco hay pausa sola. La marca `staffAnsweredAt` se escribe SIEMPRE (con o
 * sin interruptor): es lo que hace seguro prenderlo.
 *
 * Vive en la BASE y no en una variable de Render (Codex p2v5-r1 #1): una variable necesita redesplegar, y si ese despliegue falla Render
 * sigue sirviendo con el servidor sin la variable, así que a la hora anunciada la pausa sola no existiría y luego aparecería de golpe. Con
 * la fila, todos los servidores la ven a la vez (a lo más `CACHE_MS` después), sin redesplegar.
 *
 * 🔴 El paso al publicar (promesa v5, `docs/audit/2026-11-18-tienda-abierta-cualquier-pantalla/plan-p2-v5-interruptor.md`):
 *   1. publicar el SERVIDOR (la migración crea la tabla vacía: apagado);
 *   2. cuando Render diga «Live», esperar 2 minutos (el SERVIDOR anterior, que no pone la marca, ya se apagó);
 *   3. correr `scripts/pausa-sola-interruptor.ts --prender` (pone «desde» = ahora + 15 min; nunca acepta una hora pasada ni cercana).
 * Todo pedido que contestó el SERVIDOR anterior existía antes de apagarse y su hora límite es, a lo más, 10 min después
 * (`ACCEPT_TIMEOUT_MINUTES`): con la hora del paso 3 ninguno cuenta. Si alguna vez se regresa a una versión anterior a ésta, al volver se
 * apaga y se repite el paso 3.
 */
export const CLAVE_PAUSA_SOLA = 'pausa-sola'
/** Cada proceso recuerda lo leído a lo más esto: la hora se fija ≥ 15 min en el futuro, así que todos la ven antes de que llegue. */
export const CACHE_MS = 5_000
/** Lo mínimo que «desde» puede quedar en el futuro al prenderlo (y lo que se usa por omisión). */
export const MINUTOS_MINIMOS = 15

let leido: { desde: Date | null; hasta: number } | null = null
let enCurso: Promise<Date | null> | null = null

/** La hora del interruptor, o `null` si está apagado. Lanza si la base falla (quien lee decide: la admisión no pasa). */
export async function pausaSolaDesde(): Promise<Date | null> {
  if (leido && Date.now() < leido.hasta) return leido.desde
  if (!enCurso) {
    enCurso = Promise.resolve()
      .then(() => prisma.interruptorDePlataforma.findUnique({ where: { clave: CLAVE_PAUSA_SOLA }, select: { desde: true } }))
      .then(fila => {
        const desde = fila?.desde ?? null
        leido = { desde, hasta: Date.now() + CACHE_MS }
        return desde
      })
      .finally(() => {
        enCurso = null
      })
  }
  return enCurso
}

export function __resetInterruptorParaPruebas(): void {
  leido = null
  enCurso = null
}

/**
 * Prende el interruptor: «desde» = ahora + [minutos] (≥ `MINUTOS_MINIMOS`). Nunca una hora pasada ni cercana: el redespliegue y los
 * pedidos del SERVIDOR anterior necesitan ese margen, y una hora pasada pausaría de golpe por pedidos que vencieron antes de prenderlo.
 * Si ya estaba prendido con una hora que ya llegó, no la mueve (moverla perdería fallas ya contadas): para cambiarla, primero se apaga.
 */
export async function prenderPausaSola(p: { minutos?: number; por: string; now?: Date }): Promise<Date> {
  const minutos = p.minutos ?? MINUTOS_MINIMOS
  if (!Number.isFinite(minutos) || minutos < MINUTOS_MINIMOS) {
    throw new Error(`La pausa sola se prende al menos ${MINUTOS_MINIMOS} minutos en el futuro (pediste ${minutos}).`)
  }
  const now = p.now ?? new Date()
  const desde = new Date(now.getTime() + minutos * 60_000)
  const actual = await prisma.interruptorDePlataforma.findUnique({ where: { clave: CLAVE_PAUSA_SOLA }, select: { desde: true } })
  if (actual?.desde && actual.desde.getTime() <= now.getTime()) {
    throw new Error(`La pausa sola ya está prendida desde ${actual.desde.toISOString()}. Para cambiar la hora, primero apágala.`)
  }
  await prisma.interruptorDePlataforma.upsert({
    where: { clave: CLAVE_PAUSA_SOLA },
    create: { clave: CLAVE_PAUSA_SOLA, desde, actualizadoPor: p.por },
    update: { desde, actualizadoPor: p.por },
  })
  logger.info('[OnlineOrdering] pausa sola PRENDIDA', { desde: desde.toISOString(), por: p.por })
  return desde
}

/** Apaga el interruptor (la tienda vuelve a portarse como antes de esta función en ≤ `CACHE_MS`). */
export async function apagarPausaSola(p: { por: string }): Promise<void> {
  await prisma.interruptorDePlataforma.upsert({
    where: { clave: CLAVE_PAUSA_SOLA },
    create: { clave: CLAVE_PAUSA_SOLA, desde: null, actualizadoPor: p.por },
    update: { desde: null, actualizadoPor: p.por },
  })
  logger.info('[OnlineOrdering] pausa sola APAGADA', { por: p.por })
}
