/**
 * What «Clientes» adds to the rows of ONE page (plan C1): each helper reads at most the page's ids, never the universe, in
 * ONE query per thing for the whole page (`clientPageSql.ts`). The statements that walk the universe live in
 * `clientsQueries` (`clientsSql.ts`) and nowhere else.
 */
import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'
import { derivePlanState, PAID_PLAN_TIER_CODES, type PlanStateValue } from '../access/basePlan.service'
import { elegirFilaDelPlan } from '../access/filaDelPlan'
import { resolveGrandfathered } from '../access/grandfather'
import { daAcceso } from '../access/ventanaDeAcceso'
import { staffNames } from './accounts.service'
import { MOTIVOS_DEL_ALTA, type Condicion, type MotivoDelAlta, type Nivel } from './clientCodes'
import { altaSql, aparatosSql, canjesSql, comentariosSql, contratosSql, LARGO_DEL_COMENTARIO, sucursalesSql } from './clientPageSql'

/** The ✋ of a CRM account the caller may see (`scopeWhere(access, 'ver')`). */
export interface UsaEscritoVisible {
  usaManual: string | null
  usaManualPorque: string | null
  usaManualById: string | null
  usaManualAt: Date | null
}

/** The page's columns of «Usa», as `clientsQueries().page` selects them. */
export interface UsaDeLaFila {
  usaMedido: string
  usaVisto: string
  usaAviso: boolean
  usaEscrito: boolean
}

const fullName = (person: { firstName: string; lastName: string }) => `${person.firstName} ${person.lastName}`.trim()

/** Who wrote each visible ✋ of the page, in ONE query (the author has no FK: the history never depends on the staff). */
export async function autoresDelUsa(visibles: UsaEscritoVisible[]): Promise<Map<string, { id: string; name: string }>> {
  const ids = [...new Set(visibles.filter(account => account.usaManual && account.usaManualById).map(account => account.usaManualById!))]
  if (!ids.length) return new Map()
  const staff = await prisma.staff.findMany({
    where: { id: { in: ids } },
    select: { id: true, firstName: true, lastName: true },
    take: ids.length,
  })
  return new Map(staff.map(person => [person.id, { id: person.id, name: fullName(person) }]))
}

/**
 * The «Usa» cell: what is seen (written ?? measured), what was measured, whether a person wrote it and whether that differs
 * from the measure — all from the SQL columns the filter uses. Who, why and when only for an account in the caller's «Ver».
 */
export function usaDeLaFila(row: UsaDeLaFila, visible: UsaEscritoVisible | undefined, autores: Map<string, { id: string; name: string }>) {
  return {
    visto: row.usaVisto,
    medido: row.usaMedido,
    manual: row.usaEscrito,
    aviso: row.usaAviso,
    detalle:
      row.usaEscrito && visible?.usaManual
        ? {
            porque: visible.usaManualPorque,
            por: visible.usaManualById ? (autores.get(visible.usaManualById) ?? null) : null,
            at: visible.usaManualAt,
          }
        : null,
  }
}

/** The count of stalled signups by reason, every key present (zeros included). */
export function conteosDe(row: Record<string, number | undefined> | undefined) {
  const of = (key: string) => row?.[key] ?? 0
  return {
    altaSinTarjeta: of('altaSinTarjeta'),
    porMotivo: {
      ...(Object.fromEntries(MOTIVOS_DEL_ALTA.map(motivo => [motivo, of(motivo)])) as Record<(typeof MOTIVOS_DEL_ALTA)[number], number>),
      SIN_MOTIVO: of('SIN_MOTIVO'),
      DE_OTRO: of('DE_OTRO'),
    },
    perdidos: of('perdidos'),
  }
}

// ── Plan de la página (rediseño r3): sólo las reglas canónicas de la plataforma ──────────────────────────────────────

/** Where «Tu plan» comes from, as `getPlanState` says it (`PlanOrigin.kind`). */
export type Origen = 'CLASSIC' | 'CONTRACT' | 'COMP' | 'NONE'

/** One venue of the page, read the way `getPlanState` and `getVenuePlanInfo` read it, without Stripe. */
export interface PlanDeLaSucursal {
  venueId: string
  organizationId: string
  /** How many real venues its organization has (this list reads the first 20). */
  sucursalesTotales: number
  nivel: Nivel
  estado: PlanStateValue
  origen: Origen
  condicion: Condicion | null
  /** The publication's name of the contract, only when the condition is `CAMPANA`. */
  campana: string | null
  pagoVencido: boolean
}

/** What a stalled or paying signup accepted from a launch campaign, and when (a note: never «vigente» nor an end). */
export interface CampanaAceptada {
  nombre: string
  /** Pesos: the redemption's `advertisedPriceCents` ÷ 100 (the named cents exception ends here). */
  precioMensual: number
  meses: number
  /** `reservedAt`: when the owner accepted the offer. `appliedAt` moves with a recovery (Codex r4 #2). */
  aceptadaEl: Date
}

export interface PlanDeLaFila {
  nivel: Nivel
  condicion: Condicion | null
  campana: string | null
  campanaAceptada: CampanaAceptada | null
  pagoVencido: boolean
  variaPorSucursal: boolean
  sucursalesLeidas: number
  sucursalesTotales: number
}

type SucursalLeida = {
  id: string
  organizationId: string
  seatCapExempt: boolean
  orgSeatCapExempt: boolean
  total: number
  concesionPro: boolean
  concesionPremium: boolean
}

const NIVEL_ORDEN: Record<Nivel, number> = { FREE: 0, PRO: 1, PREMIUM: 2 }
/** Which venue speaks for the organization among those of its highest level (an order of the conditions, never of plan rows). */
const CONDICION_ORDEN: Record<Condicion, number> = {
  PAGADO: 5,
  CAMPANA: 5,
  PRUEBA_CON_TARJETA: 4,
  PRUEBA_SIN_TARJETA: 3,
  CORTESIA: 2,
  DE_ANTES: 1,
  GRATIS: 0,
}
const ordenDe = (condicion: Condicion | null) => (condicion ? CONDICION_ORDEN[condicion] : -1)

/** An organization without a real venue (only a won CRM link): Free, with nothing else to say. */
const SIN_SUCURSALES: PlanDeLaFila = {
  nivel: 'FREE',
  condicion: null,
  campana: null,
  campanaAceptada: null,
  pagoVencido: false,
  variaPorSucursal: false,
  sucursalesLeidas: 0,
  sucursalesTotales: 0,
}

/** `Map.groupBy` (ES2024, newer than this project's `lib`). */
function agrupar<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const item of items) {
    const group = out.get(key(item))
    if (group) group.push(item)
    else out.set(key(item), [item])
  }
  return out
}

/**
 * The plan of every venue of the page (its organizations' first 20 real venues): the SAME steps as `getPlanState`
 * (`planState.service.ts`) and `getVenuePlanInfo` (`basePlan.service.ts`), with their functions imported, never copied:
 *
 * - nivel: the `daAcceso` rows (Premium before Pro) combined with a commercial grant in force, as `getVenuePlanInfo`;
 * - `fila = elegirFilaDelPlan(filas)`, `estado = derivePlanState(fila, null)` — Stripe is never asked (the oracle is
 *   `getPlanState` with Stripe down);
 * - origen: CLASSIC (active row with Stripe), else CONTRACT (the `planContractOrigin` contract), else COMP (the row gives
 *   access), else NONE.
 *
 * Three queries for the whole page. `derivePlanState` reads the real clock, as it does inside `getPlanState`.
 * ponytail: 20 sucursales por organización, como la ficha; pagina las sucursales si un cliente con más necesita la
 * condición de todas.
 */
export async function planesPorSucursal(organizationIds: string[], now: Date): Promise<PlanDeLaSucursal[]> {
  if (!organizationIds.length) return []
  const sucursales = await prisma.$queryRaw<SucursalLeida[]>(sucursalesSql(organizationIds, now))
  if (!sucursales.length) return []
  const venueIds = sucursales.map(sucursal => sucursal.id)
  const [filas, contratos] = await Promise.all([
    // The fields of `findPlanProFeature`; at most one row per plan code per venue (`@@unique([venueId, featureId])`).
    prisma.venueFeature.findMany({
      where: { venueId: { in: venueIds }, feature: { code: { in: [...PAID_PLAN_TIER_CODES] } } },
      select: {
        venueId: true,
        active: true,
        endDate: true,
        suspendedAt: true,
        gracePeriodEndsAt: true,
        stripeSubscriptionId: true,
        updatedAt: true,
        feature: { select: { code: true } },
      },
      take: venueIds.length * PAID_PLAN_TIER_CODES.length,
    }),
    prisma.$queryRaw<Array<{ venueId: string; planTier: string; name: string }>>(contratosSql(venueIds, now)),
  ])
  const filasDe = agrupar(filas, fila => fila.venueId)
  const contratoDe = new Map(contratos.map(contrato => [contrato.venueId, contrato]))

  return sucursales.map(sucursal => {
    const suyas = filasDe.get(sucursal.id) ?? []
    const conAcceso = suyas.filter(fila => daAcceso(fila, now)).map(fila => fila.feature.code)
    const legado = conAcceso.includes('PLAN_PREMIUM') ? 'PREMIUM' : conAcceso.includes('PLAN_PRO') ? 'PRO' : null
    const comercial = sucursal.concesionPremium ? 'PREMIUM' : sucursal.concesionPro ? 'PRO' : null
    const nivel: Nivel = legado === 'PREMIUM' || comercial === 'PREMIUM' ? 'PREMIUM' : (legado ?? comercial ?? 'FREE')

    const fila = elegirFilaDelPlan(suyas, now)
    const { state } = derivePlanState(fila, null)
    const contrato = contratoDe.get(sucursal.id)
    const origen: Origen =
      fila?.active && fila.stripeSubscriptionId ? 'CLASSIC' : contrato ? 'CONTRACT' : fila && daAcceso(fila, now) ? 'COMP' : 'NONE'

    const grandfathered = resolveGrandfathered({
      seatCapExempt: sucursal.seatCapExempt,
      organization: { seatCapExempt: sucursal.orgSeatCapExempt },
    })
    const condicion: Condicion | null =
      nivel === 'FREE'
        ? grandfathered
          ? 'DE_ANTES'
          : 'GRATIS'
        : origen === 'CLASSIC'
          ? state === 'trial'
            ? 'PRUEBA_CON_TARJETA'
            : 'PAGADO'
          : origen === 'CONTRACT'
            ? 'CAMPANA'
            : origen === 'COMP'
              ? state === 'trial'
                ? 'PRUEBA_SIN_TARJETA'
                : 'CORTESIA'
              : null // only a grant without a readable contract: the cell says the level alone
    return {
      venueId: sucursal.id,
      organizationId: sucursal.organizationId,
      sucursalesTotales: sucursal.total,
      nivel,
      estado: state,
      origen,
      condicion,
      campana: condicion === 'CAMPANA' ? contrato!.name : null,
      pagoVencido: state === 'past_due' && nivel !== 'FREE',
    }
  })
}

/**
 * The plan cell of each organization of the page: among its venues of the highest level, the best condition; `pagoVencido`
 * if any venue is past due; `variaPorSucursal` if its venues say more than one (level, condition). Plus the newest CHARGED
 * launch-campaign redemption as a note. No Stripe, no `getPlanState`: four queries for the whole page.
 */
export async function planDeLaPagina(organizationIds: string[], now: Date): Promise<Map<string, PlanDeLaFila>> {
  if (!organizationIds.length) return new Map()
  const [sucursales, canjes] = await Promise.all([
    planesPorSucursal(organizationIds, now),
    prisma.$queryRaw<
      Array<{ organizationId: string; name: string; advertisedPriceCents: number; discountMonths: number; reservedAt: Date }>
    >(canjesSql(organizationIds)),
  ])
  const canjeDe = new Map(canjes.map(canje => [canje.organizationId, canje]))
  const out = new Map<string, PlanDeLaFila>()
  for (const [organizationId, suyas] of agrupar(sucursales, sucursal => sucursal.organizationId)) {
    const nivel = suyas.reduce<Nivel>((alto, s) => (NIVEL_ORDEN[s.nivel] > NIVEL_ORDEN[alto] ? s.nivel : alto), 'FREE')
    const mejor = suyas.filter(s => s.nivel === nivel).reduce((a, b) => (ordenDe(b.condicion) > ordenDe(a.condicion) ? b : a))
    const canje = canjeDe.get(organizationId)
    out.set(organizationId, {
      nivel,
      condicion: mejor.condicion,
      campana: mejor.campana,
      campanaAceptada: canje
        ? { nombre: canje.name, precioMensual: canje.advertisedPriceCents / 100, meses: canje.discountMonths, aceptadaEl: canje.reservedAt }
        : null,
      pagoVencido: suyas.some(s => s.pagoVencido),
      variaPorSucursal: new Set(suyas.map(s => `${s.nivel}|${s.condicion}`)).size > 1,
      sucursalesLeidas: suyas.length,
      sucursalesTotales: suyas[0].sucursalesTotales,
    })
  }
  return out
}

/**
 * The plan of a row: the level is ALWAYS the SQL one (the filter and the count read it). If the page's JS level differs —
 * only expected when the organization has more than the 20 venues read — the condition is left out; with every venue read it
 * should never happen, so it is logged (C12) with no personal data.
 */
export function planDeLaFila(organizationId: string, nivelSql: Nivel, pagina: PlanDeLaFila | undefined): PlanDeLaFila {
  const plan = pagina ?? SIN_SUCURSALES
  if (plan.nivel === nivelSql) return plan
  if (plan.sucursalesLeidas === plan.sucursalesTotales)
    logger.warn('[CRM] Clientes: el nivel de la lista (SQL) y el de la página (JS) no coinciden', {
      organizationId,
      nivelSql,
      nivelPagina: plan.nivel,
    })
  return { ...plan, nivel: nivelSql, condicion: null, campana: null }
}

// ── Aparatos, datos del alta y último comentario ──────────────────────────────────────────────────────────────────

/** The devices of each organization of the page; one without any is absent (read it as zero). */
export async function aparatosDe(organizationIds: string[]): Promise<Map<string, { terminales: number; pos: number }>> {
  if (!organizationIds.length) return new Map()
  const rows = await prisma.$queryRaw<Array<{ organizationId: string; terminales: number; pos: number }>>(aparatosSql(organizationIds))
  return new Map(rows.map(row => [row.organizationId, { terminales: row.terminales, pos: row.pos }]))
}

export interface AltaFacts {
  negocioCreadoAt: Date | null
  ultimaVezAt: Date
  oferta: { tipo: 'CAMPANA' | 'OFERTA' | 'LISTA'; nombre: string | null }
  origen: 'LANDING' | 'DIRECTO'
  tarjeta: 'RECHAZADA' | 'SIN_TERMINAR' | 'NO_INTENTO'
}

/**
 * What the database knows of each organization's signup (only those with an `OnboardingProgress`). The bank's reason for a
 * decline is not stored, so `RECHAZADA` says no more than that.
 */
export async function altaFactsOf(organizationIds: string[]): Promise<Map<string, AltaFacts>> {
  if (!organizationIds.length) return new Map()
  const rows = await prisma.$queryRaw<
    Array<{
      organizationId: string
      negocioCreadoAt: Date | null
      ultimaVezAt: Date
      campana: string | null
      ofertaSlug: string | null
      acquisitionSource: string | null
      planActivationStatus: string
      planActivationAttempt: number
    }>
  >(altaSql(organizationIds))
  return new Map(
    rows.map(row => [
      row.organizationId,
      {
        negocioCreadoAt: row.negocioCreadoAt,
        ultimaVezAt: row.ultimaVezAt,
        oferta: row.campana
          ? { tipo: 'CAMPANA', nombre: row.campana }
          : row.ofertaSlug
            ? { tipo: 'OFERTA', nombre: row.ofertaSlug }
            : { tipo: 'LISTA', nombre: null },
        origen: row.acquisitionSource?.startsWith('landing') ? 'LANDING' : 'DIRECTO',
        tarjeta:
          row.planActivationStatus === 'DECLINED'
            ? 'RECHAZADA'
            : row.planActivationAttempt > 0 || row.planActivationStatus === 'IN_PROGRESS'
              ? 'SIN_TERMINAR'
              : 'NO_INTENTO',
      },
    ]),
  )
}

/** A 🟠 row's signup with what a person wrote, which only travels for an account in the caller's «Ver». */
export function altaDeLaFila(
  facts: AltaFacts | undefined,
  visible: { altaMotivo: string | null; altaMotivoTexto: string | null; altaPerdido: boolean } | undefined,
) {
  if (!facts) return null
  return {
    ...facts,
    motivo: (visible?.altaMotivo ?? null) as MotivoDelAlta | null,
    motivoTexto: visible?.altaMotivoTexto ?? null,
    perdido: visible?.altaPerdido ?? false,
  }
}

export interface UltimoComentario {
  texto: string
  autor: { id: string; name: string } | null
  at: Date
}

/** The newest note of each account given (only accounts the caller sees), cut at 140 characters with «…». */
export async function ultimosComentarios(accountIds: string[]): Promise<Map<string, UltimoComentario>> {
  if (!accountIds.length) return new Map()
  const rows = await prisma.$queryRaw<Array<{ accountId: string; actorStaffId: string | null; createdAt: Date; texto: string | null }>>(
    comentariosSql(accountIds),
  )
  const names = await staffNames(rows.map(row => row.actorStaffId))
  return new Map(
    rows.map(row => {
      const letras = [...(row.texto ?? '')]
      const name = row.actorStaffId ? names.get(row.actorStaffId) : undefined
      return [
        row.accountId,
        {
          texto: letras.length > LARGO_DEL_COMENTARIO ? `${letras.slice(0, LARGO_DEL_COMENTARIO - 1).join('')}…` : letras.join(''),
          autor: name ? { id: row.actorStaffId!, name } : null,
          at: row.createdAt,
        },
      ]
    }),
  )
}
