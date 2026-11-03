import { Prisma, type SaleVerificationStatus } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { BadRequestError } from '../../errors/AppError'
import { utcTs } from '../../utils/sqlDates'

// «Repetido» (spec §5.2): otro número igual en la MISMA organización, en otra venta (cualquier estado, vinculación o
// portado) o en el histórico con un ICCID distinto. findDuplicatesForSales y findVerificationIdsWithNumberAlert dan la
// misma respuesta sí/no para cada venta guardada: las dos cuentan llaves 'sv:'||id y 'h:'||iccid por número.

export type NumberMatch =
  | { kind: 'SALE'; verificationId: string; status: SaleVerificationStatus; date: Date; staffName: string; venueName: string }
  | { kind: 'HISTORICAL'; date: Date | null }
/** `total` = todas las otras llaves con el número; `matches` = las 3 más recientes. */
export interface NumberMatchSummary {
  total: number
  matches: NumberMatch[]
}
/**
 * Una venta de la página. `iccid` = `serialNumbers[0]`. Con `verificationId`, los números son los guardados en ella:
 * su propia fila se descuenta del total aunque no salga entre las traídas.
 */
export interface SaleNumbers {
  key: string
  verificationId: string | null
  iccid: string | null
  linkingNumber: string | null
  portedNumber: string | null
}
export const NUMBER_ALERT_FILTERS = ['any', 'duplicate', 'missing', 'not10'] as const
export type NumberAlertFilter = (typeof NUMBER_ALERT_FILTERS)[number]

type MatchRow = {
  n: string
  k: string
  total: bigint | number
  d: Date | null
  sv_id: string | null
  status: SaleVerificationStatus | null
  first_name: string | null
  last_name: string | null
  venue_name: string | null
}

const SHOWN = 3
const ALERT_IDS_CAP = 20000

/** Por `sale.key`: `linking`/`ported` sólo vienen cuando ese número está repetido. Dos consultas para toda la página. */
export async function findDuplicatesForSales(
  orgId: string,
  input: SaleNumbers[],
): Promise<Map<string, { linking?: NumberMatchSummary; ported?: NumberMatchSummary }>> {
  // El histórico guarda el ICCID con trim + mayúsculas (`normalizeIccid`); la captura de la venta no: «…901f» es «…901F».
  const sales = input.map(s => ({ ...s, iccid: s.iccid?.trim().toUpperCase() || null }))
  const out = new Map<string, { linking?: NumberMatchSummary; ported?: NumberMatchSummary }>()
  for (const s of sales) out.set(s.key, {})
  const numbersOf = (s: SaleNumbers) => [s.linkingNumber, s.portedNumber].filter((n): n is string => !!n)
  const nums = Array.from(new Set(sales.flatMap(numbersOf)))
  if (nums.length === 0) return out
  const ownPairs = sales.flatMap(s => (s.iccid ? numbersOf(s).map(number => ({ iccid: s.iccid as string, number })) : []))

  const [rows, own] = await Promise.all([
    // Una fila por (número, llave): UNION junta la misma venta si tiene el número en los dos campos. Las 5 más
    // recientes por número (la propia venta y el histórico de su ICCID son como mucho 2: quedan 3 que mostrar) y el
    // total exacto; un histórico sin fecha va al final (NULLS LAST), nunca tapa a una venta fechada.
    prisma.$queryRaw<MatchRow[]>(Prisma.sql`
      WITH cand AS (
        SELECT sv."linkingNumber" AS n, 'sv:' || sv.id AS k, p."createdAt" AS d, sv.id AS sv_id, sv.status,
               st."firstName" AS first_name, st."lastName" AS last_name, v.name AS venue_name
        FROM "SaleVerification" sv
        JOIN "Venue" v ON v.id = sv."venueId"
        JOIN "Payment" p ON p.id = sv."paymentId"
        JOIN "Staff" st ON st.id = sv."staffId"
        WHERE v."organizationId" = ${orgId} AND sv."linkingNumber" = ANY(${nums}::text[])
        UNION
        SELECT sv."portedNumber", 'sv:' || sv.id, p."createdAt", sv.id, sv.status, st."firstName", st."lastName", v.name
        FROM "SaleVerification" sv
        JOIN "Venue" v ON v.id = sv."venueId"
        JOIN "Payment" p ON p.id = sv."paymentId"
        JOIN "Staff" st ON st.id = sv."staffId"
        WHERE v."organizationId" = ${orgId} AND sv."portedNumber" = ANY(${nums}::text[])
        UNION
        SELECT h.number, 'h:' || h.iccid, h."saleDate", NULL, NULL, NULL, NULL, NULL
        FROM "HistoricalLinkingNumber" h
        WHERE h."organizationId" = ${orgId} AND h.number = ANY(${nums}::text[])
      ),
      ranked AS (
        SELECT cand.*, count(*) OVER (PARTITION BY n) AS total,
               row_number() OVER (PARTITION BY n ORDER BY d DESC NULLS LAST, k DESC) AS rn
        FROM cand
      )
      SELECT n, k, total, d, sv_id, status, first_name, last_name, venue_name
      FROM ranked WHERE rn <= 5 ORDER BY n, rn`),
    // ¿Cada venta tiene en el histórico su propio ICCID con ese número? (no es repetido; se descuenta del total)
    ownPairs.length
      ? prisma.historicalLinkingNumber.findMany({
          where: { organizationId: orgId, OR: ownPairs },
          select: { iccid: true, number: true },
          take: ownPairs.length, // (organizationId, iccid, number) es única: una fila por par como mucho
        })
      : Promise.resolve([] as Array<{ iccid: string; number: string }>),
  ])

  const byNumber = new Map<string, MatchRow[]>()
  for (const r of rows) {
    const list = byNumber.get(r.n)
    if (list) list.push(r)
    else byNumber.set(r.n, [r])
  }
  const ownSet = new Set(own.map(h => `${h.iccid}\u0000${h.number}`))

  const summarize = (s: SaleNumbers, n: string | null): NumberMatchSummary | undefined => {
    if (!n) return undefined
    const found = byNumber.get(n) ?? []
    const total = found.length ? Number(found[0].total) : 0
    const selfKey = s.verificationId ? `sv:${s.verificationId}` : null
    const ownKey = s.iccid ? `h:${s.iccid}` : null
    // Si hay más llaves que filas traídas, ella está entre las que no salieron (n es uno de sus números guardados).
    const selfIn = !!selfKey && (found.some(r => r.k === selfKey) || total > found.length)
    const ownIn = !!s.iccid && ownSet.has(`${s.iccid}\u0000${n}`)
    const others = total - (selfIn ? 1 : 0) - (ownIn ? 1 : 0)
    if (others <= 0) return undefined
    const matches = found
      .filter(r => r.k !== selfKey && r.k !== ownKey)
      .slice(0, SHOWN)
      .map(
        (r): NumberMatch =>
          r.sv_id
            ? {
                kind: 'SALE',
                verificationId: r.sv_id,
                status: r.status as SaleVerificationStatus,
                date: r.d as Date,
                staffName: `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim(),
                venueName: r.venue_name ?? '',
              }
            : { kind: 'HISTORICAL', date: r.d },
      )
    return { total: others, matches }
  }

  for (const s of sales) {
    const entry: { linking?: NumberMatchSummary; ported?: NumberMatchSummary } = {}
    const linking = summarize(s, s.linkingNumber)
    const ported = summarize(s, s.portedNumber)
    if (linking) entry.linking = linking
    if (ported) entry.ported = ported
    out.set(s.key, entry)
  }
  return out
}

/** ¿`number` ya está en otra venta de la organización (o en el histórico con otro ICCID)? `self` no cuenta. */
export async function isNumberDuplicate(
  orgId: string,
  number: string,
  self: { verificationId?: string; iccid?: string },
): Promise<boolean> {
  const key = 'self'
  const res = await findDuplicatesForSales(orgId, [
    { key, verificationId: self.verificationId ?? null, iccid: self.iccid ?? null, linkingNumber: number, portedNumber: null },
  ])
  return !!res.get(key)?.linking
}

// Las alertas del filtro deben salir iguales que en la fila (computeNumberAlerts + findDuplicatesForSales).
// photos[1] y photos[2] de Postgres son photos[0] y photos[1] de JS.
const DUPLICATE = Prisma.sql`("linkingNumber" IN (SELECT n FROM dup) OR "portedNumber" IN (SELECT n FROM dup))`
const NOT_10 = Prisma.sql`((length("linkingNumber") = 9 AND coalesce("linkingNumberSource"::text, '') <> 'BACKOFFICE')
  OR (length("portedNumber") = 9 AND coalesce("portedNumberSource"::text, '') <> 'BACKOFFICE'))`
const MISSING = Prisma.sql`(("linkingNumber" IS NULL AND (coalesce(photos[1], '') <> '' OR order_type = 'MANUAL_ENTRY'))
  OR ("isPortabilidad" AND "portedNumber" IS NULL AND (coalesce(photos[2], '') <> '' OR order_type = 'MANUAL_ENTRY')))`
const ALERT_PREDICATES: Record<NumberAlertFilter, Prisma.Sql> = {
  duplicate: DUPLICATE,
  not10: NOT_10,
  missing: MISSING,
  any: Prisma.sql`(${DUPLICATE} OR ${NOT_10} OR ${MISSING})`,
}

/** Ids de las verificaciones de la organización con esa alerta, cobradas dentro del rango (los mismos extremos que la lista). */
export async function findVerificationIdsWithNumberAlert(
  orgId: string,
  kind: NumberAlertFilter,
  range: { from: Date; to: Date },
): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    WITH org_sv AS (
      SELECT sv.id, sv."linkingNumber", sv."portedNumber", upper(btrim(sv."serialNumbers"[1])) AS iccid, sv.photos, sv."isPortabilidad",
             sv."linkingNumberSource", sv."portedNumberSource", o.type AS order_type, p."createdAt" AS paid_at
      FROM "SaleVerification" sv
      JOIN "Venue" v ON v.id = sv."venueId"
      JOIN "Payment" p ON p.id = sv."paymentId"
      LEFT JOIN "Order" o ON o.id = p."orderId"
      WHERE v."organizationId" = ${orgId}
    ),
    nums AS (
      SELECT "linkingNumber" AS n, 'sv:' || id AS k FROM org_sv WHERE "linkingNumber" IS NOT NULL
      UNION ALL SELECT "portedNumber", 'sv:' || id FROM org_sv WHERE "portedNumber" IS NOT NULL
      UNION ALL SELECT h.number, 'h:' || h.iccid FROM "HistoricalLinkingNumber" h
        WHERE h."organizationId" = ${orgId}
          AND NOT EXISTS (SELECT 1 FROM org_sv s WHERE s.iccid = h.iccid AND (s."linkingNumber" = h.number OR s."portedNumber" = h.number))
    ),
    dup AS (SELECT n FROM nums GROUP BY n HAVING count(DISTINCT k) > 1)
    SELECT id FROM org_sv
    WHERE paid_at >= ${utcTs(range.from)} AND paid_at <= ${utcTs(range.to)} AND ${ALERT_PREDICATES[kind]}
    LIMIT ${ALERT_IDS_CAP + 1}`) // la fila de más dice que el rango es demasiado ancho
  if (rows.length > ALERT_IDS_CAP) {
    throw new BadRequestError('Hay demasiadas ventas con alerta en el rango; acota las fechas', 'NUMBER_ALERT_RANGE_TOO_WIDE')
  }
  return rows.map(r => r.id)
}
