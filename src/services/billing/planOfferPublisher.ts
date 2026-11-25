/**
 * Planes editables (B1, Task 6): vista previa, publicar, reintentar y descartar una versión de la oferta de los planes.
 *
 * Publicar mueve DOS punteros juntos, en una sola transacción: el de la oferta (`PlanOfferPointer`) y las listas híbridas
 * `PLAN:PRO` / `PLAN:PREMIUM`. Antes, fuera de toda transacción, prepara lo que pide Stripe: los precios que cambiaron
 * (`asegurarPrecioDeLaRanura`) y las publicaciones de las listas (`prepararListaDelPlan`). Si algo falla, la versión se queda
 * `PREPARING` como la pendiente, la vigente se sigue vendiendo, y se reintenta o se descarta.
 *
 * 🔴 Reglas que no se negocian aquí:
 * 1. **Ninguna llamada a Stripe con `plan-offer-publish` tomado.** Las transacciones con ese candado son cortas y sólo tocan la base.
 * 2. **El interruptor se lee con la transacción del candado** (al empezar, al reintentar y en el movimiento): apagar toma el mismo
 *    candado, así que o confirmó antes (y aquí se ve apagado) o espera a que esto termine. Apagado → 409 `PLAN_EDIT_DISABLED`.
 * 3. **Cada escritura de la preparación toca sólo su ranura** (`jsonb_set` sobre el estado ACTUAL de la fila y `status =
 *    'PREPARING'`), nunca el JSON entero leído antes: dos reintentos encimados no se borran lo que guardó el otro, y una
 *    preparación que pierde contra un descarte no escribe nada (409 `PLAN_OFFER_STALE`). Las rutas JSON salen de tablas fijas
 *    y se mandan como parámetro; nada del usuario entra al SQL.
 * 4. **Sólo un rechazo definitivo sube el intento**, y sólo si sigue en el que se usó (CAS): un rechazo viejo no lo sube dos veces.
 *
 * No hay borrador en el SERVIDOR: se publica exactamente la `entrada` que se confirmó.
 * Dinero: centavos enteros CON IVA (excepción declarada de `critical-warnings.md`); las listas híbridas, en pesos.
 */
import type { Prisma } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import AppError, { BadRequestError, ConflictError } from '../../errors/AppError'
import { lockProducts, priceTransaction } from '../launchCampaigns/hybridProduct'
import { finalizarListaDelPlanEn, prepararListaDelPlan, soltarListaPendienteDelPlanEn } from '../launchCampaigns/hybridListPrice.service'
import { planesEditablesPrendidos } from './interruptorPlanesEditables'
import { asegurarPrecioDeLaRanura, ErrorDePreparacion, type MotivoDePreparacion } from './preciosDeLaVersion'
import {
  definicionDesdeEntrada,
  ofertaDeRespaldo,
  ofertaPorId,
  ofertaVigente,
  ranurasQueCambian,
  tomarCandadoDeLaOferta,
  type Periodicidad,
  type PlanOfferDefinition,
  type PlanPagado,
  type Ranura,
} from './planOffer'
import {
  cambiosEntre,
  desfasada,
  estadoDeLaOferta,
  exigirSinCampanas,
  mensualEnPesos,
  partes,
  PLANES,
  precioDe,
  promocionesQueRompe,
  PUNTERO_ID,
  RANURAS,
  validarEntrada,
  vistaPreviaDeLaOferta,
  type Db,
  type EstadoDeLaOferta,
  type VistaPrevia,
} from './planOfferPreview'

// Lo público de la lectura vive en `planOfferPreview.ts`; se reexporta para que el publicador siga siendo la puerta de entrada.
export { estadoDeLaOferta, vistaPreviaDeLaOferta }
export type { EstadoDeLaOferta, VistaPrevia }

type Etapa = 'PRECIO' | 'LISTA'
/**
 * Lo que la pantalla enseña de la última falla. En la preparación, la etapa y el motivo de Stripe; si el movimiento (paso 6) se negó,
 * `MOVIMIENTO` (o `LISTA`, si faltaban los ids de Stripe de una lista) con el CÓDIGO con que se negó.
 */
type UltimoError = { etapa: Etapa | 'MOVIMIENTO'; ranura: Ranura | null; motivo: MotivoDePreparacion | string; at: string }

/** Lo que devuelve descartar si el descarte se confirmó pero el estado no se pudo leer después. */
export interface EstadoParcialDeLaOferta {
  revision: number
  pendiente: null
  parcial: true
}

// ---------------------------------------------------------------------------------------------------------------------
// Constantes (las rutas JSON son FIJAS: nunca salen de lo que manda el usuario)
// ---------------------------------------------------------------------------------------------------------------------

/** PREMIUM primero, como los candados de producto (`lockProducts` ordena `precio:PLAN:PREMIUM` antes que `precio:PLAN:PRO`). */
const PLANES_EN_ORDEN_DE_CANDADO: readonly PlanPagado[] = ['PREMIUM', 'PRO']
const LISTAS_DE_LOS_PLANES = ['PLAN:PRO', 'PLAN:PREMIUM']
const CODIGO_DEL_PLAN: Record<PlanPagado, 'PLAN_PRO' | 'PLAN_PREMIUM'> = { PRO: 'PLAN_PRO', PREMIUM: 'PLAN_PREMIUM' }

/** La llave de cada ranura en `preparacion.intentos` (con `_`, no `:`). */
const CLAVE_DEL_INTENTO: Record<Ranura, string> = {
  'PRO:monthly': 'PRO_monthly',
  'PRO:annual': 'PRO_annual',
  'PREMIUM:monthly': 'PREMIUM_monthly',
  'PREMIUM:annual': 'PREMIUM_annual',
}
const RUTA_DEL_PRECIO: Record<Ranura, string> = {
  'PRO:monthly': '{PRO,monthly,stripePriceId}',
  'PRO:annual': '{PRO,annual,stripePriceId}',
  'PREMIUM:monthly': '{PREMIUM,monthly,stripePriceId}',
  'PREMIUM:annual': '{PREMIUM,annual,stripePriceId}',
}
const RUTA_DEL_INTENTO: Record<Ranura, string> = {
  'PRO:monthly': '{intentos,PRO_monthly}',
  'PRO:annual': '{intentos,PRO_annual}',
  'PREMIUM:monthly': '{intentos,PREMIUM_monthly}',
  'PREMIUM:annual': '{intentos,PREMIUM_annual}',
}
const RUTA_DE_LA_LISTA: Record<PlanPagado, string> = { PRO: '{PRO}', PREMIUM: '{PREMIUM}' }

const NOMBRE_DEL_PLAN: Record<PlanPagado, string> = { PRO: 'Pro', PREMIUM: 'Premium' }
const NOMBRE_DEL_PERIODO: Record<Periodicidad, string> = { monthly: 'mensual', annual: 'anual' }

// ---------------------------------------------------------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------------------------------------------------------

const apagado = () =>
  new ConflictError('La edición de los planes está apagada. Préndela en «Planes» del SUPERADMIN para publicar.', 'PLAN_EDIT_DISABLED')

const hayPendiente = (pendingVersionId: string) =>
  new ConflictError(
    'Ya hay una versión de los planes publicándose. Reintenta o descarta esa antes de publicar otra.',
    'PLAN_OFFER_PENDING',
    { pendingVersionId },
  )

function errorDePreparacion(versionId: string, etapa: Etapa, motivo: MotivoDePreparacion, ranura?: Ranura): ConflictError {
  const que = ranura
    ? `el precio ${NOMBRE_DEL_PERIODO[partes(ranura)[1]]} de ${NOMBRE_DEL_PLAN[partes(ranura)[0]]}`
    : 'la lista de precios de los planes'
  const salida =
    motivo === 'INCIERTO'
      ? 'Reintenta. Si se repite, descarta esta versión y vuelve a publicarla.'
      : motivo === 'RECHAZADO'
        ? 'Reintenta.'
        : 'Descarta esta versión y vuelve a publicarla.'
  return new ConflictError(
    `No pudimos preparar ${que} en Stripe. La versión vigente se sigue vendiendo. ${salida}`,
    'PLAN_OFFER_PREPARING',
    {
      versionId,
      etapa,
      ...(ranura ? { ranura } : {}),
      motivo,
    },
  )
}

// ---------------------------------------------------------------------------------------------------------------------
// Las escrituras de la preparación: una ranura a la vez, sobre la fila actual, sólo mientras siga PREPARING
// ---------------------------------------------------------------------------------------------------------------------

type FilaPendiente = {
  definition: PlanOfferDefinition
  basedOnVersionId: string | null
  preparacion: Prisma.JsonValue
  hybridPublicationIds: Prisma.JsonValue
}

/** La versión, que tiene que seguir `PREPARING` (si no, 409 `PLAN_OFFER_STALE`), con su definición validada. */
async function leerPendiente(db: Db, versionId: string): Promise<FilaPendiente> {
  const fila = await db.planOfferVersion.findUnique({
    where: { id: versionId },
    select: { status: true, basedOnVersionId: true, preparacion: true, hybridPublicationIds: true },
  })
  if (!fila || fila.status !== 'PREPARING') throw desfasada({ versionId })
  const { definition } = await ofertaPorId(versionId, db)
  return {
    definition,
    basedOnVersionId: fila.basedOnVersionId,
    preparacion: fila.preparacion,
    hybridPublicationIds: fila.hybridPublicationIds,
  }
}

const intentoDe = (preparacion: Prisma.JsonValue, ranura: Ranura): number => {
  const valor = (preparacion as { intentos?: Record<string, unknown> } | null)?.intentos?.[CLAVE_DEL_INTENTO[ranura]]
  return typeof valor === 'number' && Number.isInteger(valor) ? valor : 0
}

const listaLigada = (hybridPublicationIds: Prisma.JsonValue, tier: PlanPagado): string | null => {
  const valor = (hybridPublicationIds as Record<string, unknown> | null)?.[tier]
  return typeof valor === 'string' && valor ? valor : null
}

async function guardarPrecio(versionId: string, ranura: Ranura, priceId: string): Promise<void> {
  const filas = await prisma.$executeRaw`
    UPDATE "PlanOfferVersion"
    SET "definition" = jsonb_set("definition", ${RUTA_DEL_PRECIO[ranura]}::text[], to_jsonb(${priceId}::text))
    WHERE "id" = ${versionId} AND "status" = 'PREPARING'`
  if (filas !== 1) throw desfasada({ versionId })
}

/** Sube el intento de la ranura SÓLO si sigue en `intento`: un rechazo viejo no lo sube otra vez. Cero filas no es error aquí. */
async function subirIntento(versionId: string, ranura: Ranura, intento: number): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "PlanOfferVersion"
    SET "preparacion" = jsonb_set("preparacion", ${RUTA_DEL_INTENTO[ranura]}::text[], to_jsonb(${intento + 1}::int))
    WHERE "id" = ${versionId} AND "status" = 'PREPARING'
      AND ("preparacion"->'intentos'->>${CLAVE_DEL_INTENTO[ranura]})::int = ${intento}`
}

/** Escribe `preparacion.ultimoError` (o lo limpia con `null`) mientras la versión siga `PREPARING`; devuelve las filas tocadas. */
async function escribirUltimoError(versionId: string, error: UltimoError | null): Promise<number> {
  return prisma.$executeRaw`
    UPDATE "PlanOfferVersion"
    SET "preparacion" = jsonb_set("preparacion", '{ultimoError}', ${JSON.stringify(error)}::jsonb)
    WHERE "id" = ${versionId} AND "status" = 'PREPARING'`
}

/** En la preparación (pasos 4 y 5): cero filas = ya no es la pendiente → 409 `PLAN_OFFER_STALE`. */
async function guardarUltimoError(versionId: string, error: UltimoError): Promise<void> {
  if ((await escribirUltimoError(versionId, error)) !== 1) throw desfasada({ versionId })
}

const hayUltimoError = (preparacion: Prisma.JsonValue) => ((preparacion as { ultimoError?: unknown } | null)?.ultimoError ?? null) !== null

/**
 * Un doble clic: si la otra petición ya publicó ESTA versión y es la vigente, el `PLAN_OFFER_STALE` de ésta es un éxito (como el
 * doble clic de `finalizeListPublication`). Cualquier otro error, o la versión sin publicar, → `null` y el error sigue su curso.
 */
async function yaPublicada(versionId: string, error: unknown): Promise<{ number: number; versionId: string } | null> {
  if (!(error instanceof AppError && error.code === 'PLAN_OFFER_STALE')) return null
  const version = await prisma.planOfferVersion.findUnique({ where: { id: versionId }, select: { status: true, number: true } })
  const puntero = await prisma.planOfferPointer.findUnique({ where: { id: PUNTERO_ID }, select: { currentVersionId: true } })
  const number = version && version.status === 'PUBLISHED' ? version.number : null
  if (number === null || puntero?.currentVersionId !== versionId) return null
  logger.info('[PlanOffer] la versión ya la publicó otra petición: se responde como éxito', { versionId, number })
  return { number, versionId }
}

// ---------------------------------------------------------------------------------------------------------------------
// Publicar, reintentar, descartar
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Publica exactamente esta `entrada` (precios SIN IVA) sobre la revisión que vio quien la confirmó. Ver `prepararVersion` para
 * lo que sigue después de crear la versión.
 */
export async function publicarVersion(
  entrada: unknown,
  expectedRevision: number,
  staffId: string,
): Promise<{ number: number; versionId: string }> {
  // La revisión rápida (con caché); la que manda es la de la transacción del candado, abajo.
  if (!(await planesEditablesPrendidos())) throw apagado()

  // 1. La entrada, que haya cambios, la revisión y que no haya otra pendiente.
  const datos = validarEntrada(entrada)
  const vigente = await ofertaVigente()
  const nueva = definicionDesdeEntrada(datos, vigente.definition)
  if (!cambiosEntre(vigente.definition, nueva).length)
    throw new BadRequestError('La oferta que mandaste es igual a la vigente: no hay nada que publicar.', 'PLAN_OFFER_UNCHANGED')
  const puntero = await prisma.planOfferPointer.findUnique({
    where: { id: PUNTERO_ID },
    select: { revision: true, pendingVersionId: true },
  })
  if ((puntero?.revision ?? 0) !== expectedRevision) throw desfasada()
  if (puntero?.pendingVersionId) throw hayPendiente(puntero.pendingVersionId)

  // 2. Bloqueos rápidos, sin crear nada.
  await exigirSinCampanas(prisma, vigente.definition, nueva)
  const rotas = await promocionesQueRompe(nueva)
  if (rotas.length)
    throw new ConflictError(
      'Hay promociones activas que costarían lo mismo o más que el precio mensual nuevo, o que renovarían por encima de él. Páusalas antes de publicar.',
      'HYBRID_LIST_BREAKS_PROMOTIONS',
      rotas,
    )

  // 3. La versión PREPARING y el puntero, bajo el candado de la oferta (sin Stripe).
  const versionId = await priceTransaction(async tx => {
    await tomarCandadoDeLaOferta(tx)
    if (!(await planesEditablesPrendidos({ sinCache: true, db: tx }))) throw apagado()
    const enTx = await tx.planOfferPointer.findUnique({ where: { id: PUNTERO_ID }, select: { revision: true, pendingVersionId: true } })
    if ((enTx?.revision ?? 0) !== expectedRevision) throw desfasada()
    if (enTx?.pendingVersionId) throw hayPendiente(enTx.pendingVersionId)
    const base = await ofertaVigente(tx)
    const definition = definicionDesdeEntrada(datos, base.definition)
    await exigirSinCampanas(tx, base.definition, definition)
    // 🔴 Los JSON nacen con todos sus objetos: cada `jsonb_set` posterior encuentra a su padre.
    const version = await tx.planOfferVersion.create({
      data: {
        status: 'PREPARING',
        definition: definition as unknown as Prisma.InputJsonValue,
        basedOnVersionId: base.versionId,
        preparacion: { intentos: { PRO_monthly: 0, PRO_annual: 0, PREMIUM_monthly: 0, PREMIUM_annual: 0 }, ultimoError: null },
        hybridPublicationIds: { PRO: null, PREMIUM: null },
        createdById: staffId,
      },
      select: { id: true },
    })
    const cas = await tx.planOfferPointer.updateMany({
      where: { id: PUNTERO_ID, revision: expectedRevision, pendingVersionId: null },
      data: { pendingVersionId: version.id, revision: { increment: 1 } },
    })
    if (cas.count !== 1) throw desfasada()
    await tx.activityLog.create({
      data: {
        staffId,
        action: 'PLAN_OFFER_PUBLISH_STARTED',
        entity: 'PlanOfferVersion',
        entityId: version.id,
        data: {
          desde: { versionId: base.versionId, number: base.number },
          cambios: cambiosEntre(base.definition, definition),
        } as unknown as Prisma.InputJsonValue,
      },
    })
    return version.id
  })
  logger.info('[PlanOffer] versión en preparación', { versionId, por: staffId })

  return prepararVersion(versionId, staffId)
}

/** Retoma una versión pendiente. Antes de cualquier llamada a Stripe: el interruptor y que siga siendo la pendiente. */
export async function reintentarPublicacion(versionId: string, staffId: string): Promise<{ number: number; versionId: string }> {
  try {
    await priceTransaction(async tx => {
      await tomarCandadoDeLaOferta(tx)
      if (!(await planesEditablesPrendidos({ sinCache: true, db: tx }))) throw apagado()
      const puntero = await tx.planOfferPointer.findUnique({ where: { id: PUNTERO_ID }, select: { pendingVersionId: true } })
      if (puntero?.pendingVersionId !== versionId) throw desfasada({ versionId })
      await leerPendiente(tx, versionId)
    })
  } catch (error) {
    const hecho = await yaPublicada(versionId, error)
    if (hecho) return hecho
    throw error
  }
  return prepararVersion(versionId, staffId)
}

/**
 * Pasos 4 a 6, compartidos por publicar y reintentar: los precios que cambiaron, las dos listas híbridas y el movimiento.
 * Cada paso se puede repetir: lo que ya quedó guardado no se vuelve a pedir. Si otra petición publicó esta misma versión
 * mientras tanto, es un éxito (`yaPublicada`).
 */
async function prepararVersion(versionId: string, staffId: string): Promise<{ number: number; versionId: string }> {
  try {
    return await prepararVersionPasoAPaso(versionId, staffId)
  } catch (error) {
    const hecho = await yaPublicada(versionId, error)
    if (hecho) return hecho
    throw error
  }
}

async function prepararVersionPasoAPaso(versionId: string, staffId: string): Promise<{ number: number; versionId: string }> {
  const inicial = await leerPendiente(prisma, versionId)
  const base = inicial.basedOnVersionId ? (await ofertaPorId(inicial.basedOnVersionId)).definition : ofertaDeRespaldo()
  const ranuras = ranurasQueCambian(inicial.definition, base)
  // Un paso que sale bien después de una falla anterior limpia `ultimoError` (una vez; cero filas aquí no importa: el siguiente
  // paso relee la fila y dice si ya no es la pendiente).
  let conErrorPrevio = hayUltimoError(inicial.preparacion)
  const salioBien = async () => {
    if (!conErrorPrevio) return
    await escribirUltimoError(versionId, null)
    conErrorPrevio = false
  }

  // 4. Los precios de Stripe que cambiaron, uno por ranura, fuera de toda transacción.
  if (ranuras.length) {
    const productos = await productosDeLosPlanes()
    for (const ranura of ranuras) {
      await prepararRanura(versionId, ranura, productos)
      await salioBien()
    }
  }

  // 5. Las listas híbridas de los dos planes (PREMIUM primero).
  for (const tier of PLANES_EN_ORDEN_DE_CANDADO) {
    await prepararLista(versionId, tier, inicial.definition, staffId)
    await salioBien()
  }

  // 6. El movimiento.
  return moverPunteros(versionId, staffId)
}

/** El producto de Stripe de cada plan: la `Feature` activa `PLAN_PRO` / `PLAN_PREMIUM`. Sin él, 503 antes de tocar Stripe. */
async function productosDeLosPlanes(): Promise<Record<PlanPagado, string>> {
  const filas = await prisma.feature.findMany({
    where: { code: { in: PLANES.map(t => CODIGO_DEL_PLAN[t]) } },
    select: { code: true, active: true, stripeProductId: true },
    take: PLANES.length,
  })
  const de = (tier: PlanPagado) => {
    const fila = filas.find(f => f.code === CODIGO_DEL_PLAN[tier])
    if (!fila?.active || !fila.stripeProductId) {
      logger.error('🚨 planOfferPublisher: el plan no tiene un producto de Stripe activo — no se crean precios', { tier })
      throw new AppError(
        'Los planes no están disponibles por un problema nuestro de configuración. No se cobró nada.',
        503,
        true,
        'PLAN_NOT_CONFIGURED',
        { tier },
      )
    }
    return fila.stripeProductId
  }
  return { PRO: de('PRO'), PREMIUM: de('PREMIUM') }
}

async function prepararRanura(versionId: string, ranura: Ranura, productos: Record<PlanPagado, string>): Promise<void> {
  // Se relee la fila: otro reintento pudo guardar esta ranura o abrir otro intento mientras tanto.
  const fila = await leerPendiente(prisma, versionId)
  const precio = precioDe(fila.definition, ranura)
  if (precio.stripePriceId) return
  const intento = intentoDe(fila.preparacion, ranura)
  let priceId: string
  try {
    ;({ priceId } = await asegurarPrecioDeLaRanura({
      versionId,
      ranura,
      grossCents: precio.grossCents,
      productId: productos[partes(ranura)[0]],
      intento,
    }))
  } catch (error) {
    // Una entrada mala (un Error simple) no se atrapa: sube tal cual.
    if (!(error instanceof ErrorDePreparacion)) throw error
    const causa = (error as { cause?: { message?: unknown; type?: unknown; requestId?: unknown } }).cause
    logger.warn('[PlanOffer] Stripe no preparó un precio de la versión', {
      versionId,
      ranura,
      intento,
      motivo: error.motivo,
      stripeCode: error.stripeCode,
      causa: causa ? { message: causa.message, type: causa.type, requestId: causa.requestId } : undefined,
    })
    // 🔴 Antes de responder: el siguiente reintento usa una llave de idempotencia nueva (sólo tras un rechazo definitivo).
    if (error.motivo === 'RECHAZADO') await subirIntento(versionId, ranura, intento)
    await guardarUltimoError(versionId, { etapa: 'PRECIO', ranura, motivo: error.motivo, at: new Date().toISOString() })
    throw errorDePreparacion(versionId, 'PRECIO', error.motivo, ranura)
  }
  await guardarPrecio(versionId, ranura, priceId)
}

async function prepararLista(versionId: string, tier: PlanPagado, definition: PlanOfferDefinition, staffId: string): Promise<void> {
  try {
    await prepararListaDelPlan(
      tier,
      { precio: mensualEnPesos(definition, tier), nombre: `Plan ${definition[tier].displayName}` },
      staffId,
      {
        ligada: async tx => {
          const puntero = await tx.planOfferPointer.findUnique({ where: { id: PUNTERO_ID }, select: { pendingVersionId: true } })
          if (puntero?.pendingVersionId !== versionId) throw desfasada({ versionId })
          const fila = await tx.planOfferVersion.findUnique({
            where: { id: versionId },
            select: { status: true, hybridPublicationIds: true },
          })
          if (fila?.status !== 'PREPARING') throw desfasada({ versionId })
          return listaLigada(fila?.hybridPublicationIds ?? null, tier)
        },
        ligar: async (tx, r) => {
          const filas = await tx.$executeRaw`
          UPDATE "PlanOfferVersion"
          SET "hybridPublicationIds" = jsonb_set("hybridPublicationIds", ${RUTA_DE_LA_LISTA[tier]}::text[], to_jsonb(${r.publicationId}::text))
          WHERE "id" = ${versionId} AND "status" = 'PREPARING'`
          if (filas !== 1) throw desfasada({ versionId })
        },
      },
    )
  } catch (error) {
    if (!(error instanceof AppError && error.code === 'HYBRID_LIST_PREPARING')) throw error
    // La pendiente quedó ligada: el reintento vuelve a preparar esa misma publicación.
    await guardarUltimoError(versionId, { etapa: 'LISTA', ranura: null, motivo: 'INCIERTO', at: new Date().toISOString() })
    throw errorDePreparacion(versionId, 'LISTA', 'INCIERTO')
  }
}

/** Cada lista ligada que no es la vigente de su lista ya trae sus ids de Stripe (si no, no se mueve nada). */
async function exigirListasPreparadas(tx: Prisma.TransactionClient, versionId: string, ligadas: Record<PlanPagado, string | null>) {
  if (!ligadas.PRO || !ligadas.PREMIUM) throw errorDePreparacion(versionId, 'LISTA', 'INCIERTO')
  const listas = await tx.hybridCampaign.findMany({
    where: { purpose: 'LIST', listProductKey: { in: LISTAS_DE_LOS_PLANES } },
    select: { listProductKey: true, currentPublicationId: true },
    take: LISTAS_DE_LOS_PLANES.length,
  })
  const porVender = PLANES.filter(t => listas.find(l => l.listProductKey === `PLAN:${t}`)?.currentPublicationId !== ligadas[t]).map(
    t => ligadas[t] as string,
  )
  if (!porVender.length) return
  const publicaciones = await tx.hybridOfferPublication.findMany({
    where: { id: { in: porVender } },
    select: { id: true, stripePriceId: true, stripeProductId: true },
    take: porVender.length,
  })
  const lista = (id: string) => publicaciones.find(p => p.id === id)
  if (porVender.some(id => !lista(id)?.stripePriceId || !lista(id)?.stripeProductId))
    throw errorDePreparacion(versionId, 'LISTA', 'INCIERTO')
}

/**
 * Paso 6. Si el movimiento se niega (apagado, desfasado, una lista sin preparar, una campaña o una promoción), la razón queda en
 * `ultimoError` DESPUÉS de que la transacción falló, sin ningún candado tomado; cero filas no importa (pudieron descartarla).
 */
async function moverPunteros(versionId: string, staffId: string): Promise<{ number: number; versionId: string }> {
  try {
    return await moverPunterosEnUnaTransaccion(versionId, staffId)
  } catch (error) {
    if (error instanceof AppError && error.code) {
      const etapa = (error.details as { etapa?: unknown } | undefined)?.etapa === 'LISTA' ? 'LISTA' : 'MOVIMIENTO'
      try {
        await escribirUltimoError(versionId, { etapa, ranura: null, motivo: error.code, at: new Date().toISOString() })
      } catch (escritura) {
        // La negativa del movimiento es lo que la persona tiene que ver; la nota es secundaria.
        logger.warn('[PlanOffer] no se pudo anotar por qué se negó el movimiento', {
          versionId,
          codigo: error.code,
          error: escritura instanceof Error ? escritura.message : String(escritura),
        })
      }
    }
    throw error
  }
}

/** La oferta y las dos listas, juntas, en una transacción. Nada de Stripe aquí. */
async function moverPunterosEnUnaTransaccion(versionId: string, staffId: string): Promise<{ number: number; versionId: string }> {
  const hecho = await priceTransaction(async tx => {
    // 🔴 Orden fijo: el candado de la oferta y luego los de producto (PREMIUM, PRO).
    await tomarCandadoDeLaOferta(tx)
    await lockProducts(tx, LISTAS_DE_LOS_PLANES)
    if (!(await planesEditablesPrendidos({ sinCache: true, db: tx }))) throw apagado()
    const fila = await leerPendiente(tx, versionId)
    const puntero = await tx.planOfferPointer.findUnique({
      where: { id: PUNTERO_ID },
      select: { currentVersionId: true, pendingVersionId: true },
    })
    if (puntero?.pendingVersionId !== versionId || (puntero?.currentVersionId ?? null) !== fila.basedOnVersionId)
      throw desfasada({ versionId })
    const vigente = await ofertaVigente(tx)
    await exigirSinCampanas(tx, vigente.definition, fila.definition)
    const sinPrecio = RANURAS.find(r => !precioDe(fila.definition, r).stripePriceId)
    if (sinPrecio) throw errorDePreparacion(versionId, 'PRECIO', 'INCIERTO', sinPrecio)
    const ligadas = { PRO: listaLigada(fila.hybridPublicationIds, 'PRO'), PREMIUM: listaLigada(fila.hybridPublicationIds, 'PREMIUM') }
    await exigirListasPreparadas(tx, versionId, ligadas)
    for (const tier of PLANES_EN_ORDEN_DE_CANDADO) await finalizarListaDelPlanEn(tx, tier, ligadas[tier] as string, staffId)

    const number = vigente.number + 1
    const publicada = await tx.planOfferVersion.updateMany({
      where: { id: versionId, status: 'PREPARING' },
      data: { status: 'PUBLISHED', number, publishedAt: new Date(), publishedById: staffId },
    })
    if (publicada.count !== 1) throw desfasada({ versionId })
    if (fila.basedOnVersionId)
      await tx.planOfferVersion.updateMany({ where: { id: fila.basedOnVersionId, status: 'PUBLISHED' }, data: { status: 'SUPERSEDED' } })
    const movido = await tx.planOfferPointer.updateMany({
      where: { id: PUNTERO_ID, currentVersionId: fila.basedOnVersionId, pendingVersionId: versionId },
      data: { currentVersionId: versionId, pendingVersionId: null, revision: { increment: 1 } },
    })
    if (movido.count !== 1) throw desfasada({ versionId })
    await tx.activityLog.create({
      data: {
        staffId,
        action: 'PLAN_OFFER_PUBLISHED',
        entity: 'PlanOfferVersion',
        entityId: versionId,
        data: {
          desde: { versionId: vigente.versionId, number: vigente.number },
          hasta: { versionId, number },
          cambios: cambiosEntre(vigente.definition, fila.definition),
        } as unknown as Prisma.InputJsonValue,
      },
    })
    return { number, versionId }
  })
  logger.info('[PlanOffer] versión publicada', { ...hecho, por: staffId })
  return hecho
}

/**
 * Descarta la versión pendiente: queda `DISCARDED` (sin número), el puntero sin pendiente y sus listas híbridas pendientes
 * sueltas. No toca la vigente ni Stripe, y no pide el interruptor (es la salida de una publicación atorada).
 */
export async function descartarPublicacion(versionId: string, staffId: string): Promise<EstadoDeLaOferta | EstadoParcialDeLaOferta> {
  await priceTransaction(async tx => {
    await tomarCandadoDeLaOferta(tx)
    await lockProducts(tx, LISTAS_DE_LOS_PLANES)
    // Después de los candados: lo que una preparación alcanzó a ligar ya está aquí.
    const puntero = await tx.planOfferPointer.findUnique({ where: { id: PUNTERO_ID }, select: { pendingVersionId: true } })
    if (puntero?.pendingVersionId !== versionId) throw desfasada({ versionId })
    const fila = await tx.planOfferVersion.findUnique({ where: { id: versionId }, select: { hybridPublicationIds: true } })
    const descartada = await tx.planOfferVersion.updateMany({
      where: { id: versionId, status: 'PREPARING' },
      data: { status: 'DISCARDED', discardedAt: new Date(), discardedById: staffId },
    })
    if (descartada.count !== 1) throw desfasada({ versionId })
    const soltado = await tx.planOfferPointer.updateMany({
      where: { id: PUNTERO_ID, pendingVersionId: versionId },
      data: { pendingVersionId: null, revision: { increment: 1 } },
    })
    if (soltado.count !== 1) throw desfasada({ versionId })
    for (const tier of PLANES_EN_ORDEN_DE_CANDADO) {
      const ligada = listaLigada(fila?.hybridPublicationIds ?? null, tier)
      if (ligada) await soltarListaPendienteDelPlanEn(tx, tier, ligada)
    }
    await tx.activityLog.create({
      data: {
        staffId,
        action: 'PLAN_OFFER_DISCARDED',
        entity: 'PlanOfferVersion',
        entityId: versionId,
        data: { versionId, hybridPublicationIds: fila?.hybridPublicationIds ?? null } as unknown as Prisma.InputJsonValue,
      },
    })
  })
  logger.info('[PlanOffer] versión descartada', { versionId, por: staffId })
  try {
    return await estadoDeLaOferta()
  } catch (error) {
    // El descarte ya se confirmó: no se responde como error. La pantalla vuelve a pedir el estado completo.
    logger.warn('[PlanOffer] se descartó la versión, pero no se pudo leer el estado de la oferta', {
      versionId,
      error: error instanceof Error ? error.message : String(error),
    })
    const puntero = await prisma.planOfferPointer.findUnique({ where: { id: PUNTERO_ID }, select: { revision: true } })
    return { revision: puntero?.revision ?? 0, pendiente: null, parcial: true }
  }
}
