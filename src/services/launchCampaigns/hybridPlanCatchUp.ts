import prisma from '@/utils/prismaClient'
import { writeLegacyActivityAuditTx } from '@/services/activityAudit.service'

const CODE = 'SERVICE_PAY'
const LOTE = 100

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
 * Corre bajo el candado de entrega de cada compra y es idempotente: se vuelve a correr después de republicar las ofertas.
 */
export async function addServicePayToLivePlanContracts(now: Date = new Date()) {
  let contracts = 0
  let grants = 0
  let after: string | undefined
  for (;;) {
    const page = await prisma.hybridContract.findMany({
      where: { endedAt: null, planTier: { in: ['PRO', 'PREMIUM'] }, ...(after ? { id: { gt: after } } : {}) },
      select: { id: true, purchaseId: true },
      orderBy: { id: 'asc' },
      take: LOTE,
    })
    for (const { id, purchaseId } of page) {
      const r = await prisma.$transaction(
        async tx => {
          // El candado de `reconcileHybridInvoice`: ninguna entrega de esta compra corre a la mitad de esto.
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`hybrid-delivery:${purchaseId}`}))::text`
          const contract = await tx.hybridContract.findUniqueOrThrow({ where: { id } })
          if (contract.endedAt) return { selection: false, grants: 0 }
          const selection = !contract.featureCodes.includes(CODE)
          if (selection) {
            const featureCodes = [...contract.featureCodes, CODE].sort()
            // Rige desde el próximo periodo SIN entregar (los de Stripe son contiguos), no desde hoy: una renovación que
            // empezó antes y se entrega tarde la lee igual (`effectiveAt <= start`, hybridDelivery.service.ts:128).
            const effectiveAt = contract.paidThrough ?? contract.startsAt
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
      if (r.selection) contracts++
      grants += r.grants
    }
    if (page.length < LOTE) break
    after = page[page.length - 1].id
  }
  return { contracts, grants, staleCampaigns: await staleCampaigns() }
}

/** Ofertas de plan en venta o pausadas cuya publicación vigente no trae la función: se republican en superadmin. */
async function staleCampaigns(): Promise<Array<{ id: string; code: string }>> {
  // ponytail: 500 campañas vivas a la vez; paginar por id si algún día se acerca.
  const campaigns = await prisma.hybridCampaign.findMany({
    where: { status: { in: ['ACTIVE', 'PAUSED'] }, currentPublicationId: { not: null } },
    select: { id: true, code: true, currentPublicationId: true },
    orderBy: { id: 'asc' },
    take: 500,
  })
  const ids = campaigns.map(c => c.currentPublicationId!)
  if (!ids.length) return []
  const stale = await prisma.hybridOfferPublication.findMany({
    where: { id: { in: ids }, definition: { path: ['kind'], equals: 'PLAN' }, NOT: { includedFeatureCodes: { has: CODE } } },
    select: { id: true },
    take: ids.length,
  })
  const set = new Set(stale.map(p => p.id))
  return campaigns.filter(c => set.has(c.currentPublicationId!)).map(c => ({ id: c.id, code: c.code }))
}
