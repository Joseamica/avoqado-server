import prisma from '@/utils/prismaClient'
import { writeLegacyActivityAuditTx } from '@/services/activityAudit.service'
import { isTransientDbConnectionError } from '@/utils/retry'

const CODE = 'SERVICE_PAY'
const TIERS = ['PRO', 'PREMIUM']
const LOTE = 100

/** Un contrato que no se puede poner al día sin adivinar: se reporta con su motivo y la corrida sigue con los demás. */
class SkipContract extends Error {
  constructor(readonly reason: string) {
    super(reason)
  }
}

/** Lo que aborta la corrida entera: la base no está (conexión, pool, transacción que no arranca), no un contrato raro. */
const abortsTheRun = (error: unknown) => isTransientDbConnectionError(error) || (error as { code?: unknown } | null)?.code === 'P2028'

function reasonOf(error: unknown): string {
  if (error instanceof SkipContract) return error.reason
  const code = (error as { code?: unknown } | null)?.code
  const message = error instanceof Error ? error.message.trim().split('\n').pop()!.trim() : String(error)
  return `${typeof code === 'string' ? `${code}: ` : ''}${message}`.slice(0, 200)
}

/**
 * Pago al personal entra a PRO y PREMIUM (decisión D3 del founder, 5-oct; spec fase 3 §10, Codex r2-8 y r3-2).
 *
 * Una publicación de plan CONGELA su composición (`compileHybridPublication`; la tabla es inmutable por trigger) y la
 * renovación de un contrato lee su selección vigente (`hybridDelivery.service.ts:149`), así que una función que entra al
 * plan después NO llega sola a los contratos vivos. Esto se la agrega una vez a cada contrato de plan sin terminar:
 *   1. a la selección que leen las renovaciones: fila NUEVA del historial (inmutable) desde el próximo periodo sin
 *      entregar + `featureCodes`, como hace la entrega al aplicar una selección programada — sin tocar `revision`;
 *   2. a cada periodo pagado que no ha terminado: un grant con el MISMO origen (`${periodo}:${contrato}`), periodo,
 *      ventana y estado (revocado o no) que sus hermanos; así un reembolso o una disputa lo revocan con ellos y ganar la
 *      disputa lo restaura con ellos.
 * Sólo compras COMPLETED (C1b ronda 1): a una a medio pagar, cambiarle `featureCodes` haría que `provisionHybridPurchase`
 * («Reanudar pago», `hybridProvision.service.ts:164`) respondiera HYBRID_CONTRACT_MISMATCH para siempre. Esas se cuentan en
 * `inFlightPurchases` y se ponen al día en la siguiente corrida, ya completadas. Un contrato que no se puede poner al día
 * (p. ej. su fila de historial ya existe sin sus `featureCodes`) va a `skippedContracts` y no detiene a los demás.
 * Corre bajo el candado de entrega de cada compra y es idempotente: se vuelve a correr después de republicar las ofertas.
 */
export async function addServicePayToLivePlanContracts(now: Date = new Date()) {
  let contracts = 0
  let grants = 0
  const skippedContracts: Array<{ contractId: string; reason: string }> = []
  // Antes de recorrer: una compra que se completa a media corrida queda contada y no se pierde en silencio.
  const inFlightPurchases = await countInFlightPurchases()
  let after: string | undefined
  for (;;) {
    const page = await prisma.hybridContract.findMany({
      where: {
        endedAt: null,
        planTier: { in: TIERS },
        purchase: { status: 'COMPLETED' },
        ...(after ? { id: { gt: after } } : {}),
      },
      select: { id: true, purchaseId: true },
      orderBy: { id: 'asc' },
      take: LOTE,
    })
    for (const { id, purchaseId } of page) {
      let r: { selection: boolean; grants: number }
      try {
        r = await prisma.$transaction(
          async tx => {
            // El candado de `reconcileHybridInvoice`: ninguna entrega de esta compra corre a la mitad de esto.
            await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`hybrid-delivery:${purchaseId}`}))::text`
            const purchase = await tx.hybridPurchase.findUniqueOrThrow({ where: { id: purchaseId }, select: { status: true } })
            if (purchase.status !== 'COMPLETED') throw new SkipContract(`PURCHASE_NOT_COMPLETED:${purchase.status}`)
            const contract = await tx.hybridContract.findUniqueOrThrow({ where: { id } })
            if (contract.endedAt) return { selection: false, grants: 0 }
            const selection = !contract.featureCodes.includes(CODE)
            if (selection) {
              const featureCodes = [...contract.featureCodes, CODE].sort()
              // Rige desde el próximo periodo SIN entregar (los de Stripe son contiguos), no desde hoy: una renovación que
              // empezó antes y se entrega tarde la lee igual (`effectiveAt <= start`, hybridDelivery.service.ts:128).
              const effectiveAt = contract.paidThrough ?? contract.startsAt
              // El historial es inmutable: si ya hay fila en esa fecha y `featureCodes` no la refleja, no se adivina cuál vale.
              const existing = await tx.hybridContractSelection.findUnique({
                where: { contractId_effectiveAt: { contractId: id, effectiveAt } },
                select: { id: true },
              })
              if (existing) throw new SkipContract('SELECTION_ALREADY_AT_EFFECTIVE_DATE')
              await tx.hybridContractSelection.create({ data: { contractId: id, effectiveAt, featureCodes } })
              await tx.hybridContract.update({ where: { id }, data: { featureCodes } })
            }
            // Un grant por periodo pagado de ESTE contrato que no ha terminado, enumerado desde los PERIODOS y no desde sus
            // grants (Codex plan r2): un periodo cuya primera conciliación salió inválida (disputa, fondos) quedó guardado SIN
            // grants y con su composición vieja, que la entrega reutiliza al ganar la disputa (hybridDelivery.service.ts:133).
            // Mismo origen y ventana que escribe la entrega; el estado se copia de sus hermanos y, sin hermanos (periodo nunca
            // válido), nace revocado: la entrega lo restaura con los demás cuando el pago se confirma (:279-289).
            const periodos = await tx.hybridPaymentPeriod.findMany({
              where: { venueId: contract.venueId, stripeSubscriptionId: contract.stripeSubscriptionId, endsAt: { gt: now } },
              select: { id: true, startsAt: true, endsAt: true, composition: true },
              orderBy: { id: 'asc' },
              take: 24, // ponytail: una suscripción tiene 1-2 periodos sin terminar (el actual y, a lo más, uno por adelantado)
            })
            let count = 0
            for (const periodo of periodos) {
              if (!(periodo.composition as unknown as Array<{ contractId: string }>).some(line => line.contractId === id)) continue
              const hermano = await tx.capabilityGrant.findFirst({
                where: { contractId: id, paymentPeriodId: periodo.id },
                select: { revokedAt: true },
              })
              const creado = await tx.capabilityGrant.createMany({
                data: [
                  {
                    venueId: contract.venueId,
                    featureCode: CODE,
                    sourceId: `${periodo.id}:${id}`,
                    contractId: id,
                    paymentPeriodId: periodo.id,
                    startsAt: periodo.startsAt,
                    endsAt: periodo.endsAt,
                    revokedAt: hermano ? hermano.revokedAt : now,
                  },
                ],
                skipDuplicates: true,
              })
              count += creado.count
            }
            if (selection || count)
              await writeLegacyActivityAuditTx(tx, {
                venueId: contract.venueId,
                action: 'HYBRID_PLAN_FEATURE_ADDED',
                entity: 'HybridContract',
                entityId: id,
                data: { featureCode: CODE, planTier: contract.planTier, selection, grants: count },
              })
            return { selection, grants: count }
          },
          { timeout: 600000, maxWait: 5000 }, // espera lo que dure una entrega en curso (su candado vive hasta 10 min)
        )
      } catch (error) {
        // Una base caída detiene todo; un contrato raro (o un choque de llave única suyo) se reporta y se salta.
        if (abortsTheRun(error)) throw error
        skippedContracts.push({ contractId: id, reason: reasonOf(error) })
        continue
      }
      if (r.selection) contracts++
      grants += r.grants
    }
    if (page.length < LOTE) break
    after = page[page.length - 1].id
  }
  return { contracts, grants, staleCampaigns: await staleCampaigns(), inFlightPurchases, skippedContracts }
}

/** Compras con contratos de plan vivos que todavía no se completan, por estado: se ponen al día en otra corrida. */
async function countInFlightPurchases(): Promise<Array<{ status: string; purchases: number }>> {
  const rows = await prisma.hybridPurchase.groupBy({
    by: ['status'],
    where: { status: { not: 'COMPLETED' }, contracts: { some: { endedAt: null, planTier: { in: TIERS } } } },
    _count: { _all: true },
    orderBy: { status: 'asc' },
    take: 50, // acotado por los estados posibles de una compra, no por el volumen
  })
  return rows.map(row => ({ status: row.status, purchases: row._count._all }))
}

/**
 * Ofertas de plan en venta o pausadas cuya publicación vigente no trae la función: se republican en superadmin. Recorre TODAS
 * las campañas vivas en páginas de `LOTE` ordenadas por id, como los contratos de arriba (Codex Bloque C r1-2): con un solo
 * `take` sin seguir, 500 campañas ajenas (funciones sueltas, listas de precios) antes por id escondían una oferta PRO vieja y
 * el script terminaba sin pedir republicarla. `currentPublicationId` no es relación, así que el filtro de plan va por página.
 */
export async function staleCampaigns(): Promise<Array<{ id: string; code: string }>> {
  const stale: Array<{ id: string; code: string }> = []
  let after: string | undefined
  for (;;) {
    const page = await prisma.hybridCampaign.findMany({
      where: { status: { in: ['ACTIVE', 'PAUSED'] }, currentPublicationId: { not: null }, ...(after ? { id: { gt: after } } : {}) },
      select: { id: true, code: true, currentPublicationId: true },
      orderBy: { id: 'asc' },
      take: LOTE,
    })
    if (page.length) {
      const ids = page.map(c => c.currentPublicationId!)
      const viejas = await prisma.hybridOfferPublication.findMany({
        where: { id: { in: ids }, definition: { path: ['kind'], equals: 'PLAN' }, NOT: { includedFeatureCodes: { has: CODE } } },
        select: { id: true },
        take: ids.length,
      })
      const set = new Set(viejas.map(p => p.id))
      for (const c of page) if (set.has(c.currentPublicationId!)) stale.push({ id: c.id, code: c.code })
    }
    if (page.length < LOTE) break
    after = page[page.length - 1].id
  }
  return stale
}
