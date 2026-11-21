import type { Prisma } from '@prisma/client'
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
/**
 * El esquema de Postgres donde vive la tabla que lee la tienda (Prisma sin `schema` en la URL ni `@@schema`: `public`). El INSERT crudo lo
 * nombra (Codex p2v5-r6 #2: sin él, Postgres usa el primer esquema de `search_path` que tenga la tabla) y el script se niega fuera de él.
 */
export const ESQUEMA_DE_LA_TIENDA = 'public'
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
 * No mueve una hora que ya llegó o está por llegar (≤ `MARGEN_PARA_MOVER_S`): moverla perdería fallas ya contadas. Para cambiarla,
 * primero se apaga.
 *
 * Codex p2v5-r2 #7: revisar y escribir son UNA sola instrucción, con el reloj de Postgres: no hay hueco entre «la vi futura» y «la
 * cambié», ni dependencia del reloj de quien corre el script.
 *
 * Codex p2v5-r3 #2: ese reloj es `clock_timestamp()` (la hora REAL en que se evalúa), no `now()` (la hora en que EMPEZÓ la
 * transacción). Si otra transacción tiene la fila, la instrucción espera su candado, y con `now()` el guardia decidiría con la hora de
 * antes de esperar: podría mover una hora que llegó durante la espera. Por lo mismo la rama UPDATE no copia `EXCLUDED."desde"` (se
 * calcula ANTES de esperar): recalcula «desde» con su propio reloj, así nunca queda a menos de [minutos] del momento en que se escribe.
 * Postgres evalúa el WHERE y el SET de `ON CONFLICT DO UPDATE` después de tomar el candado de la fila.
 *
 * Codex p2v5-r4 #2: con la fila VACÍA la instrucción entra por el INSERT, cuyos valores se calculan antes de esperar a otro que la esté
 * insertando; si ése se revierte, éste insertaría con la hora de antes de esperar (< 15 min). Por eso prender y apagar toman primero el
 * mismo candado de la base (`CANDADO_DEL_INTERRUPTOR`, en su transacción): al calcular la hora nadie más está escribiendo la fila.
 */
export const MARGEN_PARA_MOVER_S = 10
const CANDADO_DEL_INTERRUPTOR = `interruptor-de-plataforma:${CLAVE_PAUSA_SOLA}`
/** Lo que corre en la transacción que escribe, después del candado y antes de escribir (el script confirma ahí la base; si lanza, no se escribe). */
type AntesDeEscribir = (tx: Prisma.TransactionClient) => Promise<void>
// ponytail: sólo el script escribe esta tabla; un escritor nuevo que no tome el candado reabre el hueco del INSERT.
const conCandado = <T>(antesDeEscribir: AntesDeEscribir | undefined, trabajo: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> =>
  prisma.$transaction(
    async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${CANDADO_DEL_INTERRUPTOR}))`
      if (antesDeEscribir) await antesDeEscribir(tx)
      return trabajo(tx)
    },
    // Lo corre una persona con el script (no hay prisa de pool): que espere conexión y candado sin el tope corto de 2 s.
    { maxWait: 10_000, timeout: 30_000 },
  )

export async function prenderPausaSola(p: { minutos?: number; por: string; antesDeEscribir?: AntesDeEscribir }): Promise<Date> {
  const minutos = p.minutos ?? MINUTOS_MINIMOS
  if (!Number.isFinite(minutos) || minutos < MINUTOS_MINIMOS) {
    throw new Error(`La pausa sola se prende al menos ${MINUTOS_MINIMOS} minutos en el futuro (pediste ${minutos}).`)
  }
  // El esquema va escrito tal cual (es `ESQUEMA_DE_LA_TIENDA`; un nombre no viaja como parámetro).
  const filas = await conCandado(
    p.antesDeEscribir,
    tx => tx.$queryRaw<Array<{ desde: Date }>>`
    INSERT INTO "public"."InterruptorDePlataforma" ("clave", "desde", "actualizadoPor", "updatedAt")
    VALUES (
      ${CLAVE_PAUSA_SOLA},
      (clock_timestamp() AT TIME ZONE 'UTC') + (${minutos}::double precision * interval '1 minute'),
      ${p.por},
      (clock_timestamp() AT TIME ZONE 'UTC')
    )
    ON CONFLICT ("clave") DO UPDATE
      SET "desde" = (clock_timestamp() AT TIME ZONE 'UTC') + (${minutos}::double precision * interval '1 minute'),
          "actualizadoPor" = EXCLUDED."actualizadoPor",
          "updatedAt" = (clock_timestamp() AT TIME ZONE 'UTC')
      WHERE "InterruptorDePlataforma"."desde" IS NULL
         OR "InterruptorDePlataforma"."desde" > (clock_timestamp() AT TIME ZONE 'UTC') + (${MARGEN_PARA_MOVER_S}::int * interval '1 second')
    RETURNING "desde"`,
  )
  const desde = filas[0]?.desde
  if (!desde) {
    throw new Error('La pausa sola ya está prendida con una hora que ya llegó (o está por llegar). Para cambiar la hora, primero apágala.')
  }
  logger.info('[OnlineOrdering] pausa sola PRENDIDA', { desde: desde.toISOString(), por: p.por })
  return desde
}

/** Apaga el interruptor (la tienda vuelve a portarse como antes de esta función en ≤ `CACHE_MS`). */
export async function apagarPausaSola(p: { por: string; antesDeEscribir?: AntesDeEscribir }): Promise<void> {
  await conCandado(p.antesDeEscribir, tx =>
    tx.interruptorDePlataforma.upsert({
      where: { clave: CLAVE_PAUSA_SOLA },
      create: { clave: CLAVE_PAUSA_SOLA, desde: null, actualizadoPor: p.por },
      update: { desde: null, actualizadoPor: p.por },
    }),
  )
  logger.info('[OnlineOrdering] pausa sola APAGADA', { por: p.por })
}
