/**
 * Planes editables (B1): la oferta de los planes como VERSIONES inmutables.
 *
 * Una versión dice, por plan, su nombre, si está en venta, si la prueba pide tarjeta, cuántos días dura y el precio mensual
 * y anual (sin IVA, con IVA y el `priceId` de Stripe de cada uno). Un solo puntero (`PlanOfferPointer`, `id = 'vigente'`)
 * dice cuál rige. Diseño: «Planes editables», §10-§15 (docs del workspace).
 *
 * 🔴 Tres reglas que no se negocian aquí:
 * 1. **Sin versión, el respaldo.** Sin puntero o sin vigente, la oferta es lo de hoy (las constantes de
 *    `planPricing.constants.ts`), con el número 1. Eso es exactamente B0.
 * 2. **Una versión guardada rota es un 503, nunca el respaldo.** Si la vigente no pasa el esquema, cobrar «lo de hoy» encima
 *    de una oferta publicada cobraría otro precio del que se anunció. Se detiene todo con `PLAN_NOT_CONFIGURED`.
 * 3. **La v1 no cambia el camino del cobro.** La v1 es una foto de lo de hoy; con ella (o sin versiones) se sigue cobrando
 *    por la llave del plan, como B0. Sólo una versión publicada por el editor (número 2 o más) cobra con sus `priceId`:
 *    eso es `versionQueCobra()`.
 *
 * 🔴 Sin caché: cada lectura va a la base. El precio que se cobra no puede venir de una copia vieja en memoria.
 *
 * Dinero: centavos enteros CON IVA (excepción declarada de `critical-warnings.md`: cada uno ES un `unit_amount` de Stripe).
 */
import { z } from 'zod'
import type { PlanOfferVersionStatus, Prisma, PrismaClient } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import AppError, { ConflictError, NotFoundError } from '../../errors/AppError'
import { STANDARD_PLAN_GROSS_CENTS, STANDARD_PLAN_NET_CENTS, TRIAL_DAYS } from '../access/planPricing.constants'

export type PlanPagado = 'PRO' | 'PREMIUM'
export type Periodicidad = 'monthly' | 'annual'
/** El `Feature.code` del plan pagado (el de las filas de `VenueFeature` y de `PlanTierCode`). */
export function codigoDelPlan(tier: PlanPagado): 'PLAN_PRO' | 'PLAN_PREMIUM' {
  return tier === 'PRO' ? 'PLAN_PRO' : 'PLAN_PREMIUM'
}

export const MENSAJE_PLAN_NO_CONFIGURADO =
  'No pudimos activar tu plan por un problema nuestro de configuración. No se te cobró nada. Escríbenos y lo resolvemos.'

export type Ranura = `${PlanPagado}:${Periodicidad}`

type Db = Prisma.TransactionClient | PrismaClient

const PLANES_PAGADOS: readonly PlanPagado[] = ['PRO', 'PREMIUM']
const PERIODICIDADES: readonly Periodicidad[] = ['monthly', 'annual']
const CAMPO_DEL_NETO: Record<Periodicidad, 'monthlyNetCents' | 'annualNetCents'> = {
  monthly: 'monthlyNetCents',
  annual: 'annualNetCents',
}

/** El renglón único del puntero. */
const PUNTERO_ID = 'vigente'

// ---------------------------------------------------------------------------------------------------------------------
// El dinero
// ---------------------------------------------------------------------------------------------------------------------

/** Mínimo de Stripe para un precio: $10.00 con IVA. */
export const BRUTO_MINIMO_CENTS = 1000
/** Máximo del híbrido para un precio: $100,000.00 con IVA. */
export const BRUTO_MAXIMO_CENTS = 10_000_000

/**
 * El precio con IVA (16 %) de un neto, en centavos. 🔴 Numerador entero: `netCents * 116` es exacto en un `number`;
 * `netCents * 1.16` no lo es (99999 × 1.16 = 115998.83999…).
 */
export function brutoDeNeto(netCents: number): number {
  return Math.round((netCents * 116) / 100)
}

// ---------------------------------------------------------------------------------------------------------------------
// Las formas
// ---------------------------------------------------------------------------------------------------------------------

export interface PrecioDeLaVersion {
  netCents: number
  grossCents: number
  stripePriceId: string | null
}

export interface PlanPagadoDeLaVersion {
  displayName: string
  onSale: boolean
  requiresCard: boolean
  trialDays: number
  monthly: PrecioDeLaVersion
  annual: PrecioDeLaVersion
  /** El nombre que el producto de Stripe debe llevar. `null` = el que ya tenga (la v1 no renombra nada). */
  stripeProductName: string | null
}

export interface PlanOfferDefinition {
  schemaVersion: 1
  FREE: { displayName: string }
  PRO: PlanPagadoDeLaVersion
  PREMIUM: PlanPagadoDeLaVersion
}

export interface EntradaDelPlan {
  displayName: string
  onSale: boolean
  requiresCard: boolean
  trialDays: number
  monthlyNetCents: number
  annualNetCents: number
}

/** Lo que escribe el founder: precios SIN IVA. FREE sólo tiene nombre. */
export interface PlanOfferInput {
  FREE: { displayName: string }
  PRO: EntradaDelPlan
  PREMIUM: EntradaDelPlan
}

const CAMPO_DESCONOCIDO = 'Trae un campo que no se conoce.'
const mayuscula = (campo: string) => `${campo[0].toUpperCase()}${campo.slice(1)}`
const texto = (campo: string) => z.string({ required_error: `Falta ${campo}.`, invalid_type_error: `${mayuscula(campo)} debe ser texto.` })
const siNo = (campo: string) =>
  z.boolean({ required_error: `Falta ${campo}.`, invalid_type_error: `${mayuscula(campo)} debe ser sí o no.` })
const centavos = (campo: string) =>
  z
    .number({ required_error: `Falta ${campo}.`, invalid_type_error: `${mayuscula(campo)} debe ser un número.` })
    .int(`${mayuscula(campo)} debe ser un número entero de centavos.`)
    .positive(`${mayuscula(campo)} debe ser mayor que cero.`)
const dias = () =>
  z
    .number({ required_error: 'Faltan los días de prueba.', invalid_type_error: 'Los días de prueba deben ser un número.' })
    .int('Los días de prueba deben ser un número entero.')
    .min(0, 'Los días de prueba no pueden ser negativos.')

const precioGuardado = z
  .object({
    netCents: centavos('el precio sin IVA'),
    grossCents: centavos('el precio con IVA'),
    stripePriceId: texto('el precio de Stripe').min(1, 'El precio de Stripe no puede estar vacío.').nullable(),
  })
  .strict(CAMPO_DESCONOCIDO)

const planGuardado = z
  .object({
    displayName: texto('el nombre').min(1, 'El nombre no puede estar vacío.'),
    onSale: siNo('si está en venta'),
    requiresCard: siNo('si pide tarjeta'),
    trialDays: dias(),
    monthly: precioGuardado,
    annual: precioGuardado,
    stripeProductName: texto('el nombre del producto').min(1, 'El nombre del producto no puede estar vacío.').nullable(),
  })
  .strict(CAMPO_DESCONOCIDO)
  .superRefine((plan, ctx) => {
    // 🔴 El bruto se cobra y el neto se anuncia: si no son el mismo precio, la versión miente y no se vende con ella.
    for (const periodicidad of PERIODICIDADES) {
      if (plan[periodicidad].grossCents !== brutoDeNeto(plan[periodicidad].netCents)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [periodicidad, 'grossCents'],
          message: 'El precio con IVA no corresponde al precio sin IVA.',
        })
      }
    }
  })

/** La definición GUARDADA de una versión (lo que vive en `PlanOfferVersion.definition`). */
export const planOfferDefinition: z.ZodType<PlanOfferDefinition> = z
  .object({
    schemaVersion: z.literal(1, { errorMap: () => ({ message: 'Versión de formato desconocida.' }) }),
    FREE: z.object({ displayName: texto('el nombre').min(1, 'El nombre no puede estar vacío.') }).strict(CAMPO_DESCONOCIDO),
    PRO: planGuardado,
    PREMIUM: planGuardado,
  })
  .strict(CAMPO_DESCONOCIDO)

const entradaDelPlan = z
  .object({
    displayName: texto('el nombre'),
    onSale: siNo('si está en venta'),
    requiresCard: siNo('si pide tarjeta'),
    trialDays: dias(),
    monthlyNetCents: centavos('el precio mensual sin IVA'),
    annualNetCents: centavos('el precio anual sin IVA'),
  })
  .strict(CAMPO_DESCONOCIDO)

/** La ENTRADA del founder (forma; las reglas de negocio las dice `problemasDeLaOferta`). */
export const planOfferInput: z.ZodType<PlanOfferInput> = z
  .object({
    FREE: z.object({ displayName: texto('el nombre') }).strict(CAMPO_DESCONOCIDO),
    PRO: entradaDelPlan,
    PREMIUM: entradaDelPlan,
  })
  .strict(CAMPO_DESCONOCIDO)

// ---------------------------------------------------------------------------------------------------------------------
// Las reglas de la oferta
// ---------------------------------------------------------------------------------------------------------------------

// La regla del diseño, literal (el `\-` no hace falta, pero así se lee igual que en el plan).
// eslint-disable-next-line no-useless-escape
const NOMBRE_VALIDO = /^[\p{L}\p{N}][\p{L}\p{N} .+\-]*$/u

/**
 * Lo que está mal en una entrada (vacío = se puede publicar). Cada problema lleva la ruta del campo, para que la pantalla
 * lo pinte junto a él.
 * - Prueba: con tarjeta, 0 días (paga hoy) o de 10 a 90 (así siempre hay un aviso previo del job diario); sin tarjeta, de
 *   1 a 90.
 * - Precio: con IVA, entre $10.00 (mínimo de Stripe) y $100,000.00 (máximo del híbrido), en cada periodicidad.
 * - Nombres: recortados, de 2 a 24 caracteres, letras, números, espacios y `. + -` (empezando con letra o número), y los
 *   tres distintos sin importar mayúsculas (el repetido se señala en el segundo).
 */
export function problemasDeLaOferta(entrada: PlanOfferInput): { path: string; message: string }[] {
  const problemas: { path: string; message: string }[] = []

  const vistos = new Set<string>()
  for (const plan of ['FREE', 'PRO', 'PREMIUM'] as const) {
    const path = `${plan}.displayName`
    const nombre = entrada[plan].displayName.trim()
    const largo = [...nombre].length
    if (largo < 2 || largo > 24) {
      problemas.push({ path, message: 'El nombre debe tener de 2 a 24 caracteres.' })
      continue
    }
    if (!NOMBRE_VALIDO.test(nombre)) {
      problemas.push({
        path,
        message: 'El nombre sólo lleva letras, números, espacios y los signos . + - , y empieza con una letra o un número.',
      })
      continue
    }
    const clave = nombre.toLocaleLowerCase('es-MX')
    if (vistos.has(clave)) problemas.push({ path, message: `Ya hay otro plan que se llama «${nombre}».` })
    vistos.add(clave)
  }

  for (const plan of PLANES_PAGADOS) {
    const { requiresCard, trialDays } = entrada[plan]
    const diasValidos = requiresCard ? trialDays === 0 || (trialDays >= 10 && trialDays <= 90) : trialDays >= 1 && trialDays <= 90
    if (!Number.isInteger(trialDays) || !diasValidos) {
      problemas.push({
        path: `${plan}.trialDays`,
        message: requiresCard
          ? 'Con tarjeta, la prueba es de 0 días (paga hoy) o de 10 a 90 días.'
          : 'Sin tarjeta, la prueba es de 1 a 90 días.',
      })
    }
    for (const periodicidad of PERIODICIDADES) {
      const campo = CAMPO_DEL_NETO[periodicidad]
      const neto = entrada[plan][campo]
      const bruto = brutoDeNeto(neto)
      if (!Number.isInteger(neto) || neto <= 0 || bruto < BRUTO_MINIMO_CENTS || bruto > BRUTO_MAXIMO_CENTS) {
        problemas.push({ path: `${plan}.${campo}`, message: 'Con IVA, el precio debe quedar entre $10.00 y $100,000.00.' })
      }
    }
  }

  return problemas
}

/** El nombre del producto de Stripe de un plan con ese nombre visible. */
export function nombreDelProductoEnStripe(displayName: string): string {
  return `Plan Avoqado ${displayName}`
}

// ---------------------------------------------------------------------------------------------------------------------
// El respaldo y la vigente
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Lo de hoy, como definición: Gratis / Pro / Premium, en venta, con tarjeta, `TRIAL_DAYS` días y los montos de las
 * constantes. Sin `priceId` (sin versión se cobra por la llave) y sin nombre propio del producto.
 *
 * Una COPIA nueva en cada llamada: nadie puede dejar el precio del proceso en otro número mutando lo que recibió.
 */
export function ofertaDeRespaldo(): PlanOfferDefinition {
  const plan = (tier: PlanPagado, displayName: string): PlanPagadoDeLaVersion => ({
    displayName,
    onSale: true,
    requiresCard: true,
    trialDays: TRIAL_DAYS,
    monthly: { netCents: STANDARD_PLAN_NET_CENTS[tier].monthly, grossCents: STANDARD_PLAN_GROSS_CENTS[tier].monthly, stripePriceId: null },
    annual: { netCents: STANDARD_PLAN_NET_CENTS[tier].annual, grossCents: STANDARD_PLAN_GROSS_CENTS[tier].annual, stripePriceId: null },
    stripeProductName: null,
  })
  return { schemaVersion: 1, FREE: { displayName: 'Gratis' }, PRO: plan('PRO', 'Pro'), PREMIUM: plan('PREMIUM', 'Premium') }
}

export interface OfertaVigente {
  number: number
  /** `null` = el respaldo (no hay versión). */
  versionId: string | null
  definition: PlanOfferDefinition
  respaldo: boolean
}

const MENSAJE_OFERTA_ROTA =
  'Los planes no están disponibles por un problema nuestro de configuración. No se cobró nada. Escríbenos y lo resolvemos.'

function ofertaRota(versionId: string, motivo: string): AppError {
  // 🚨 a propósito: la oferta guardada no se puede leer y nadie puede comprar un plan hasta corregirla.
  logger.error('🚨 planOffer: la versión de la oferta guardada no es válida — NO se vende con ella', { versionId, motivo })
  return new AppError(MENSAJE_OFERTA_ROTA, 503, true, 'PLAN_NOT_CONFIGURED', { versionId })
}

/**
 * ¿Es el 503 de `ofertaRota` (la oferta guardada no se puede leer, con el `versionId` que falló)? Lo distingue del 503 del mismo
 * código que da una llave sin precio en Stripe (B0, `details.tierCode`): Codex b2-code r4 #10, el alta larga deja salir sólo éste.
 */
export function esOfertaIlegible(error: unknown): boolean {
  return (
    error instanceof AppError &&
    error.code === 'PLAN_NOT_CONFIGURED' &&
    typeof (error.details as { versionId?: unknown } | undefined)?.versionId === 'string'
  )
}

function leerDefinicion(versionId: string, definition: unknown): PlanOfferDefinition {
  const r = planOfferDefinition.safeParse(definition)
  if (!r.success) throw ofertaRota(versionId, r.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '))
  return r.data
}

/** El número de una versión publicada: entero, 1 o más (una en preparación no tiene). */
const esNumeroDeVersion = (number: number | null): number is number => Number.isInteger(number) && (number as number) >= 1

/**
 * La oferta que rige AHORA. Sin puntero o sin vigente → el respaldo con número 1. Una vigente que no pasa el esquema (o que
 * no está publicada con su número) → 503 `PLAN_NOT_CONFIGURED`, nunca el respaldo. Sin caché.
 */
export async function ofertaVigente(db: Db = prisma): Promise<OfertaVigente> {
  const puntero = await db.planOfferPointer.findUnique({
    where: { id: PUNTERO_ID },
    select: { currentVersion: { select: { id: true, number: true, status: true, definition: true } } },
  })
  const version = puntero?.currentVersion
  if (!version) return { number: 1, versionId: null, definition: ofertaDeRespaldo(), respaldo: true }
  if (version.status !== 'PUBLISHED' || !esNumeroDeVersion(version.number)) {
    throw ofertaRota(version.id, `la vigente está ${version.status} con número ${version.number ?? 'null'}`)
  }
  return {
    number: version.number,
    versionId: version.id,
    definition: leerDefinicion(version.id, version.definition),
    respaldo: false,
  }
}

/**
 * El número de la versión que rige, leído SÓLO del puntero: sin leer ni validar su definición, sin Stripe. Sin vigente, 1 (el
 * respaldo, como `ofertaVigente`). `null`: la vigente no tiene un número válido (no se sabe cuál rige).
 *
 * Para quien tiene que decidir qué hacer cuando `ofertaVigente`/`versionQueCobra` lanzan (B2 Task 8): con la v1, la foto de hoy,
 * un camino que hoy no lee la oferta sigue igual; con una versión del editor (2 o más) falla cerrado.
 */
export async function numeroDeLaVigente(db: Db = prisma): Promise<number | null> {
  const puntero = await db.planOfferPointer.findUnique({
    where: { id: PUNTERO_ID },
    select: { currentVersion: { select: { number: true } } },
  })
  const version = puntero?.currentVersion
  if (!version) return 1
  return esNumeroDeVersion(version.number) ? version.number : null
}

/** Una versión por su id (también una en preparación, que no tiene número). */
export async function ofertaPorId(
  versionId: string,
  db: Db = prisma,
): Promise<{ number: number | null; status: PlanOfferVersionStatus; definition: PlanOfferDefinition }> {
  const version = await db.planOfferVersion.findUnique({
    where: { id: versionId },
    select: { id: true, number: true, status: true, definition: true },
  })
  if (!version) throw new NotFoundError('No encontramos esa versión de los planes.', 'PLAN_OFFER_NOT_FOUND', { versionId })
  return { number: version.number, status: version.status, definition: leerDefinicion(version.id, version.definition) }
}

/**
 * La versión `PUBLISHED` o `SUPERSEDED` con ese número (la que un comprobante o una compra ya aceptada cita). Otra cosa
 * (inexistente, en preparación o descartada) → 404 `PLAN_OFFER_NOT_FOUND`; una definición rota → el 503 de `leerDefinicion`.
 */
export async function ofertaPorNumero(number: number, db: Db = prisma): Promise<OfertaVigente> {
  const version = await db.planOfferVersion.findFirst({
    where: { number, status: { in: ['PUBLISHED', 'SUPERSEDED'] } },
    select: { id: true, number: true, status: true, definition: true },
  })
  if (!version) throw new NotFoundError('No encontramos esa versión de los planes.', 'PLAN_OFFER_NOT_FOUND', { number })
  return { number, versionId: version.id, definition: leerDefinicion(version.id, version.definition), respaldo: false }
}

/** La ranura de precio de un plan y una periodicidad. */
export function precioDeLaOferta(definition: PlanOfferDefinition, tier: PlanPagado, interval: Periodicidad): PrecioDeLaVersion {
  return definition[tier][interval]
}

/**
 * La vigente **sólo si la publicó el editor** (número 2 o más). Con la v1 o sin versiones, `null`: la v1 es una foto de lo
 * de hoy y no cambia el camino del cobro, que sigue por la llave como B0.
 */
export async function versionQueCobra(db: Db = prisma): Promise<OfertaVigente | null> {
  const vigente = await ofertaVigente(db)
  return vigente.respaldo || vigente.number < 2 ? null : vigente
}

/**
 * El `priceId` con el que cobra hoy esa ranura, leído SÓLO de la base (no toca Stripe). `null` = no hay `versionQueCobra()`
 * (se cobra por la llave). Una versión del editor publicada sin el precio de esa ranura es un 503: no se confunde con
 * «sin versión».
 */
export async function priceIdVigente(tier: PlanPagado, interval: Periodicidad): Promise<string | null> {
  const version = await versionQueCobra()
  if (!version) return null
  const { stripePriceId } = precioDeLaOferta(version.definition, tier, interval)
  if (!stripePriceId) throw ofertaRota(version.versionId as string, `la vigente no trae el precio de ${tier}:${interval}`)
  return stripePriceId
}

// ---------------------------------------------------------------------------------------------------------------------
// De la entrada a la definición, y de vuelta
// ---------------------------------------------------------------------------------------------------------------------

/**
 * La definición nueva a partir de lo que escribió el founder y de la vigente:
 * - el bruto se calcula (`brutoDeNeto`);
 * - una ranura cuyo bruto NO cambió conserva el `stripePriceId` de la vigente; la que cambió queda `null` (su precio nuevo
 *   lo crea la publicación);
 * - el nombre del producto se hereda si el nombre visible no cambió, y se arma si cambió.
 */
export function definicionDesdeEntrada(entrada: PlanOfferInput, vigente: PlanOfferDefinition): PlanOfferDefinition {
  const plan = (tier: PlanPagado): PlanPagadoDeLaVersion => {
    const e = entrada[tier]
    const v = vigente[tier]
    const displayName = e.displayName.trim()
    const ranura = (periodicidad: Periodicidad): PrecioDeLaVersion => {
      const netCents = e[CAMPO_DEL_NETO[periodicidad]]
      const grossCents = brutoDeNeto(netCents)
      return { netCents, grossCents, stripePriceId: grossCents === v[periodicidad].grossCents ? v[periodicidad].stripePriceId : null }
    }
    return {
      displayName,
      onSale: e.onSale,
      requiresCard: e.requiresCard,
      trialDays: e.trialDays,
      monthly: ranura('monthly'),
      annual: ranura('annual'),
      stripeProductName: displayName === v.displayName ? v.stripeProductName : nombreDelProductoEnStripe(displayName),
    }
  }
  return { schemaVersion: 1, FREE: { displayName: entrada.FREE.displayName.trim() }, PRO: plan('PRO'), PREMIUM: plan('PREMIUM') }
}

/** Lo que el editor muestra para editar una definición: los netos, sin IVA ni `priceId`. */
export function entradaDesdeDefinicion(definition: PlanOfferDefinition): PlanOfferInput {
  const plan = (tier: PlanPagado): EntradaDelPlan => {
    const p = definition[tier]
    return {
      displayName: p.displayName,
      onSale: p.onSale,
      requiresCard: p.requiresCard,
      trialDays: p.trialDays,
      monthlyNetCents: p.monthly.netCents,
      annualNetCents: p.annual.netCents,
    }
  }
  return { FREE: { displayName: definition.FREE.displayName }, PRO: plan('PRO'), PREMIUM: plan('PREMIUM') }
}

/** Las ranuras cuyo precio con IVA cambia (las que necesitan un precio nuevo en Stripe), en orden fijo. */
export function ranurasQueCambian(nueva: PlanOfferDefinition, vigente: PlanOfferDefinition): Ranura[] {
  const cambian: Ranura[] = []
  for (const tier of PLANES_PAGADOS) {
    for (const periodicidad of PERIODICIDADES) {
      if (nueva[tier][periodicidad].grossCents !== vigente[tier][periodicidad].grossCents) cambian.push(`${tier}:${periodicidad}`)
    }
  }
  return cambian
}

// ---------------------------------------------------------------------------------------------------------------------
// El candado y la negativa de los escritores viejos
// ---------------------------------------------------------------------------------------------------------------------

/**
 * El candado de publicar. 🔴 Orden fijo: primero éste y luego los de producto (`precio:PLAN:PREMIUM`, `precio:PLAN:PRO`),
 * nunca al revés. Ninguna llamada a Stripe ocurre con él tomado.
 */
export const CANDADO_DE_LA_OFERTA = 'plan-offer-publish'

export async function tomarCandadoDeLaOferta(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${CANDADO_DE_LA_OFERTA}))`
}

/** ¿Ya hay una versión vigente (la v1 sembrada o una del editor)? */
export async function existeVersionDeLaOferta(db: Db = prisma): Promise<boolean> {
  const puntero = await db.planOfferPointer.findUnique({ where: { id: PUNTERO_ID }, select: { currentVersionId: true } })
  return Boolean(puntero?.currentVersionId)
}

/**
 * Los escritores viejos de los planes (scripts de sembrado, listas `PLAN:*`) se niegan en cuanto existe una versión: desde
 * entonces el precio de un plan sólo cambia publicando. Con `db`, lee dentro de esa transacción (después de sus candados).
 */
export async function exigirSinVersionDeLaOferta(contexto: string, db?: Prisma.TransactionClient): Promise<void> {
  if (!(await existeVersionDeLaOferta(db ?? prisma))) return
  throw new ConflictError('Los planes ya se publican desde «Planes» en el SUPERADMIN', 'PLAN_OFFER_OWNS_PLAN_LISTS', { contexto })
}
