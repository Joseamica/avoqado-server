/**
 * 🔴 DINERO FISCAL — la póliza del reembolso compensatorio de reparto (spec KDS Uber §3.1 [N-13]),
 * contra Postgres REAL.
 *
 * Cuando Uber retira un renglón, el REFUND lleva en `processorData.fiscalByRateCents` el IVA por tasa
 * calculado como DIFERENCIA de composiciones. `autoPosting` debe postear ESE reparto: con la mezcla de
 * la orden, retirar el renglón gravado de un pedido 50/50 (16 % + 0 %) contabilizaría $6.90 de IVA en
 * vez de $13.79 — la mitad del IVA devuelto se quedaría declarado como causado.
 *
 * IVA por producto, plan 4 (Ruling R9): un pedido con un renglón al 0 % marca la organización, y con IVA mixto
 * la contabilidad se pausa. La aritmética del reparto vive ahora en las unitarias de los constructores de líneas;
 * aquí queda la pausa (409, cero pólizas) y el insumo persistido del reparto.
 *
 * Vive junto a `sembrarCobroParaReembolso.ts`, que reutiliza.
 */
import prisma from '@/utils/prismaClient'
import { encenderIvaPorProducto } from '@tests/__helpers__/iva-por-producto'
import { Prisma } from '@prisma/client'
import { setupTestData, teardownTestData } from '@tests/helpers/test-data-setup'
import { writeRefundInTx, type WriteRefundInput } from '@/services/shared/writeRefundInTx'
import { generatePoliciesForVenue } from '@/services/fiscal/autoPosting.service'
import { seedBaseChart } from '@/services/fiscal/chartOfAccounts.service'
import { seedDefaultMappings } from '@/services/fiscal/accountMapping.service'
import { fiscalByRateCents, processorDataDeDevoluciones } from '@/services/fiscal/deliveryFiscalDelta'
import { limpiarVenue, sembrarCobro } from './sembrarCobroParaReembolso'

jest.setTimeout(120000)

describe('autoPosting — REFUND de reparto con fiscalByRateCents', () => {
  let venueId: string
  let staffId: string
  let organizationId: string
  let rfc: string
  let gravado: { id: string; name: string }
  let exento: { id: string; name: string }

  beforeAll(async () => {
    const testData = await setupTestData()
    venueId = testData.venue.id
    staffId = testData.staff[0].id
    organizationId = testData.organization.id
    // RFC único por corrida: el folio de las pólizas es consecutivo POR contribuyente.
    rfc = `APR${Date.now().toString(36).toUpperCase().slice(-6)}XX0`
    await prisma.venue.update({ where: { id: venueId }, data: { rfc } })
    ;[gravado, exento] = testData.products
    await prisma.product.update({ where: { id: gravado.id }, data: { taxRate: new Prisma.Decimal('0.16') } })
    // Ruling R12: el reparto por tasa necesita un producto al 0 %; el venue representa un negocio con IVA
    // por producto encendido (la fila cae con el venue en teardownTestData, FK en cascada).
    await encenderIvaPorProducto(venueId)
    await prisma.product.update({ where: { id: exento.id }, data: { taxRate: new Prisma.Decimal('0') } })
    await seedBaseChart(venueId, { staffId })
    await seedDefaultMappings(venueId, { staffId })
  })

  afterAll(async () => {
    await prisma.journalEntry.deleteMany({ where: { organizationId, rfc } }).catch(() => undefined)
    await prisma.accountMapping.deleteMany({ where: { organizationId, rfc } }).catch(() => undefined)
    await prisma.ledgerAccount.deleteMany({ where: { organizationId, rfc } }).catch(() => undefined)
    await limpiarVenue(venueId)
    await teardownTestData().catch(() => undefined)
  })

  /** Cobro de $200: $100 gravado al 16 % + $100 al 0 %, pagado por un tipo de pago con comisión. */
  const cobroMixto = () =>
    sembrarCobro({
      venueId,
      staffId,
      saleCents: 20000,
      commissionPercent: 30,
      items: [
        { productId: gravado.id, productName: gravado.name, quantity: 1, totalCents: 10000 },
        { productId: exento.id, productName: exento.name, quantity: 1, totalCents: 10000 },
      ],
    })

  // `as`: los campos del ajuste del proveedor (reparto, procedencia, generación) llegan en `extra`.
  const reembolso = (originalPaymentId: string, extra: Partial<WriteRefundInput>): WriteRefundInput =>
    ({
      originalPaymentId,
      venueId,
      salesRefundCents: 10000,
      tipRefundCents: 0,
      refundedItems: [],
      reason: 'DELIVERY_ITEM_REMOVED',
      tenderCommission: 'REVERSE_PROPORTIONAL',
      shift: 'INHERIT_ORIGINAL',
      ...extra,
    }) as WriteRefundInput

  // IVA por producto, plan 4 (Ruling R9): el producto al 0 % marca la organización (trigger del plan 1), y con IVA
  // mixto la contabilidad se PAUSA. La aritmética del reparto por tasa que estas pruebas afirmaban sobre la póliza
  // (1379 / 8621 con `fiscalByRateCents`, 690 / 9310 con la mezcla de la orden, el 🚨 con el id y la propina) se movió,
  // con los mismos importes, a las unitarias de los constructores de líneas: `tests/unit/services/autoPosting.service.test.ts`
  // («R9 · reparto por tasa»). Aquí queda lo que sólo la base prueba: la pausa y el insumo persistido de ese reparto.
  it('organización marcada (producto al 0 %): la corrida sale 409 CONTABILIDAD_IVA_MIXTO y no escribe ninguna póliza', async () => {
    const { pago, items } = await cobroMixto()
    // Uber retiró el renglón gravado: sobrevive sólo el de 0 %.
    const L = (unitPrice: number, taxRate: number) => ({ unitPrice, quantity: 1, discountAmount: 0, taxRate })
    const fiscal = fiscalByRateCents([L(100, 0.16), L(100, 0)], [L(100, 0)], 20000, 10000)
    const { refundPaymentId } = await prisma.$transaction(tx =>
      writeRefundInTx(
        tx,
        reembolso(pago.id, {
          refundedItems: [{ orderItemId: items[0].id, quantity: 1, amountCents: 10000 }],
          fiscalByRateCents: fiscal,
          provenance: 'PROVIDER_ADJUSTMENT',
          generation: 1,
        }),
      ),
    )
    const organizacion = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { ivaMixtoAlgunaVez: true } })
    expect(organizacion.ivaMixtoAlgunaVez).toBe(true)

    await expect(generatePoliciesForVenue(venueId)).rejects.toMatchObject({ statusCode: 409, code: 'CONTABILIDAD_IVA_MIXTO' })
    expect(await prisma.journalEntry.count({ where: { organizationId } })).toBe(0)

    // El insumo que la póliza leería queda persistido tal cual: el reparto de la unitaria es ESTE.
    const insumo = await processorDataDeDevoluciones(venueId, [refundPaymentId])
    expect(insumo.get(refundPaymentId)).toMatchObject({ provenance: 'PROVIDER_ADJUSTMENT', fiscalByRateCents: { '0.16': 1379 } })
  })
})
