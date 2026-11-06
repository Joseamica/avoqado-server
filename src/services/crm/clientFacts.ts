/**
 * The facts «Clientes» shows of each organization — what it uses (terminal, POS), its plan level and whether it charges —
 * each from ONE SQL expression over an Organization aliased `o` (plan C1, task 2). The cell reads these columns, the
 * filter puts the same expressions in the `WHERE` before the cursor and in the total, and the count groups by them: one
 * rule to paint, filter and count. The plan's CONDITION (paid, trial, courtesy…) is not here on purpose: its rule
 * (`elegirFilaDelPlan`) only exists in JS and is computed for the rows of the page (redesign after Codex r3).
 *
 * Every question is an `EXISTS` over the organization's REAL venues (`REAL_VENUE_SQL`) that stops at its first row by an
 * index. Enum values travel as SQL literals, never as text binds (`"OrderSource" = text` fails in Postgres); dates as
 * `utcTs`. Never `Order.terminalId` nor `lastHeartbeat`: what proves a device is how the sale was charged.
 */
import { Prisma } from '@prisma/client'
import { utcTs } from '../../utils/sqlDates'
import { REAL_VENUE_SQL, VENUE_HAS_MONEY_SQL } from './sweep.service'

export const USA = ['AMBOS', 'TERMINAL', 'POS', 'NO_IDENTIFICADO', 'NINGUNO'] as const
export type Usa = (typeof USA)[number]
/** What a person may write by hand (✋); «Leerlo solo» clears it. */
export const USA_ESCRITO = ['AMBOS', 'TERMINAL', 'POS'] as const
export type UsaEscrito = (typeof USA_ESCRITO)[number]
/** ENTERPRISE has no code in the database (`basePlan.service.ts`), so it is never a level here. */
export const NIVELES = ['FREE', 'PRO', 'PREMIUM'] as const
export type Nivel = (typeof NIVELES)[number]
export const CONDICIONES = ['PAGADO', 'CAMPANA', 'PRUEBA_CON_TARJETA', 'PRUEBA_SIN_TARJETA', 'CORTESIA', 'DE_ANTES', 'GRATIS'] as const
export type Condicion = (typeof CONDICIONES)[number]
export const ESTADOS = ['ALTA_SIN_TARJETA', 'COBRA', 'SIN_COBROS', 'NUNCA'] as const
export type Estado = (typeof ESTADOS)[number]
export const MOTIVOS_DEL_ALTA = ['PRECIO', 'NO_QUISO_TARJETA', 'SOLO_VEIA', 'OTRO_SISTEMA', 'PROBLEMA_TECNICO', 'DESPUES', 'OTRO'] as const
export type MotivoDelAlta = (typeof MOTIVOS_DEL_ALTA)[number]

/** The window of «Usa» and «Cobra»: the last 30 × 24 h, moving (not a calendar month), inclusive. */
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000

/** A SQL alias written into the text: only a plain identifier, so a caller can never inject through it. */
function alias(name: string): Prisma.Sql {
  if (!/^[a-z_][a-z0-9_]*$/i.test(name)) throw new Error(`Alias SQL inválido: ${name}`)
  return Prisma.raw(name)
}

/**
 * Does this `VenueFeature` row (aliased `rowAlias`) give access today? `ventanaDeAccesoWhere` of
 * `access/ventanaDeAcceso.ts` written in SQL, field by field — its parity test against `daAcceso` fails if the canonical
 * rule changes and this copy does not. Always true or false, never NULL (a missing grace is «no grace»), so it can be
 * selected or negated.
 */
export function ventanaDeAccesoSql(rowAlias: string, now: Date): Prisma.Sql {
  const r = alias(rowAlias)
  return Prisma.sql`(${r}."active" = true AND ${r}."suspendedAt" IS NULL
    AND (${r}."endDate" IS NULL OR ${r}."endDate" >= ${utcTs(now)} OR (${r}."gracePeriodEndsAt" IS NOT NULL AND ${r}."gracePeriodEndsAt" >= ${utcTs(now)})))`
}

/**
 * Does the venue aliased `venueAlias` hold a commercial grant of `tier` in force? The `where` of `getContractBaseTier`
 * (`access/basePlan.service.ts`) in SQL: a live `CapabilityGrant` of the venue whose `HybridContract` is of the same venue,
 * not ended, and of that `planTier`. Stops at the first row on `CapabilityGrant(venueId, featureCode, revokedAt, endsAt)`.
 * Its parity test against the canonical one fails if that rule changes and this copy does not.
 */
export function concesionComercialSql(venueAlias: string, now: Date, tier: 'PRO' | 'PREMIUM'): Prisma.Sql {
  const v = alias(venueAlias)
  const planTier = tier === 'PREMIUM' ? Prisma.sql`'PREMIUM'` : Prisma.sql`'PRO'`
  return Prisma.sql`EXISTS (
    SELECT 1 FROM "CapabilityGrant" cg JOIN "HybridContract" hc ON hc."id" = cg."contractId"
    WHERE cg."venueId" = ${v}."id" AND cg."revokedAt" IS NULL
      AND cg."startsAt" <= ${utcTs(now)} AND cg."endsAt" > ${utcTs(now)}
      AND hc."venueId" = ${v}."id" AND hc."endedAt" IS NULL AND hc."planTier" = ${planTier}
  )`
}

/**
 * 🟠 «Se quedó en el alta, no puso tarjeta» over `o` (spec §5.1.4): it has an `OnboardingProgress`, its signup did not
 * finish (`Organization.onboardingCompletedAt` or `OnboardingProgress.completedAt` empty), it never charged real money in
 * a real venue, and none of its venues has a Stripe subscription on a feature row nor a contract not ended. A card given
 * anywhere means it is not this case. No `now`: it does not depend on the date.
 */
export function altaPendienteSql(): Prisma.Sql {
  return Prisma.sql`(
    EXISTS (
      SELECT 1 FROM "OnboardingProgress" op
      WHERE op."organizationId" = o."id" AND (o."onboardingCompletedAt" IS NULL OR op."completedAt" IS NULL)
    )
    AND NOT EXISTS (SELECT 1 FROM "Venue" v WHERE v."organizationId" = o."id" AND ${REAL_VENUE_SQL} AND ${VENUE_HAS_MONEY_SQL})
    AND NOT EXISTS (
      SELECT 1 FROM "Venue" v JOIN "VenueFeature" vf ON vf."venueId" = v."id"
      WHERE v."organizationId" = o."id" AND vf."stripeSubscriptionId" IS NOT NULL
    )
    AND NOT EXISTS (
      SELECT 1 FROM "Venue" v JOIN "HybridContract" hc ON hc."venueId" = v."id"
      WHERE v."organizationId" = o."id" AND hc."endedAt" IS NULL
    )
  )`
}

/**
 * An «alta propia» that stopped at the plan screen, over `o`: `altaPendienteSql`, its `OnboardingProgress` carries an
 * `acquisitionSource` (only the self-service signup and the landing write it) and it has at least one real venue (the
 * business is created at «tipo de negocio», right before the plan screen). Organizations made by hand or signups that
 * never got past the email code do not match. Does NOT exclude the team's organization: the caller does.
 */
export function altaPropiaPendienteSql(): Prisma.Sql {
  return Prisma.sql`(
    ${altaPendienteSql()}
    AND EXISTS (SELECT 1 FROM "OnboardingProgress" op WHERE op."organizationId" = o."id" AND op."acquisitionSource" IS NOT NULL)
    AND EXISTS (SELECT 1 FROM "Venue" v WHERE v."organizationId" = o."id" AND ${REAL_VENUE_SQL})
  )`
}

/** An order of the venue `v` charged (fully or partly) in the window, of the given sources (SQL literals). */
const paidOrder = (sources: Prisma.Sql, desde: Date, extra: Prisma.Sql = Prisma.empty) => Prisma.sql`EXISTS (
  SELECT 1 FROM "Order" o2
  WHERE o2."venueId" = v."id" AND o2."source" IN (${sources}) AND o2."createdAt" >= ${utcTs(desde)}
    AND o2."paymentStatus" IN ('PAID', 'PARTIAL')${extra}
)`

/**
 * A reservation's order is born `TPV` at check-in wherever it is charged (`createOrderFromReservation.ts`): its source
 * proves nothing. The `Payment.source` of its charge does (`TPV` = the terminal, `APP` = the POS apps); any other source
 * does not say the device. Asked LAST in each `OR`, so it only runs when nothing cheaper answered.
 */
const reservationChargedFrom = (paymentSource: Prisma.Sql, desde: Date) => Prisma.sql`EXISTS (
  SELECT 1 FROM "Order" o2 JOIN "Payment" p ON p."orderId" = o2."id"
  WHERE o2."venueId" = v."id" AND o2."source" = 'TPV' AND o2."reservationId" IS NOT NULL
    AND o2."createdAt" >= ${utcTs(desde)} AND o2."paymentStatus" IN ('PAID', 'PARTIAL')
    AND p."status" = 'COMPLETED' AND p."amount" > 0 AND p."source" = ${paymentSource}
)`

/** Some real venue of `o` answers `condition` (over `v`). */
const anyRealVenue = (condition: Prisma.Sql) =>
  Prisma.sql`EXISTS (SELECT 1 FROM "Venue" v WHERE v."organizationId" = o."id" AND ${REAL_VENUE_SQL} AND (${condition}))`

/** A real venue of `o` holds `tier` today: a classic row in its access window, or a commercial grant in force. */
const nivelSql = (tier: 'PRO' | 'PREMIUM', now: Date) =>
  anyRealVenue(Prisma.sql`EXISTS (
      SELECT 1 FROM "VenueFeature" vf JOIN "Feature" ft ON ft."id" = vf."featureId"
      WHERE vf."venueId" = v."id" AND ft."code" = ${tier === 'PREMIUM' ? Prisma.sql`'PLAN_PREMIUM'` : Prisma.sql`'PLAN_PRO'`}
        AND ${ventanaDeAccesoSql('vf', now)}
    )
    OR ${concesionComercialSql('v', now, tier)}`)

/**
 * `LEFT JOIN LATERAL (…) f ON true` over `o`, with exactly: `f."usaTerminal"`, `f."usaPos"` (booleans), `f."ultimoCobroAt"`
 * (the newest real charge of its real venues, or null), `f."usaMedido"` (`USA`), `f."nivel"` (`NIVELES`) and `f."estado"`
 * (`ESTADOS`). The same `now` for every expression of a request.
 *
 * - Terminal: a `TPV` order without reservation charged in the window; or a real charge processed on a `TPV_ANDROID` /
 *   `TPV_IOS` device (`Payment.terminalId`), asked after the order so a TPV order answers without reading `Payment`; or a
 *   reservation charged from the terminal. POS: an `AVOQADO_ANDROID` / `AVOQADO_IOS` order (Windows sends ANDROID), or a
 *   reservation charged from the apps. Charged without a device to blame: `NO_IDENTIFICADO`, never «sin ventas».
 * - Level: the `tier` of `getVenuePlanInfo` per venue (PREMIUM before PRO), the highest of its real venues.
 * - Estado: 🟠 `altaPendienteSql`, then a charge in the window, then a charge ever, then never.
 */
export function clientFactsLateral(now: Date): Prisma.Sql {
  const desde = new Date(now.getTime() - WINDOW_MS)
  const terminal = anyRealVenue(Prisma.sql`${paidOrder(Prisma.sql`'TPV'`, desde, Prisma.sql` AND o2."reservationId" IS NULL`)}
    OR EXISTS (
      SELECT 1 FROM "Payment" p JOIN "Terminal" t ON t."id" = p."terminalId" AND t."type" IN ('TPV_ANDROID', 'TPV_IOS')
      WHERE p."venueId" = v."id" AND p."status" = 'COMPLETED' AND p."amount" > 0 AND p."createdAt" >= ${utcTs(desde)}
    )
    OR ${reservationChargedFrom(Prisma.sql`'TPV'`, desde)}`)
  const pos = anyRealVenue(Prisma.sql`${paidOrder(Prisma.sql`'AVOQADO_ANDROID', 'AVOQADO_IOS'`, desde)}
    OR ${reservationChargedFrom(Prisma.sql`'APP'`, desde)}`)
  const inWindow = Prisma.sql`x."ultimoCobroAt" >= ${utcTs(desde)}`

  // ponytail: se calcula al leer; si a 10× (≈260 clientes) la lista pasa de ~300 ms, estas columnas pasan a una fila por
  // organización que llena `runSweep` cada 5 min y la lista filtra por columnas (spec §5.1.6).
  return Prisma.sql`LEFT JOIN LATERAL (
    SELECT x."usaTerminal", x."usaPos", x."ultimoCobroAt",
      CASE WHEN x."usaTerminal" AND x."usaPos" THEN 'AMBOS'
           WHEN x."usaTerminal" THEN 'TERMINAL'
           WHEN x."usaPos" THEN 'POS'
           WHEN ${inWindow} THEN 'NO_IDENTIFICADO'
           ELSE 'NINGUNO' END AS "usaMedido",
      x."nivel",
      CASE WHEN ${altaPendienteSql()} THEN 'ALTA_SIN_TARJETA'
           WHEN ${inWindow} THEN 'COBRA'
           WHEN x."ultimoCobroAt" IS NOT NULL THEN 'SIN_COBROS'
           ELSE 'NUNCA' END AS "estado"
    FROM (
      SELECT ${terminal} AS "usaTerminal", ${pos} AS "usaPos",
        (
          SELECT MAX(lc."createdAt") FROM "Venue" v
          CROSS JOIN LATERAL (
            SELECT p."createdAt" FROM "Payment" p
            WHERE p."venueId" = v."id" AND p."status" = 'COMPLETED' AND p."amount" > 0
            ORDER BY p."createdAt" DESC LIMIT 1
          ) lc
          WHERE v."organizationId" = o."id" AND ${REAL_VENUE_SQL}
        ) AS "ultimoCobroAt",
        CASE WHEN ${nivelSql('PREMIUM', now)} THEN 'PREMIUM' WHEN ${nivelSql('PRO', now)} THEN 'PRO' ELSE 'FREE' END AS "nivel"
    ) x
  ) f ON true`
}
