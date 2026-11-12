/**
 * Candado al cambiar la cuenta de una posición (PRIMARY / SECONDARY / TERTIARY) — tarifa al comercio, paso 1 (12-nov-2026).
 * Promesa: `docs/audit/2026-11-12-tarifa-por-cuenta/promesa-pasos-1-y-2.md` del workspace.
 *
 * La tarifa que Avoqado cobra vive en la POSICIÓN, no en la cuenta: si alguien cambia la cuenta de una posición, la cuenta
 * nueva hereda la tarifa vieja sin que nadie la vea. Este módulo es el ÚNICO lugar donde los escritores de posiciones exigen,
 * dentro de su transacción de guardado:
 *   1. la cuenta que vio la pantalla (`previousAccountId`): si ya cambió ⇒ 409 (pantalla vieja);
 *   2. la tarifa que quedaría, confirmada: la misma (`KEEP` + su id) o una nueva (`NEW`, se AGREGA con fecha de ahora;
 *      ninguna tarifa existente se edita, se cierra ni se desactiva);
 *   3. el número de terminales que heredan las posiciones y perderían la cuenta que sale.
 * Falta algo ⇒ 400 `CONFIRMAR_POSICION` con lo que la pantalla necesita para preguntar (`details.positions`).
 *
 * 🔴 No toca el camino de cobro: sólo LEE la configuración y las tarifas con las mismas funciones que la captura al cobrar
 * (`getEffectivePricingForSlot`) y, si una persona lo confirmó, inserta una tarifa nueva.
 */
import { z } from 'zod'
import { Prisma, AccountType } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { BadRequestError, ConflictError } from '@/errors/AppError'
import { getEffectivePricingForSlot } from '@/services/organization-payment-config.service'
import { PROVIDER_DEVICE_COMPATIBILITY } from '@/lib/providerDeviceCompatibility'

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
/** La cuenta todavía no existe (asistente que la crea después de revisar): siempre distinta de la actual. */
export const CUENTA_NUEVA = '__CUENTA_NUEVA__'
/** Terminales de COBRO (las POS_* no cobran con tarjeta ni reciben cuentas). */
export const TIPOS_DE_TERMINAL_DE_COBRO = ['TPV_ANDROID', 'TPV_IOS'] as const

const tasa = z
  .number({ invalid_type_error: 'La tasa debe ser un número', required_error: 'Falta una tasa' })
  .min(0, 'La tasa no puede ser negativa')
  .max(1, 'La tasa no puede pasar de 100 %')
const montoOpcional = z.number({ invalid_type_error: 'El monto debe ser un número' }).min(0, 'El monto no puede ser negativo').nullish()

export const tarifaNuevaSchema = z.object({
  mode: z.literal('NEW'),
  debitRate: tasa,
  creditRate: tasa,
  amexRate: tasa,
  internationalRate: tasa,
  includesTax: z.boolean({
    required_error: 'Indica si las tasas ya incluyen IVA',
    invalid_type_error: 'Indica si las tasas ya incluyen IVA',
  }),
  taxRate: tasa.optional(),
  fixedFeePerTransaction: montoOpcional,
  monthlyServiceFee: montoOpcional,
})

const confirmacionSchema = z.object({
  previousAccountId: z.string({ invalid_type_error: 'Cuenta anterior inválida' }).nullable().optional(),
  rate: z
    .discriminatedUnion('mode', [
      z.object({ mode: z.literal('KEEP'), pricingId: z.string({ invalid_type_error: 'Tarifa inválida' }).nullable() }),
      tarifaNuevaSchema,
    ])
    .optional(),
  inheritingTerminals: z.number({ invalid_type_error: 'Número de terminales inválido' }).int().min(0).optional(),
})

/** Campo `positionConfirmations` de cada petición que puede cambiar una posición. */
export const confirmacionDePosicionesSchema = z
  .object({ PRIMARY: confirmacionSchema.optional(), SECONDARY: confirmacionSchema.optional(), TERTIARY: confirmacionSchema.optional() })
  .optional()
export type ConfirmacionDePosiciones = z.infer<typeof confirmacionDePosicionesSchema>

/** Para rutas sin validador de zod: valida `positionConfirmations` del cuerpo o responde 400 en español. */
export function leerConfirmaciones(crudo: unknown): ConfirmacionDePosiciones {
  const r = confirmacionDePosicionesSchema.safeParse(crudo ?? undefined)
  if (!r.success) throw new BadRequestError(`Confirmación de posiciones inválida: ${r.error.issues.map(i => i.message).join('; ')}`)
  return r.data
}

export type Objetivo = { venueId: string } | { organizationId: string }
type Cliente = Prisma.TransactionClient | typeof prisma
type Cuentas = Record<Posicion, string | null>

export type CambioDePosicion = {
  slot: Posicion
  from: string | null
  to: string | null
  rate: 'KEEP' | 'NEW' | 'CAPTURADA' | 'NO_APLICA'
  pricingId: string | null
  inheritingTerminals: number
}

/**
 * Lee las cuentas EFECTIVAS de cada posición: las del negocio si tiene configuración propia; si no, las de su organización
 * (la misma regla que `getEffectivePaymentConfig`). Con `bloquear`, deja tomadas con `FOR UPDATE` las filas de las que
 * depende la respuesta, para que dos guardados no se crucen.
 */
export async function leerCuentasActuales(
  db: Cliente,
  objetivo: Objetivo,
  bloquear: boolean,
): Promise<{ cuentas: Cuentas; organizationId: string; negocioConConfigPropia: boolean }> {
  const vacio: Cuentas = { PRIMARY: null, SECONDARY: null, TERTIARY: null }
  const deFila = (fila: { primaryAccountId: string; secondaryAccountId: string | null; tertiaryAccountId: string | null } | null) =>
    fila ? { PRIMARY: fila.primaryAccountId, SECONDARY: fila.secondaryAccountId, TERTIARY: fila.tertiaryAccountId } : vacio
  const select = { primaryAccountId: true, secondaryAccountId: true, tertiaryAccountId: true } as const

  if ('organizationId' in objetivo) {
    if (bloquear)
      await db.$queryRaw`SELECT id FROM "OrganizationPaymentConfig" WHERE "organizationId" = ${objetivo.organizationId} FOR UPDATE`
    const org = await db.organizationPaymentConfig.findUnique({ where: { organizationId: objetivo.organizationId }, select })
    return { cuentas: deFila(org), organizationId: objetivo.organizationId, negocioConConfigPropia: false }
  }
  const venue = await db.venue.findUnique({ where: { id: objetivo.venueId }, select: { organizationId: true } })
  if (!venue) throw new BadRequestError('El negocio no existe')
  if (bloquear) {
    await db.$queryRaw`SELECT id FROM "VenuePaymentConfig" WHERE "venueId" = ${objetivo.venueId} FOR UPDATE`
    await db.$queryRaw`SELECT id FROM "OrganizationPaymentConfig" WHERE "organizationId" = ${venue.organizationId} FOR UPDATE`
  }
  const propia = await db.venuePaymentConfig.findUnique({ where: { venueId: objetivo.venueId }, select })
  if (propia) return { cuentas: deFila(propia), organizationId: venue.organizationId, negocioConConfigPropia: true }
  const org = await db.organizationPaymentConfig.findUnique({ where: { organizationId: venue.organizationId }, select })
  return { cuentas: deFila(org), organizationId: venue.organizationId, negocioConConfigPropia: false }
}

/** Las cuentas de la organización (lo que hereda un negocio al quedarse sin configuración propia). */
export async function cuentasDeLaOrganizacion(db: Cliente, organizationId: string): Promise<Cuentas> {
  const org = await db.organizationPaymentConfig.findUnique({
    where: { organizationId },
    select: { primaryAccountId: true, secondaryAccountId: true, tertiaryAccountId: true },
  })
  return { PRIMARY: org?.primaryAccountId ?? null, SECONDARY: org?.secondaryAccountId ?? null, TERTIARY: org?.tertiaryAccountId ?? null }
}

type Tarifa = {
  id: string
  source: 'venue' | 'organization'
  effectiveFrom: Date
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

function tarifaDe(
  fila: {
    id: string
    effectiveFrom: Date
    debitRate: Prisma.Decimal
    creditRate: Prisma.Decimal
    amexRate: Prisma.Decimal
    internationalRate: Prisma.Decimal
    includesTax: boolean | null
    taxRate: Prisma.Decimal
    fixedFeePerTransaction: Prisma.Decimal | null
    monthlyServiceFee: Prisma.Decimal | null
  },
  source: 'venue' | 'organization',
): Tarifa {
  return {
    id: fila.id,
    source,
    effectiveFrom: fila.effectiveFrom,
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

/** La tarifa que el SERVIDOR aplicaría HOY a esa posición: la misma lectura que la captura al cobrar. */
async function tarifaVigente(db: Cliente, objetivo: Objetivo, slot: Posicion, ahora: Date): Promise<Tarifa | null> {
  if ('venueId' in objetivo) {
    const r = await getEffectivePricingForSlot(objetivo.venueId, slot as AccountType, ahora, db)
    const fila = r?.pricing[0]
    return fila ? tarifaDe(fila, r!.source) : null
  }
  const fila = await db.organizationPricingStructure.findFirst({
    where: {
      organizationId: objetivo.organizationId,
      accountType: slot as AccountType,
      active: true,
      effectiveFrom: { lte: ahora },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: ahora } }],
    },
    orderBy: [{ effectiveFrom: 'desc' }],
  })
  return fila ? tarifaDe(fila, 'organization') : null
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

type Cuenta = { id: string; name: string; providerCode: string | null }

async function describirCuentas(db: Cliente, ids: string[]): Promise<Map<string, Cuenta>> {
  const reales = [...new Set(ids.filter(id => id && id !== CUENTA_NUEVA))]
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
  confirmaciones?: ConfirmacionDePosiciones | null
  /** El escritor ya rechaza una posición ocupada (sólo llena vacías): no hace falta que la pantalla mande la cuenta anterior. */
  cuentaAnteriorYaVerificada?: boolean
  /** Posiciones cuya tarifa nueva captura el mismo escritor en esta petición (cuenta como `NEW`). */
  tarifaCapturada?: Posicion[]
  /** Sólo revisa (antes de escribir nada): no inserta tarifas ni toma candados. */
  soloRevisar?: boolean
}

/**
 * Exige y aplica las confirmaciones. Llamar DENTRO de la transacción que escribe la configuración (o con `soloRevisar`,
 * antes de empezar a escribir). Devuelve los cambios confirmados para el registro de actividad.
 */
export async function exigirConfirmacionDePosiciones(db: Cliente, revision: Revision): Promise<CambioDePosicion[]> {
  const { objetivo, siguiente, confirmaciones } = revision
  const { cuentas: actuales } = await leerCuentasActuales(db, objetivo, !revision.soloRevisar)
  const cambiadas = POSICIONES.filter(slot => siguiente[slot] !== undefined && (siguiente[slot] ?? null) !== actuales[slot])
  if (!cambiadas.length) return []

  const ahora = new Date()
  const terminales = await terminalesQueHeredan(db, objetivo)
  const cuentas = await describirCuentas(
    db,
    cambiadas.flatMap(s => [actuales[s] ?? '', siguiente[s] ?? '']),
  )

  let hayConflicto = false
  let faltaAlgo = false
  const cambios: CambioDePosicion[] = []
  const nuevas: Array<{ slot: Posicion; tarifa: z.infer<typeof tarifaNuevaSchema> }> = []
  const posiciones: unknown[] = []

  for (const slot of cambiadas) {
    const desde = actuales[slot]
    const hacia = siguiente[slot] ?? null
    const conf = confirmaciones?.[slot]
    const tarifa = await tarifaVigente(db, objetivo, slot, ahora)
    const capturada = revision.tarifaCapturada?.includes(slot) ?? false
    const pideCuentaAnterior = !revision.cuentaAnteriorYaVerificada
    const pideTarifa = hacia !== null && (desde !== null || tarifa !== null) && !capturada
    const pideTerminales = desde !== null && terminales.total > 0

    const problemas: string[] = []
    if (conf?.previousAccountId !== undefined && (conf.previousAccountId ?? null) !== desde) problemas.push('CUENTA_CAMBIO')
    else if (pideCuentaAnterior && conf?.previousAccountId === undefined) problemas.push('FALTA_CUENTA_ANTERIOR')
    if (pideTarifa) {
      if (!conf?.rate) problemas.push('FALTA_TARIFA')
      else if (conf.rate.mode === 'KEEP' && (conf.rate.pricingId ?? null) !== (tarifa?.id ?? null)) problemas.push('TARIFA_CAMBIO')
    }
    if (pideTerminales) {
      if (conf?.inheritingTerminals === undefined) problemas.push('FALTA_TERMINALES')
      else if (conf.inheritingTerminals !== terminales.total) problemas.push('TERMINALES_CAMBIARON')
    }
    if (problemas.some(p => !p.startsWith('FALTA_'))) hayConflicto = true
    if (problemas.length) faltaAlgo = true

    let venuesWithOwnRate: number | undefined
    if ('organizationId' in objetivo) {
      venuesWithOwnRate = await db.venue.count({
        where: {
          ...negociosAfectados(objetivo),
          pricingStructures: {
            some: {
              accountType: slot as AccountType,
              active: true,
              effectiveFrom: { lte: ahora },
              OR: [{ effectiveTo: null }, { effectiveTo: { gte: ahora } }],
            },
          },
        },
      })
    }
    const describir = (id: string | null): { id: string | null; name: string; providerCode: string | null } | null =>
      id === null
        ? null
        : id === CUENTA_NUEVA
          ? { id: null, name: 'Cuenta nueva', providerCode: null }
          : (cuentas.get(id) ?? { id, name: id, providerCode: null })
    posiciones.push({
      slot,
      label: NOMBRE_DE_POSICION[slot],
      currentAccount: describir(desde),
      nextAccount: describir(hacia),
      pricing: tarifa,
      inheritingTerminals: {
        ...terminales,
        losingAccount: desde ? terminales.total - terminalesDeOtroProcesador(cuentas.get(desde)?.providerCode, terminales.byBrand) : 0,
      },
      ...(venuesWithOwnRate !== undefined && { venuesWithOwnRate }),
      needs: { previousAccountId: pideCuentaAnterior, rate: pideTarifa, inheritingTerminals: pideTerminales },
      problems: problemas,
    })

    const nueva = conf?.rate?.mode === 'NEW' && hacia !== null && !capturada ? conf.rate : null
    if (nueva) nuevas.push({ slot, tarifa: nueva })
    cambios.push({
      slot,
      from: desde,
      to: hacia,
      rate: capturada ? 'CAPTURADA' : nueva ? 'NEW' : pideTarifa ? 'KEEP' : 'NO_APLICA',
      pricingId: tarifa?.id ?? null,
      inheritingTerminals: terminales.total,
    })
  }

  const details = { objetivo, positions: posiciones }
  if (hayConflicto) {
    throw new ConflictError(
      'Alguien cambió la configuración de cobro mientras tenías la pantalla abierta. Recarga y vuelve a intentarlo.',
      POSICION_DESACTUALIZADA,
      details,
    )
  }
  if (faltaAlgo) {
    throw new BadRequestError(
      'Antes de guardar, confirma la tarifa que tendrá la cuenta nueva y las terminales que usan esta posición.',
      CONFIRMAR_POSICION,
      details,
    )
  }

  if (!revision.soloRevisar) {
    for (const { slot, tarifa } of nuevas) {
      const data = {
        accountType: slot as AccountType,
        debitRate: tarifa.debitRate,
        creditRate: tarifa.creditRate,
        amexRate: tarifa.amexRate,
        internationalRate: tarifa.internationalRate,
        includesTax: tarifa.includesTax,
        ...(tarifa.taxRate !== undefined && { taxRate: tarifa.taxRate }),
        fixedFeePerTransaction: tarifa.fixedFeePerTransaction ?? null,
        monthlyServiceFee: tarifa.monthlyServiceFee ?? null,
        effectiveFrom: ahora,
        active: true,
        notes: 'Confirmada al cambiar la cuenta de la posición',
      }
      const creada =
        'venueId' in objetivo
          ? await db.venuePricingStructure.create({ data: { venueId: objetivo.venueId, ...data }, select: { id: true } })
          : await db.organizationPricingStructure.create({
              data: { organizationId: objetivo.organizationId, ...data },
              select: { id: true },
            })
      const cambio = cambios.find(c => c.slot === slot)
      if (cambio) cambio.pricingId = creada.id
    }
  }
  return cambios
}
