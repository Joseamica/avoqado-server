// src/services/marketing/campaignScheduler.service.ts
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'

/**
 * Scheduler de envío — reclamo con tope global y reparto justo (Fase 1A, Task 6).
 *
 * Mismo patrón que `claimDeliveries` en `src/services/reservation/customerApprovalOutbox.service.ts`
 * (CTE + `FOR UPDATE SKIP LOCKED` + `UPDATE … RETURNING`), endurecido ahí primero: dos workers
 * nunca se llevan la misma fila, y `attempts` se incrementa AL RECLAMAR, no al fallar — si el
 * proceso muere a media entrega, el intento ya está contado y la fila no se reintenta
 * infinitamente.
 *
 * 🔴 Lo que este scheduler agrega sobre el precedente: FAIRNESS. El outbox de aprobación de
 * clientes reclama "lo más viejo primero" sin distinguir venue — aquí eso dejaría a un venue
 * con backlog grande (una campaña navideña de 10,000 clientes) acaparando el lote entero y
 * matando de hambre a los demás negocios que también tienen correos pendientes. El reparto es
 * por RONDAS: se toma como máximo 1 delivery de cada venue por vuelta, hasta agotar `topeGlobal`
 * o el tope local `lotePorVenue` de cada venue — así 3 venues con 100 pendientes cada uno y
 * `topeGlobal: 60` reciben 20 cada uno, no 60 del primero que aparece en el índice.
 */

/**
 * 5 minutos de lease. Igual que el outbox de aprobación (30s) pero más largo: mandar un correo
 * de verdad (llamar a Resend, esperar la respuesta) es más lento que un intento HTTP interno, y
 * un lease demasiado corto reclamaría la MISMA fila dos veces mientras el primer worker sigue
 * esperando al proveedor — el `attempts` subiría sin que el primero haya terminado.
 */
export const LEASE_MS = 5 * 60 * 1000

export type ClaimedDelivery = {
  id: string
  venueId: string
  campaignId: string | null
  customerId: string
  attempts: number
  leaseUntil: Date
  sendAttemptAt: Date
}

type RawClaimedRow = {
  id: string
  venueId: string
  campaignId: string | null
  customerId: string
  attempts: number
  leaseUntil: Date
  sendAttemptAt: Date
}

/**
 * Candidato mínimo para el reparto: sólo `id` y `venueId`. Se asume que `candidatos` ya llega
 * en el orden de antigüedad de CADA venue (más viejo primero DENTRO de un mismo venueId) — es
 * exactamente el orden que produce `ORDER BY "createdAt" ASC, id ASC` en el SQL real.
 */
export type CandidatoReparto = { id: string; venueId: string }

/**
 * 🔴 ESPEJO PURO del CTE de `reclamarLote`, NO el SQL mismo. Existe para poder probar el
 * fairness con datos concretos sin tocar la base (la Mac es compartida con ~20 sesiones y esta
 * suite es unitaria) — pero por ser una segunda implementación de la MISMA regla, si alguien
 * cambia una sin la otra esta prueba deja de significar nada: no hay ningún mecanismo que las
 * mantenga sincronizadas. La verificación de que el SQL real reparte igual que esta función
 * vive en la Task 8 (corrida en vivo contra Postgres), no aquí.
 *
 * El algoritmo es por CAPAS (ronda-robin): en la capa 0 se toma el 1er pendiente de cada venue,
 * en la capa 1 el 2do de cada venue, y así — hasta agotar `topeGlobal` o que ningún venue tenga
 * ya nada en esa capa. Es lo que hace que el corte por `topeGlobal` caiga en un límite de capa
 * COMPLETA cuando los venues están parejos (3×100, tope 60, lote ≥20 ⇒ 20 capas × 3 venues = 60
 * exacto) y siga sirviendo al venue chico primero cuando no lo están (5 y 100, tope 60, lote 50
 * ⇒ el venue de 5 se agota en la capa 4 y el resto del cupo se lo lleva el otro: 5 y 50).
 */
export function repartirEquitativo(candidatos: CandidatoReparto[], topeGlobal: number, lotePorVenue: number): string[] {
  const porVenue = new Map<string, string[]>()
  for (const c of candidatos) {
    let lista = porVenue.get(c.venueId)
    if (!lista) {
      lista = []
      porVenue.set(c.venueId, lista)
    }
    // El tope LOCAL se aplica aquí: un venue nunca contribuye más de `lotePorVenue`
    // candidatos a la ronda, sin importar cuántos pendientes tenga de verdad.
    if (lista.length < lotePorVenue) {
      lista.push(c.id)
    }
  }

  // Mismo desempate que "venueId ASC" en el SQL: determinista, no depende del orden
  // de inserción en el Map ni del orden en que llegó `candidatos`.
  const venues = [...porVenue.keys()].sort()

  const seleccionados: string[] = []
  for (let capa = 0; seleccionados.length < topeGlobal; capa += 1) {
    let huboAvanceEnEstaCapa = false
    for (const venueId of venues) {
      const lista = porVenue.get(venueId) as string[]
      if (capa >= lista.length) continue
      seleccionados.push(lista[capa])
      huboAvanceEnEstaCapa = true
      if (seleccionados.length >= topeGlobal) break
    }
    // Ningún venue tuvo algo que aportar en esta capa: ya se agotaron todos los
    // candidatos disponibles (con sus topes locales), seguir capas no serviría nada.
    if (!huboAvanceEnEstaCapa) break
  }

  return seleccionados
}

export interface ReclamarLoteParams {
  /** Cuántas deliveries se reclaman como máximo en TOTAL, sumando todos los venues. */
  topeGlobal: number
  /** Cuántas deliveries se reclaman como máximo POR VENUE, aunque `topeGlobal` sobre. */
  lotePorVenue: number
  /** Reloj inyectable — para que las pruebas fijen "ahora" sin depender del reloj real. */
  ahora: Date
}

/**
 * Reclama un lote de `CustomerCampaignDelivery` listas para enviarse, con reparto justo entre
 * venues y sin que dos workers se lleven la misma fila.
 *
 * Elegibilidad (ver R2 del brief):
 * - `PENDING` con `nextAttemptAt` nulo o vencido.
 * - `RETRYING` con `nextAttemptAt` vencido.
 * - `SENDING` con `leaseUntil` VENCIDO — el proceso que la reclamó murió a medio envío; sin
 *   esto la fila queda trabada en SENDING para siempre, porque nada más la mueve de ahí.
 * - En cualquier caso, `leaseUntil` nulo o vencido (la condición general de abajo).
 *
 * 🔴 Por qué el `WITH` tiene TRES pasos y no uno: Postgres **no permite combinar una cláusula
 * de bloqueo (`FOR UPDATE`) con funciones de ventana** en el mismo nivel de SELECT — el
 * `ROW_NUMBER() OVER (PARTITION BY …)` necesario para el reparto por venue no puede ir en la
 * MISMA consulta que hace el `FOR UPDATE SKIP LOCKED`. Por eso el bloqueo pasa primero
 * (`eligible`, sin función de ventana) y el `ROW_NUMBER()` se calcula DESPUÉS
 * (`ranked`), sobre filas que ya están bloqueadas — no vuelve a tocar la tabla, sólo enumera lo
 * que ya se trajo.
 */
export async function reclamarLote({ topeGlobal, lotePorVenue, ahora }: ReclamarLoteParams): Promise<ClaimedDelivery[]> {
  if (!Number.isInteger(topeGlobal) || topeGlobal <= 0) {
    throw new Error('topeGlobal debe ser un entero positivo.')
  }
  if (!Number.isInteger(lotePorVenue) || lotePorVenue <= 0) {
    throw new Error('lotePorVenue debe ser un entero positivo.')
  }

  const leaseUntil = new Date(ahora.getTime() + LEASE_MS)
  // 🔴 Las columnas DateTime de este schema son `timestamp without time zone`. Un Date crudo
  // interpolado en el tagged template viaja como timestamptz y se corre en sesiones de DB que
  // no estén en UTC — el mismo patrón (y la misma trampa) que `claimDeliveries` ya resolvió.
  const ahoraSql = Prisma.sql`${ahora.toISOString()}::timestamp`
  const leaseSql = Prisma.sql`${leaseUntil.toISOString()}::timestamp`

  const rows = await prisma.$queryRaw<RawClaimedRow[]>(Prisma.sql`
    WITH eligible AS (
      SELECT d.id, d."venueId", d."createdAt"
      FROM "CustomerCampaignDelivery" AS d
      WHERE (
        (d.status = 'PENDING' AND (d."nextAttemptAt" IS NULL OR d."nextAttemptAt" <= ${ahoraSql}))
        OR (d.status = 'RETRYING' AND d."nextAttemptAt" <= ${ahoraSql})
        OR d.status = 'SENDING'
      )
      AND (d."leaseUntil" IS NULL OR d."leaseUntil" <= ${ahoraSql})
      FOR UPDATE SKIP LOCKED
    ),
    ranked AS (
      -- Numera cada delivery DENTRO de su propio venue por antigüedad — el número 1 es
      -- la más vieja de ESE venue, no de todo el backlog. Es lo que separa el reparto
      -- justo de "el que llegó primero se lleva todo el lote".
      SELECT id, "venueId", "createdAt",
        ROW_NUMBER() OVER (PARTITION BY "venueId" ORDER BY "createdAt" ASC, id ASC) AS rn
      FROM eligible
    ),
    selected AS (
      -- Tope LOCAL primero (rn <= lotePorVenue): un venue nunca contribuye más de su
      -- cupo, sin importar cuánto backlog tenga. Después, ORDER BY rn ASC intercala por
      -- CAPAS entre venues (rn=1 de todos antes que rn=2 de cualquiera), así que el corte
      -- por topeGlobal cae en un límite de capa completa cuando los venues están parejos —
      -- es lo que da 20/20/20 con 3 venues de 100 y topeGlobal 60. "venueId" ASC desempata
      -- DENTRO de una misma capa, determinista.
      SELECT id
      FROM ranked
      WHERE rn <= ${lotePorVenue}
      ORDER BY rn ASC, "venueId" ASC
      LIMIT ${topeGlobal}
    )
    UPDATE "CustomerCampaignDelivery" AS d
    SET
      status = 'SENDING',
      "leaseUntil" = ${leaseSql},
      attempts = d.attempts + 1,
      "updatedAt" = CURRENT_TIMESTAMP,
      -- 🔴 COALESCE obligatorio: sendAttemptAt se escribe UNA sola vez, en el PRIMER
      -- intento. Es el ancla inmutable de la vigencia del cupon y de la cuota mensual (lo
      -- dice el propio comentario del modelo en schema.prisma) -- si un retry la moviera,
      -- cada reintento correria el reloj de vigencia del cupon hacia adelante, y una
      -- campana que reintenta mucho terminaria con cupones "mas frescos" que una que salio
      -- a la primera. El sendAttemptAt YA GUARDADO siempre gana sobre el "ahora" de este
      -- intento cuando no es null.
      "sendAttemptAt" = COALESCE(d."sendAttemptAt", ${ahoraSql})
    FROM selected
    WHERE d.id = selected.id
    RETURNING d.id, d."venueId", d."campaignId", d."customerId", d.attempts, d."leaseUntil", d."sendAttemptAt"
  `)

  return rows.map(r => ({
    id: r.id,
    venueId: r.venueId,
    campaignId: r.campaignId,
    customerId: r.customerId,
    attempts: r.attempts,
    leaseUntil: r.leaseUntil,
    sendAttemptAt: r.sendAttemptAt,
  }))
}
