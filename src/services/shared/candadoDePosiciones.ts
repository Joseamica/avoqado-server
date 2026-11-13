/**
 * Candado al cambiar la cuenta de una posición (PRIMARY / SECONDARY / TERTIARY) — tarifa al comercio, paso 1 (12-nov-2026).
 * Promesa y mapa: `docs/audit/2026-11-12-tarifa-por-cuenta/promesa-pasos-1-y-2.md` del workspace.
 *
 * La tarifa que Avoqado cobra vive en la POSICIÓN, no en la cuenta: si alguien cambia la cuenta de una posición, la cuenta
 * nueva hereda la tarifa vieja sin que nadie la vea. Este módulo es el ÚNICO lugar donde los escritores de posiciones exigen,
 * dentro de su transacción de guardado:
 *   1. la cuenta que vio la pantalla (`previousAccountId`): si ya cambió ⇒ 409 (pantalla vieja);
 *   2. la tarifa que quedaría, confirmada con su huella (`rate: { mode: 'KEEP', fingerprint }`): si cambió ⇒ 409;
 *   3. el número de terminales de cobro que heredan las posiciones y perderían la cuenta que sale.
 * Falta algo ⇒ 400 `CONFIRMAR_POSICION` con lo que la pantalla necesita para preguntar (`details.positions`).
 *
 * 🔴 NUNCA escribe tarifas ni toca el camino de cobro (decisión D2 del 12-nov): sólo LEE la configuración y las tarifas con
 * la misma regla que la captura al cobrar (`getEffectivePricingForSlot`). Si la tarifa no es la correcta, se cambia primero
 * en Tarifas (la pantalla de siempre) y luego se guarda la cuenta.
 */
import { createHash } from 'crypto'
import { z } from 'zod'
import { Prisma, AccountType } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { BadRequestError, ConflictError } from '@/errors/AppError'
import { getEffectivePricingForSlot } from '@/services/organization-payment-config.service'
import { PROVIDER_DEVICE_COMPATIBILITY } from '@/lib/providerDeviceCompatibility'
import { utcTs } from '@/utils/sqlDates'

export const POSICIONES = ['PRIMARY', 'SECONDARY', 'TERTIARY'] as const
export type Posicion = (typeof POSICIONES)[number]
export const COLUMNA_DE_POSICION = {
  PRIMARY: 'primaryAccountId',
  SECONDARY: 'secondaryAccountId',
  TERTIARY: 'tertiaryAccountId',
} as const
export const NOMBRE_DE_POSICION: Record<Posicion, string> = { PRIMARY: 'Principal', SECONDARY: 'Secundaria', TERTIARY: 'Terciaria' }

export const CONFIRMAR_POSICION = 'CONFIRMAR_POSICION'
export const POSICION_DESACTUALIZADA = 'POSICION_DESACTUALIZADA'

/** El 400/409 del candado es una respuesta NORMAL (la pantalla pregunta o recarga): se registra como aviso, sin stack. */
export function esRespuestaDelCandado(error: unknown): error is BadRequestError | ConflictError {
  const code = (error as { code?: unknown } | null)?.code
  return (
    (error instanceof BadRequestError || error instanceof ConflictError) &&
    (code === CONFIRMAR_POSICION || code === POSICION_DESACTUALIZADA)
  )
}
/** La cuenta todavía no existe (asistente que la crea después de revisar): siempre distinta de la actual. */
export const CUENTA_NUEVA = '__CUENTA_NUEVA__'
/** Terminales de COBRO (las POS_* no cobran con tarjeta ni reciben cuentas). */
export const TIPOS_DE_TERMINAL_DE_COBRO = ['TPV_ANDROID', 'TPV_IOS'] as const
/** Huella cuando la posición no tendrá tarifa. */
export const SIN_TARIFA = 'SIN_TARIFA'
/** Cuántos negocios con tarifa propia se describen en el detalle (la huella los cuenta TODOS). */
const NEGOCIOS_A_DESCRIBIR = 20

const confirmacionSchema = z.object({
  previousAccountId: z.string({ invalid_type_error: 'Cuenta anterior inválida' }).nullable().optional(),
  /** Sólo cuando el SERVIDOR calcula la cuenta nueva (borrar la configuración propia, traslado): la que vio la pantalla. */
  nextAccountId: z.string({ invalid_type_error: 'Cuenta nueva inválida' }).nullable().optional(),
  rate: z
    .object({
      mode: z.literal('KEEP', { errorMap: () => ({ message: 'Sólo se puede confirmar la tarifa que ya tiene la posición' }) }),
      fingerprint: z.string({ required_error: 'Falta la huella de la tarifa', invalid_type_error: 'Huella inválida' }).min(1),
    })
    .optional(),
  inheritingTerminals: z.number({ invalid_type_error: 'Número de terminales inválido' }).int().min(0).optional(),
})

/** Campo `positionConfirmations` de cada petición que puede cambiar una posición. */
export const confirmacionDePosicionesSchema = z
  .object({ PRIMARY: confirmacionSchema.optional(), SECONDARY: confirmacionSchema.optional(), TERTIARY: confirmacionSchema.optional() })
  .nullish()
export type ConfirmacionDePosiciones = z.infer<typeof confirmacionDePosicionesSchema>

/** Para rutas sin validador de zod: valida `positionConfirmations` del cuerpo o responde 400 en español. */
export function leerConfirmaciones(crudo: unknown): ConfirmacionDePosiciones {
  const r = confirmacionDePosicionesSchema.safeParse(crudo ?? undefined)
  if (!r.success) throw new BadRequestError(`Confirmación de posiciones inválida: ${r.error.issues.map(i => i.message).join('; ')}`)
  return r.data
}

export type Objetivo = { venueId: string } | { organizationId: string }
type Cliente = Prisma.TransactionClient | typeof prisma
export type Cuentas = Record<Posicion, string | null>
const SIN_CUENTAS: Cuentas = { PRIMARY: null, SECONDARY: null, TERTIARY: null }

export type CambioDePosicion = {
  slot: Posicion
  from: string | null
  to: string | null
  /** KEEP = la persona confirmó la tarifa que quedaba · CAPTURADA = el escritor la capturó en la misma petición. */
  rate: 'KEEP' | 'CAPTURADA' | 'NO_APLICA'
  pricingId: string | null
  inheritingTerminals: number
}

const selectCuentas = { primaryAccountId: true, secondaryAccountId: true, tertiaryAccountId: true } as const
function cuentasDeFila(
  fila: { primaryAccountId: string; secondaryAccountId: string | null; tertiaryAccountId: string | null } | null,
): Cuentas {
  return fila ? { PRIMARY: fila.primaryAccountId, SECONDARY: fila.secondaryAccountId, TERTIARY: fila.tertiaryAccountId } : SIN_CUENTAS
}

/**
 * Las cuentas EFECTIVAS de cada posición: las del negocio si tiene configuración propia; si no, las de su organización (la
 * misma regla que `getEffectivePaymentConfig`). Con `bloquear`, deja tomadas con `FOR UPDATE` las filas de las que depende
 * la respuesta, para que dos guardados no se crucen.
 */
/**
 * Candado asesor por organización (Codex p12-r2 #3): todos los guardados de posiciones de un negocio o de su organización se
 * forman aquí, también cuando la fila de configuración todavía NO existe (no hay fila que bloquear). En orden fijo.
 */
async function formarseEnLaOrganizacion(db: Cliente, organizationIds: string[]): Promise<void> {
  for (const id of [...new Set(organizationIds)].sort()) {
    await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`posiciones-de-cobro:${id}`}, 0))::text`
  }
}

/**
 * Toma los candados del guardado ANTES de que el escritor lea su configuración: el de la organización, `FOR UPDATE` de la
 * configuración del negocio y de la de su organización. Se puede repetir en la misma transacción (los candados se reentran).
 */
export async function tomarCandado(db: Prisma.TransactionClient, objetivo: Objetivo, otraOrganizacion?: string): Promise<void> {
  await leerCuentasActuales(db, objetivo, true, otraOrganizacion)
}

export async function leerCuentasActuales(
  db: Cliente,
  objetivo: Objetivo,
  bloquear: boolean,
  otraOrganizacion?: string,
): Promise<{ cuentas: Cuentas; organizationId: string; negocioConConfigPropia: boolean }> {
  if ('organizationId' in objetivo) {
    if (bloquear) {
      await formarseEnLaOrganizacion(db, [objetivo.organizationId])
      await db.$queryRaw`SELECT id FROM "OrganizationPaymentConfig" WHERE "organizationId" = ${objetivo.organizationId} FOR UPDATE`
    }
    const org = await db.organizationPaymentConfig.findUnique({ where: { organizationId: objetivo.organizationId }, select: selectCuentas })
    return { cuentas: cuentasDeFila(org), organizationId: objetivo.organizationId, negocioConConfigPropia: false }
  }
  const venue = await db.venue.findUnique({ where: { id: objetivo.venueId }, select: { organizationId: true } })
  if (!venue) throw new BadRequestError('El negocio no existe')
  if (bloquear) {
    await formarseEnLaOrganizacion(db, otraOrganizacion ? [venue.organizationId, otraOrganizacion] : [venue.organizationId])
    // Codex p12-r4 #3: la organización se leyó ANTES de formarse; un traslado que terminó mientras tanto la cambia. Se relee ya
    // con el candado (el traslado lo retiene hasta su commit) y, si cambió, la pantalla tiene que recargar.
    const ahoraEs = await db.venue.findUnique({ where: { id: objetivo.venueId }, select: { organizationId: true } })
    if (ahoraEs?.organizationId !== venue.organizationId) {
      throw new ConflictError('Este negocio acaba de cambiar de organización. Recarga y vuelve a intentarlo.', POSICION_DESACTUALIZADA)
    }
    await db.$queryRaw`SELECT id FROM "VenuePaymentConfig" WHERE "venueId" = ${objetivo.venueId} FOR UPDATE`
    await db.$queryRaw`SELECT id FROM "OrganizationPaymentConfig" WHERE "organizationId" = ${venue.organizationId} FOR UPDATE`
  }
  const propia = await db.venuePaymentConfig.findUnique({ where: { venueId: objetivo.venueId }, select: selectCuentas })
  if (propia) return { cuentas: cuentasDeFila(propia), organizationId: venue.organizationId, negocioConConfigPropia: true }
  const org = await db.organizationPaymentConfig.findUnique({ where: { organizationId: venue.organizationId }, select: selectCuentas })
  return { cuentas: cuentasDeFila(org), organizationId: venue.organizationId, negocioConConfigPropia: false }
}

/** Las cuentas de una organización (lo que hereda un negocio sin configuración propia). */
export async function cuentasDeLaOrganizacion(db: Cliente, organizationId: string): Promise<Cuentas> {
  const org = await db.organizationPaymentConfig.findUnique({ where: { organizationId }, select: selectCuentas })
  return cuentasDeFila(org)
}

type FilaDeTarifa = {
  id: string
  updatedAt: Date
  effectiveFrom: Date
  debitRate: Prisma.Decimal
  creditRate: Prisma.Decimal
  amexRate: Prisma.Decimal
  internationalRate: Prisma.Decimal
  includesTax: boolean | null
  taxRate: Prisma.Decimal
  fixedFeePerTransaction: Prisma.Decimal | null
  monthlyServiceFee: Prisma.Decimal | null
}

export type Tarifa = {
  id: string
  source: 'venue' | 'organization'
  effectiveFrom: Date
  updatedAt: Date
  debitRate: number
  creditRate: number
  amexRate: number
  internationalRate: number
  includesTax: boolean | null
  taxRate: number
  fixedFeePerTransaction: number | null
  monthlyServiceFee: number | null
}

const aNumero = (d: Prisma.Decimal | null | undefined) => (d === null || d === undefined ? null : Number(d))

function tarifaDe(fila: FilaDeTarifa, source: 'venue' | 'organization'): Tarifa {
  return {
    id: fila.id,
    source,
    effectiveFrom: fila.effectiveFrom,
    updatedAt: fila.updatedAt,
    debitRate: Number(fila.debitRate),
    creditRate: Number(fila.creditRate),
    amexRate: Number(fila.amexRate),
    internationalRate: Number(fila.internationalRate),
    includesTax: fila.includesTax,
    taxRate: Number(fila.taxRate),
    fixedFeePerTransaction: aNumero(fila.fixedFeePerTransaction),
    monthlyServiceFee: aNumero(fila.monthlyServiceFee),
  }
}

const vigenteEn = (ahora: Date) => ({
  active: true,
  effectiveFrom: { lte: ahora },
  OR: [{ effectiveTo: null }, { effectiveTo: { gte: ahora } }],
})

async function tarifaDeLaOrganizacion(db: Cliente, organizationId: string, slot: Posicion, ahora: Date): Promise<Tarifa | null> {
  const fila = await db.organizationPricingStructure.findFirst({
    where: { organizationId, accountType: slot as AccountType, ...vigenteEn(ahora) },
    orderBy: [{ effectiveFrom: 'desc' }],
  })
  return fila ? tarifaDe(fila, 'organization') : null
}

/**
 * La tarifa que el SERVIDOR aplicaría HOY a esa posición: la misma lectura que la captura al cobrar. `organizacion` sólo se
 * pasa en el traslado: la tarifa de respaldo será la de la organización DESTINO.
 */
async function tarifaQueQuedaria(
  db: Cliente,
  objetivo: Objetivo,
  slot: Posicion,
  ahora: Date,
  organizacion?: string,
): Promise<Tarifa | null> {
  if ('organizationId' in objetivo) return tarifaDeLaOrganizacion(db, objetivo.organizationId, slot, ahora)
  if (!organizacion) {
    const r = await getEffectivePricingForSlot(objetivo.venueId, slot as AccountType, ahora, db)
    const fila = r?.pricing[0]
    return fila && r ? tarifaDe(fila, r.source) : null
  }
  const propia = await db.venuePricingStructure.findFirst({
    where: { venueId: objetivo.venueId, accountType: slot as AccountType, ...vigenteEn(ahora) },
    orderBy: [{ effectiveFrom: 'desc' }],
  })
  return propia ? tarifaDe(propia, 'venue') : tarifaDeLaOrganizacion(db, organizacion, slot, ahora)
}

type TarifaPropia = { venueId: string; venueName: string; tarifa: Tarifa }

/** Organización: la tarifa propia vigente de cada negocio que hereda sus cuentas (una por negocio, en la base). */
async function tarifasPropiasDeLosQueHeredan(db: Cliente, organizationId: string, slot: Posicion, ahora: Date): Promise<TarifaPropia[]> {
  const filas = await db.$queryRaw<Array<FilaDeTarifa & { venueId: string; venueName: string }>>`
    SELECT DISTINCT ON (vps."venueId") vps."venueId", v.name AS "venueName", vps.id, vps."updatedAt", vps."effectiveFrom",
      vps."debitRate", vps."creditRate", vps."amexRate", vps."internationalRate", vps."includesTax", vps."taxRate",
      vps."fixedFeePerTransaction", vps."monthlyServiceFee"
    FROM "VenuePricingStructure" vps
    JOIN "Venue" v ON v.id = vps."venueId"
    WHERE v."organizationId" = ${organizationId}
      AND NOT EXISTS (SELECT 1 FROM "VenuePaymentConfig" c WHERE c."venueId" = v.id)
      AND vps."accountType"::text = ${slot} AND vps.active
      AND vps."effectiveFrom" <= ${utcTs(ahora)} AND (vps."effectiveTo" IS NULL OR vps."effectiveTo" >= ${utcTs(ahora)})
    ORDER BY vps."venueId", vps."effectiveFrom" DESC`
  return filas.map(f => ({ venueId: f.venueId, venueName: f.venueName, tarifa: tarifaDe(f, 'venue') }))
}

/**
 * Codex p12-r2 #2: antes de leer las tarifas que se confirman, toma `FOR SHARE` (lectura) de las filas activas de esa posición
 * —del negocio, de su organización y, en organización, las de los negocios que heredan—. Editar, cerrar o desactivar esas filas
 * espera a que termine este guardado. No escribe nada.
 */
async function sostenerTarifas(db: Cliente, objetivo: Objetivo, organizationId: string, slot: Posicion, otraOrganizacion?: string) {
  const orgs = otraOrganizacion ? [organizationId, otraOrganizacion] : [organizationId]
  if ('venueId' in objetivo) {
    await db.$queryRaw`SELECT id FROM "VenuePricingStructure" WHERE "venueId" = ${objetivo.venueId}
      AND "accountType"::text = ${slot} AND active FOR SHARE`
  } else {
    await db.$queryRaw`SELECT vps.id FROM "VenuePricingStructure" vps JOIN "Venue" v ON v.id = vps."venueId"
      WHERE v."organizationId" = ${organizationId} AND vps."accountType"::text = ${slot} AND vps.active FOR SHARE OF vps`
  }
  await db.$queryRaw`SELECT id FROM "OrganizationPricingStructure" WHERE "organizationId" IN (${Prisma.join(orgs)})
    AND "accountType"::text = ${slot} AND active FOR SHARE`
}

/** La huella que la pantalla devuelve al confirmar: cambia si cambia cualquier tarifa que quedaría (incluso editada en su fila). */
export function huellaDeTarifa(tarifa: Tarifa | null, propias: TarifaPropia[] = []): string {
  if (!tarifa && !propias.length) return SIN_TARIFA
  const partes = [tarifa ? `${tarifa.source}:${tarifa.id}:${tarifa.updatedAt.toISOString()}` : SIN_TARIFA]
  for (const p of [...propias].sort((a, b) => a.venueId.localeCompare(b.venueId))) {
    partes.push(`venue:${p.venueId}:${p.tarifa.id}:${p.tarifa.updatedAt.toISOString()}`)
  }
  return createHash('sha256').update(partes.join('|')).digest('hex').slice(0, 32)
}

/** Negocios cuyas posiciones cambian: el negocio, o los de la organización que no tienen configuración propia. */
function negociosAfectados(objetivo: Objetivo): Prisma.VenueWhereInput {
  return 'venueId' in objetivo ? { id: objetivo.venueId } : { organizationId: objetivo.organizationId, paymentConfig: { is: null } }
}

/** Terminales de cobro que heredan las posiciones (sin asignación propia, no retiradas), por marca. */
export async function terminalesQueHeredan(db: Cliente, objetivo: Objetivo): Promise<{ total: number; byBrand: Record<string, number> }> {
  const grupos = await db.terminal.groupBy({
    by: ['brand'],
    where: {
      venue: negociosAfectados(objetivo),
      assignedMerchantIds: { isEmpty: true },
      status: { not: 'RETIRED' },
      type: { in: [...TIPOS_DE_TERMINAL_DE_COBRO] },
    },
    _count: { _all: true },
  })
  const byBrand: Record<string, number> = {}
  let total = 0
  for (const g of grupos) {
    const marca = (g.brand ?? '').trim().toUpperCase() || 'SIN MARCA'
    byBrand[marca] = (byBrand[marca] ?? 0) + g._count._all
    total += g._count._all
  }
  return { total, byBrand }
}

/** Cuántas terminales heredadas NO pueden usar una cuenta de ese procesador (PAX con AngelPay, Nexgo con Blumon). */
export function terminalesDeOtroProcesador(providerCode: string | null | undefined, byBrand: Record<string, number>): number {
  const compatibles = providerCode ? PROVIDER_DEVICE_COMPATIBILITY[providerCode] : undefined
  if (!compatibles?.length) return 0
  return Object.entries(byBrand).reduce((n, [marca, c]) => (marca === 'SIN MARCA' || compatibles.includes(marca) ? n : n + c), 0)
}

type Cuenta = { id: string | null; name: string; providerCode: string | null }

async function describirCuentas(db: Cliente, ids: Array<string | null | undefined>): Promise<Map<string, Cuenta>> {
  const reales = [...new Set(ids.filter((id): id is string => !!id && id !== CUENTA_NUEVA))]
  if (!reales.length) return new Map()
  const filas = await db.merchantAccount.findMany({
    where: { id: { in: reales } },
    select: { id: true, displayName: true, alias: true, externalMerchantId: true, provider: { select: { code: true } } },
    take: reales.length,
  })
  return new Map(
    filas.map(f => [f.id, { id: f.id, name: f.displayName ?? f.alias ?? f.externalMerchantId, providerCode: f.provider?.code ?? null }]),
  )
}

export type Revision = {
  objetivo: Objetivo
  /** Cuenta efectiva que tendrá cada posición después de guardar. `undefined` = esa posición no cambia. */
  siguiente: Partial<Record<Posicion, string | null>>
  confirmaciones?: ConfirmacionDePosiciones
  /** El escritor ya rechaza una posición ocupada de la configuración PROPIA (sólo llena vacías o compara la reemplazada). */
  cuentaAnteriorYaVerificada?: boolean
  /** Posiciones cuya tarifa captura el mismo escritor en esta petición (AngelPay `pricing`, Blumon `venuePricing`, KYC). */
  tarifaCapturada?: Posicion[]
  /** Traslado: la organización a la que pasa el negocio (cambia sus cuentas heredadas y su tarifa de respaldo). */
  organizacionDespues?: string
  /** La cuenta nueva la calcula el SERVIDOR (borrar la configuración propia, traslado): se exige `nextAccountId`. */
  siguienteCalculado?: boolean
  /** Revisión previa, antes de escribir nada y fuera de transacción: no toma candados. */
  soloRevisar?: boolean
}

/**
 * Exige las confirmaciones. Llamar DENTRO de la transacción que escribe la configuración (o con `soloRevisar`, antes de
 * escribir nada). No escribe; devuelve los cambios confirmados para el registro de actividad.
 */
export async function exigirConfirmacionDePosiciones(db: Cliente, revision: Revision): Promise<CambioDePosicion[]> {
  const { objetivo, siguiente, confirmaciones, organizacionDespues } = revision
  const bloquear = !revision.soloRevisar
  const {
    cuentas: actuales,
    organizationId,
    negocioConConfigPropia,
  } = await leerCuentasActuales(db, objetivo, bloquear, organizacionDespues)
  const ahora = new Date()

  const revisar: Array<{
    slot: Posicion
    desde: string | null
    hacia: string | null
    cambiaCuenta: boolean
    tarifa: Tarifa | null
    propias: TarifaPropia[]
  }> = []
  for (const slot of POSICIONES) {
    const hacia = siguiente[slot] === undefined ? actuales[slot] : (siguiente[slot] ?? null)
    const desde = actuales[slot]
    const cambiaCuenta = hacia !== desde
    if (!cambiaCuenta && !organizacionDespues) continue
    if (bloquear) await sostenerTarifas(db, objetivo, organizationId, slot, organizacionDespues)
    const tarifa = await tarifaQueQuedaria(db, objetivo, slot, ahora, organizacionDespues)
    if (!cambiaCuenta) {
      // Traslado sin cambio de cuenta: sólo importa si cambia la tarifa que quedaría.
      const antes = await tarifaQueQuedaria(db, objetivo, slot, ahora)
      if (hacia === null || huellaDeTarifa(antes) === huellaDeTarifa(tarifa)) continue
    }
    const propias =
      'organizationId' in objetivo && cambiaCuenta ? await tarifasPropiasDeLosQueHeredan(db, objetivo.organizationId, slot, ahora) : []
    revisar.push({ slot, desde, hacia, cambiaCuenta, tarifa, propias })
  }
  if (!revisar.length) return []

  const terminales = await terminalesQueHeredan(db, objetivo)
  const cuentas = await describirCuentas(
    db,
    revisar.flatMap(r => [r.desde, r.hacia]),
  )
  const describir = (id: string | null): Cuenta | null =>
    id === null
      ? null
      : id === CUENTA_NUEVA
        ? { id: null, name: 'Cuenta nueva', providerCode: null }
        : (cuentas.get(id) ?? { id, name: id, providerCode: null })

  let hayConflicto = false
  let faltaAlgo = false
  const cambios: CambioDePosicion[] = []
  const posiciones: unknown[] = []

  for (const { slot, desde, hacia, cambiaCuenta, tarifa, propias } of revisar) {
    const conf = confirmaciones?.[slot]
    const huella = huellaDeTarifa(tarifa, propias)
    const capturada = revision.tarifaCapturada?.includes(slot) ?? false
    // El escritor que sólo llena vacías ya verificó la cuenta anterior de la configuración PROPIA; una cuenta heredada de la
    // organización (que crear la propia quita) sí la tiene que confirmar la pantalla (Codex p12-r1 #3).
    const pideCuentaAnterior =
      cambiaCuenta && !(revision.cuentaAnteriorYaVerificada && ('organizationId' in objetivo || negocioConConfigPropia || desde === null))
    const pideTarifa = hacia !== null && (desde !== null || tarifa !== null || propias.length > 0) && !capturada
    const pideTerminales = cambiaCuenta && desde !== null && terminales.total > 0

    const pideCuentaNueva = cambiaCuenta && !!revision.siguienteCalculado
    const problemas: string[] = []
    if (conf?.previousAccountId !== undefined && (conf.previousAccountId ?? null) !== desde) problemas.push('CUENTA_CAMBIO')
    else if (pideCuentaAnterior && conf?.previousAccountId === undefined) problemas.push('FALTA_CUENTA_ANTERIOR')
    if (pideCuentaNueva) {
      if (conf?.nextAccountId === undefined) problemas.push('FALTA_CUENTA_NUEVA')
      else if ((conf.nextAccountId ?? null) !== hacia) problemas.push('CUENTA_NUEVA_CAMBIO')
    }
    if (pideTarifa) {
      if (!conf?.rate) problemas.push('FALTA_TARIFA')
      else if (conf.rate.fingerprint !== huella) problemas.push('TARIFA_CAMBIO')
    }
    if (pideTerminales) {
      if (conf?.inheritingTerminals === undefined) problemas.push('FALTA_TERMINALES')
      else if (conf.inheritingTerminals !== terminales.total) problemas.push('TERMINALES_CAMBIARON')
    }
    if (problemas.some(p => !p.startsWith('FALTA_'))) hayConflicto = true
    if (problemas.length) faltaAlgo = true

    const proveedorQueSale = desde ? cuentas.get(desde)?.providerCode : null
    posiciones.push({
      slot,
      label: NOMBRE_DE_POSICION[slot],
      accountChanges: cambiaCuenta,
      currentAccount: describir(desde),
      nextAccount: describir(hacia),
      pricing: tarifa,
      pricingFingerprint: huella,
      ...('organizationId' in objetivo && {
        venuesWithOwnRate: {
          total: propias.length,
          sample: propias.slice(0, NEGOCIOS_A_DESCRIBIR).map(p => ({ venueId: p.venueId, venueName: p.venueName, pricing: p.tarifa })),
        },
      }),
      inheritingTerminals: {
        total: terminales.total,
        byBrand: terminales.byBrand,
        losingAccount: desde && cambiaCuenta ? terminales.total - terminalesDeOtroProcesador(proveedorQueSale, terminales.byBrand) : 0,
      },
      needs: {
        previousAccountId: pideCuentaAnterior,
        nextAccountId: pideCuentaNueva,
        rate: pideTarifa,
        inheritingTerminals: pideTerminales,
      },
      problems: problemas,
    })
    cambios.push({
      slot,
      from: desde,
      to: hacia,
      rate: capturada ? 'CAPTURADA' : pideTarifa ? 'KEEP' : 'NO_APLICA',
      pricingId: tarifa?.id ?? null,
      inheritingTerminals: terminales.total,
    })
  }

  const details = { target: objetivo, positions: posiciones }
  if (hayConflicto) {
    throw new ConflictError(
      'Alguien cambió la configuración de cobro o su tarifa mientras tenías la pantalla abierta. Recarga y vuelve a intentarlo.',
      POSICION_DESACTUALIZADA,
      details,
    )
  }
  if (faltaAlgo) {
    throw new BadRequestError(
      'Antes de guardar, confirma la tarifa que tendrá la cuenta y las terminales que usan esta posición.',
      CONFIRMAR_POSICION,
      details,
    )
  }
  return cambios
}
