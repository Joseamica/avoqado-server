/**
 * Reporte de posiciones de cobro — tarifa al comercio, paso 2 (12-nov-2026). SÓLO LECTURA: ninguna escritura.
 * Promesa: `docs/audit/2026-11-12-tarifa-por-cuenta/promesa-pasos-1-y-2.md` del workspace.
 *
 * Por negocio y posición: la cuenta efectiva (propia o de su organización, como `getEffectivePaymentConfig`), la tarifa
 * vigente (del negocio o, de respaldo, de la organización, como `getEffectivePricingForSlot`) y las terminales de cobro que
 * heredan las posiciones. Marca lo raro, sin corregir nada:
 *   - TARIFA_ANTERIOR_A_LA_CUENTA: la tarifa vigente empezó (más de 10 min) antes de que existiera la cuenta (posible herencia; no hay
 *     historial de quién ocupó la posición, así que es una sospecha, no una prueba);
 *   - SIN_CUENTA_CON_TARIFA: la tarifa espera a la próxima cuenta que llegue a esa posición;
 *   - CUENTA_SIN_TARIFA;
 *   - TERMINALES_DE_OTRO_PROCESADOR: terminales que heredan una cuenta que su marca no puede usar.
 * El filtro por marca va en la base, antes de paginar.
 * ponytail: recorre todos los negocios que pasan el filtro en cada petición (índices por negocio y posición); si el número
 * de negocios crece 100×, materializar las marcas en una tabla que se refresque.
 */
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import { utcTs } from '@/utils/sqlDates'
import { PROVIDER_DEVICE_COMPATIBILITY } from '@/lib/providerDeviceCompatibility'
import { TIPOS_DE_TERMINAL_DE_COBRO } from '@/services/shared/candadoDePosiciones'

export const MARCAS_DE_POSICION = [
  'TARIFA_ANTERIOR_A_LA_CUENTA',
  'SIN_CUENTA_CON_TARIFA',
  'CUENTA_SIN_TARIFA',
  'TERMINALES_DE_OTRO_PROCESADOR',
] as const
export type MarcaDePosicion = (typeof MARCAS_DE_POSICION)[number]

export const reportePosicionesQuerySchema = z.object({
  page: z.coerce.number({ invalid_type_error: 'Página inválida' }).int().min(1, 'La página empieza en 1').default(1),
  pageSize: z.coerce
    .number({ invalid_type_error: 'Tamaño de página inválido' })
    .int()
    .min(1, 'Pide al menos un negocio')
    .default(50)
    .transform(n => Math.min(n, 100)),
  search: z.string().trim().max(100, 'Búsqueda demasiado larga').optional(),
  organizationId: z.string().trim().min(1).optional(),
  flag: z.enum([...MARCAS_DE_POSICION, 'CON_MARCAS'], { errorMap: () => ({ message: 'Marca inválida' }) }).optional(),
})
export type ReportePosicionesQuery = z.infer<typeof reportePosicionesQuerySchema>

type Fila = {
  total: number
  conteoTarifaAnterior: number
  conteoSinCuentaConTarifa: number
  conteoCuentaSinTarifa: number
  conteoOtroProcesador: number
  venueId: string | null
  venueName: string | null
  venueSlug: string | null
  venueStatus: string | null
  organizationId: string | null
  organizationName: string | null
  accountsSource: 'venue' | 'organization' | null
  slot: 'PRIMARY' | 'SECONDARY' | 'TERTIARY' | null
  accountId: string | null
  accountName: string | null
  accountActive: boolean | null
  accountCreatedAt: Date | null
  providerCode: string | null
  pricingId: string | null
  pricingSource: 'venue' | 'organization' | null
  pricingFrom: Date | null
  debitRate: Prisma.Decimal | null
  creditRate: Prisma.Decimal | null
  amexRate: Prisma.Decimal | null
  internationalRate: Prisma.Decimal | null
  includesTax: boolean | null
  fixedFeePerTransaction: Prisma.Decimal | null
  inheritingTerminals: number
  otherProcessorTerminals: number
  f1: boolean
  f2: boolean
  f3: boolean
  f4: boolean
}

const num = (d: Prisma.Decimal | null) => (d === null ? null : Number(d))

/**
 * Una tarifa capturada en el MISMO alta que la cuenta (asistentes AngelPay/Blumon, KYC) puede empezar unos instantes ANTES de
 * que exista la cuenta: la fecha la pone el navegador o un paso anterior (medido ~100 ms en el full-testing del 13-nov). Sólo
 * se marca «tarifa anterior a la cuenta» si empezó más de estos minutos antes.
 */
export const TOLERANCIA_MINUTOS = 10

export async function reporteDePosiciones(q: ReportePosicionesQuery) {
  const ahora = utcTs(new Date())
  const filtros: Prisma.Sql[] = [Prisma.sql`TRUE`]
  if (q.search) {
    const patron = `%${q.search.replace(/[\\%_]/g, m => `\\${m}`)}%`
    filtros.push(Prisma.sql`(v.name ILIKE ${patron} OR v.slug ILIKE ${patron} OR o.name ILIKE ${patron})`)
  }
  if (q.organizationId) filtros.push(Prisma.sql`v."organizationId" = ${q.organizationId}`)
  const filtroMarca =
    q.flag === 'TARIFA_ANTERIOR_A_LA_CUENTA'
      ? Prisma.sql`n.f1`
      : q.flag === 'SIN_CUENTA_CON_TARIFA'
        ? Prisma.sql`n.f2`
        : q.flag === 'CUENTA_SIN_TARIFA'
          ? Prisma.sql`n.f3`
          : q.flag === 'TERMINALES_DE_OTRO_PROCESADOR'
            ? Prisma.sql`n.f4`
            : q.flag === 'CON_MARCAS'
              ? Prisma.sql`(n.f1 OR n.f2 OR n.f3 OR n.f4)`
              : Prisma.sql`TRUE`
  const compat = Object.entries(PROVIDER_DEVICE_COMPATIBILITY).flatMap(([p, marcas]) => marcas.map(m => Prisma.sql`(${p}, ${m})`))
  const proveedoresConCatalogo = Object.keys(PROVIDER_DEVICE_COMPATIBILITY)
  const tipos = Prisma.join([...TIPOS_DE_TERMINAL_DE_COBRO].map(t => Prisma.sql`${t}`))
  const take = q.pageSize
  const skip = (q.page - 1) * q.pageSize

  const filas = await prisma.$queryRaw<Fila[]>`
    WITH base AS (
      SELECT v.id, v.name, v.slug, v.status::text AS status, v."organizationId", o.name AS "organizationName",
        CASE WHEN vpc.id IS NOT NULL THEN 'venue' WHEN opc.id IS NOT NULL THEN 'organization' END AS "accountsSource",
        CASE WHEN vpc.id IS NOT NULL THEN vpc."primaryAccountId" ELSE opc."primaryAccountId" END AS a1,
        CASE WHEN vpc.id IS NOT NULL THEN vpc."secondaryAccountId" ELSE opc."secondaryAccountId" END AS a2,
        CASE WHEN vpc.id IS NOT NULL THEN vpc."tertiaryAccountId" ELSE opc."tertiaryAccountId" END AS a3
      FROM "Venue" v
      JOIN "Organization" o ON o.id = v."organizationId"
      LEFT JOIN "VenuePaymentConfig" vpc ON vpc."venueId" = v.id
      LEFT JOIN "OrganizationPaymentConfig" opc ON opc."organizationId" = v."organizationId"
      WHERE ${Prisma.join(filtros, ' AND ')}
    ),
    compat (provider, marca) AS (VALUES ${Prisma.join(compat)}),
    term AS (
      SELECT t."venueId", NULLIF(upper(trim(t.brand)), '') AS marca, count(*)::int AS n
      FROM "Terminal" t JOIN base b ON b.id = t."venueId"
      WHERE cardinality(t."assignedMerchantIds") = 0 AND t.status::text <> 'RETIRED' AND t.type::text IN (${tipos})
      GROUP BY 1, 2
    ),
    pos AS (
      SELECT b.id AS "venueId", b."organizationId", x.slot, x.ord, x.cuenta
      FROM base b CROSS JOIN LATERAL (VALUES ('PRIMARY', 1, b.a1), ('SECONDARY', 2, b.a2), ('TERTIARY', 3, b.a3)) AS x(slot, ord, cuenta)
    ),
    det AS (
      SELECT p."venueId", p.slot, p.ord, p.cuenta AS "accountId",
        COALESCE(ma."displayName", ma.alias, ma."externalMerchantId") AS "accountName",
        ma.active AS "accountActive", ma."createdAt" AS "accountCreatedAt", pp.code AS "providerCode",
        tar.id AS "pricingId", tar.fuente AS "pricingSource", tar."effectiveFrom" AS "pricingFrom",
        tar."debitRate", tar."creditRate", tar."amexRate", tar."internationalRate", tar."includesTax", tar."fixedFeePerTransaction",
        COALESCE((SELECT sum(term.n) FROM term WHERE term."venueId" = p."venueId"), 0)::int AS "inheritingTerminals",
        COALESCE((
          SELECT sum(term.n) FROM term
          WHERE term."venueId" = p."venueId" AND term.marca IS NOT NULL
            AND pp.code IN (${Prisma.join(proveedoresConCatalogo)})
            AND NOT EXISTS (SELECT 1 FROM compat c WHERE c.provider = pp.code AND c.marca = term.marca)
        ), 0)::int AS "otherProcessorTerminals"
      FROM pos p
      LEFT JOIN "MerchantAccount" ma ON ma.id = p.cuenta
      LEFT JOIN "PaymentProvider" pp ON pp.id = ma."providerId"
      LEFT JOIN LATERAL (
        SELECT u.* FROM (
          (SELECT vps.id, 'venue'::text AS fuente, vps."effectiveFrom", vps."debitRate", vps."creditRate", vps."amexRate",
             vps."internationalRate", vps."includesTax", vps."fixedFeePerTransaction", 1 AS prio
           FROM "VenuePricingStructure" vps
           WHERE vps."venueId" = p."venueId" AND vps."accountType"::text = p.slot AND vps.active
             AND vps."effectiveFrom" <= ${ahora} AND (vps."effectiveTo" IS NULL OR vps."effectiveTo" >= ${ahora})
           ORDER BY vps."effectiveFrom" DESC LIMIT 1)
          UNION ALL
          (SELECT ops.id, 'organization'::text, ops."effectiveFrom", ops."debitRate", ops."creditRate", ops."amexRate",
             ops."internationalRate", ops."includesTax", ops."fixedFeePerTransaction", 2
           FROM "OrganizationPricingStructure" ops
           WHERE ops."organizationId" = p."organizationId" AND ops."accountType"::text = p.slot AND ops.active
             AND ops."effectiveFrom" <= ${ahora} AND (ops."effectiveTo" IS NULL OR ops."effectiveTo" >= ${ahora})
           ORDER BY ops."effectiveFrom" DESC LIMIT 1)
        ) u ORDER BY u.prio LIMIT 1
      ) tar ON TRUE
    ),
    marcado AS (
      SELECT det.*,
        (det."accountId" IS NOT NULL AND det."pricingId" IS NOT NULL
          AND det."pricingFrom" < det."accountCreatedAt" - make_interval(mins => ${TOLERANCIA_MINUTOS}::int)) AS f1,
        (det."accountId" IS NULL AND det."pricingId" IS NOT NULL) AS f2,
        (det."accountId" IS NOT NULL AND det."pricingId" IS NULL) AS f3,
        (det."accountId" IS NOT NULL AND det."otherProcessorTerminals" > 0) AS f4
      FROM det
    ),
    negocio AS (
      SELECT "venueId", bool_or(f1) AS f1, bool_or(f2) AS f2, bool_or(f3) AS f3, bool_or(f4) AS f4,
        bool_or("accountId" IS NOT NULL OR "pricingId" IS NOT NULL) AS "hasData"
      FROM marcado GROUP BY "venueId"
    ),
    universo AS (SELECT n.* FROM negocio n WHERE n."hasData"),
    filtrado AS (
      SELECT b.id, b.name, b.slug, b.status, b."organizationId", b."organizationName", b."accountsSource"
      FROM universo n JOIN base b ON b.id = n."venueId"
      WHERE ${filtroMarca}
    ),
    pagina AS (SELECT * FROM filtrado ORDER BY name ASC, id ASC LIMIT ${take} OFFSET ${skip})
    SELECT
      (SELECT count(*) FROM filtrado)::int AS total,
      (SELECT count(*) FILTER (WHERE f1) FROM universo)::int AS "conteoTarifaAnterior",
      (SELECT count(*) FILTER (WHERE f2) FROM universo)::int AS "conteoSinCuentaConTarifa",
      (SELECT count(*) FILTER (WHERE f3) FROM universo)::int AS "conteoCuentaSinTarifa",
      (SELECT count(*) FILTER (WHERE f4) FROM universo)::int AS "conteoOtroProcesador",
      pg.id AS "venueId", pg.name AS "venueName", pg.slug AS "venueSlug", pg.status AS "venueStatus",
      pg."organizationId", pg."organizationName", pg."accountsSource",
      m.slot, m."accountId", m."accountName", m."accountActive", m."accountCreatedAt", m."providerCode",
      m."pricingId", m."pricingSource", m."pricingFrom", m."debitRate", m."creditRate", m."amexRate", m."internationalRate",
      m."includesTax", m."fixedFeePerTransaction", COALESCE(m."inheritingTerminals", 0) AS "inheritingTerminals",
      COALESCE(m."otherProcessorTerminals", 0) AS "otherProcessorTerminals",
      COALESCE(m.f1, FALSE) AS f1, COALESCE(m.f2, FALSE) AS f2, COALESCE(m.f3, FALSE) AS f3, COALESCE(m.f4, FALSE) AS f4
    FROM (SELECT 1) uno
    LEFT JOIN pagina pg ON TRUE
    LEFT JOIN marcado m ON m."venueId" = pg.id
    ORDER BY pg.name ASC NULLS LAST, pg.id ASC NULLS LAST, m.ord ASC
  `

  const primera = filas[0]
  const negocios = new Map<string, ReturnType<typeof negocioDe>>()
  for (const f of filas) {
    if (!f.venueId || !f.slot) continue
    let n = negocios.get(f.venueId)
    if (!n) negocios.set(f.venueId, (n = negocioDe(f)))
    const flags: MarcaDePosicion[] = []
    if (f.f1) flags.push('TARIFA_ANTERIOR_A_LA_CUENTA')
    if (f.f2) flags.push('SIN_CUENTA_CON_TARIFA')
    if (f.f3) flags.push('CUENTA_SIN_TARIFA')
    if (f.f4) flags.push('TERMINALES_DE_OTRO_PROCESADOR')
    n.inheritingTerminals = f.inheritingTerminals
    for (const fl of flags) if (!n.flags.includes(fl)) n.flags.push(fl)
    n.positions.push({
      slot: f.slot,
      account: f.accountId
        ? { id: f.accountId, name: f.accountName, providerCode: f.providerCode, active: f.accountActive, createdAt: f.accountCreatedAt }
        : null,
      pricing: f.pricingId
        ? {
            id: f.pricingId,
            source: f.pricingSource,
            effectiveFrom: f.pricingFrom,
            debitRate: num(f.debitRate),
            creditRate: num(f.creditRate),
            amexRate: num(f.amexRate),
            internationalRate: num(f.internationalRate),
            includesTax: f.includesTax,
            fixedFeePerTransaction: num(f.fixedFeePerTransaction),
          }
        : null,
      otherProcessorTerminals: f.otherProcessorTerminals,
      flags,
    })
  }
  const total = primera?.total ?? 0
  return {
    data: [...negocios.values()],
    meta: { page: q.page, pageSize: q.pageSize, total, totalPages: Math.max(1, Math.ceil(total / q.pageSize)) },
    summary: {
      TARIFA_ANTERIOR_A_LA_CUENTA: primera?.conteoTarifaAnterior ?? 0,
      SIN_CUENTA_CON_TARIFA: primera?.conteoSinCuentaConTarifa ?? 0,
      CUENTA_SIN_TARIFA: primera?.conteoCuentaSinTarifa ?? 0,
      TERMINALES_DE_OTRO_PROCESADOR: primera?.conteoOtroProcesador ?? 0,
    },
  }
}

function negocioDe(f: Fila) {
  return {
    venueId: f.venueId as string,
    venueName: f.venueName,
    venueSlug: f.venueSlug,
    venueStatus: f.venueStatus,
    organizationId: f.organizationId,
    organizationName: f.organizationName,
    accountsSource: f.accountsSource,
    inheritingTerminals: 0,
    flags: [] as MarcaDePosicion[],
    positions: [] as Array<{
      slot: string
      account: { id: string; name: string | null; providerCode: string | null; active: boolean | null; createdAt: Date | null } | null
      pricing: Record<string, unknown> | null
      otherProcessorTerminals: number
      flags: MarcaDePosicion[]
    }>,
  }
}
