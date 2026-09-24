/**
 * 🔴 DINERO FISCAL — la póliza del reembolso compensatorio de reparto (spec KDS Uber §3.1 [N-13]),
 * contra Postgres REAL.
 *
 * Cuando Uber retira un renglón, el REFUND lleva en `processorData.fiscalByRateCents` el IVA por tasa
 * calculado como DIFERENCIA de composiciones. `autoPosting` debe postear ESE reparto: con la mezcla de
 * la orden, retirar el renglón gravado de un pedido 50/50 (16 % + 0 %) contabilizaría $6.90 de IVA en
 * vez de $13.79 — la mitad del IVA devuelto se quedaría declarado como causado. Un REFUND sin el campo
 * se postea como hoy, y la póliza de la venta NO se toca.
 *
 * Vive junto a `sembrarCobroParaReembolso.ts`, que reutiliza (no hay carpeta `tests/integration/fiscal/`).
 */
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { Prisma } from '@prisma/client'
import { setupTestData, teardownTestData } from '@tests/helpers/test-data-setup'
import { writeRefundInTx, type WriteRefundInput } from '@/services/shared/writeRefundInTx'
import { generatePoliciesForVenue } from '@/services/fiscal/autoPosting.service'
import { seedBaseChart } from '@/services/fiscal/chartOfAccounts.service'
import { getMappings, seedDefaultMappings } from '@/services/fiscal/accountMapping.service'
import { fiscalByRateCents } from '@/services/fiscal/deliveryFiscalDelta'
import { limpiarVenue, sembrarCobro } from './sembrarCobroParaReembolso'

jest.setTimeout(120000)

describe('autoPosting — REFUND de reparto con fiscalByRateCents', () => {
  let venueId: string
  let staffId: string
  let organizationId: string
  let rfc: string
  let gravado: { id: string; name: string }
  let exento: { id: string; name: string }
  let cuenta: (movimiento: string) => string

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
    await prisma.product.update({ where: { id: exento.id }, data: { taxRate: new Prisma.Decimal('0') } })
    await seedBaseChart(venueId, { staffId })
    await seedDefaultMappings(venueId, { staffId })
    const { mappings } = await getMappings(venueId)
    const porMovimiento = new Map(mappings.filter(m => m.account).map(m => [m.movementType as string, m.account!.id]))
    cuenta = m => porMovimiento.get(m)!
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

  // `as`: arma a propósito ajustes del proveedor SIN reparto fiscal para probar el camino defensivo de la póliza.
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

  const poliza = (idempotencyKey: string) =>
    prisma.journalEntry.findFirstOrThrow({
      where: { organizationId, rfc, idempotencyKey },
      include: { lines: { select: { ledgerAccountId: true, debitCents: true, creditCents: true }, orderBy: { id: 'asc' } } },
    })
  const linea = (lines: { ledgerAccountId: string; debitCents: number; creditCents: number }[], movimiento: string) =>
    lines.find(l => l.ledgerAccountId === cuenta(movimiento))
  const cuadra = (lines: { debitCents: number; creditCents: number }[]) =>
    lines.reduce((s, l) => s + l.debitCents, 0) === lines.reduce((s, l) => s + l.creditCents, 0)

  it('un REFUND con fiscalByRateCents postea ESE reparto y deja intacta la poliza del cobro', async () => {
    const { pago, items } = await cobroMixto()
    await generatePoliciesForVenue(venueId)
    const ventaAntes = await poliza(`pay:${pago.id}:v1`)

    // Uber retiró el renglón gravado: sobrevive sólo el de 0 %.
    const L = (unitPrice: number, taxRate: number) => ({ unitPrice, quantity: 1, discountAmount: 0, taxRate })
    const fiscal = fiscalByRateCents([L(100, 0.16), L(100, 0)], [L(100, 0)], 20000, 10000)
    expect(fiscal).toEqual({ '0.16': 1379 })
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
    await generatePoliciesForVenue(venueId)

    const polizaRefund = await poliza(`refund:${refundPaymentId}:v1`)
    expect(cuadra(polizaRefund.lines)).toBe(true)
    expect(linea(polizaRefund.lines, 'IVA_OUTPUT')!.debitCents).toBe(1379) // no 690 (mezcla de la orden)
    expect(linea(polizaRefund.lines, 'SALES_RETURN')!.debitCents).toBe(8621)

    const ventaDespues = await poliza(`pay:${pago.id}:v1`)
    expect(ventaDespues).toEqual(ventaAntes) // misma fila, mismas líneas, mismo folio
  })

  it('un REFUND SIN fiscalByRateCents se postea como hoy (mezcla de la orden)', async () => {
    const { pago } = await cobroMixto()
    const { refundPaymentId } = await prisma.$transaction(tx =>
      writeRefundInTx(tx, reembolso(pago.id, { tenderCommission: 'NONE', staffId })),
    )
    await generatePoliciesForVenue(venueId)

    const polizaRefund = await poliza(`refund:${refundPaymentId}:v1`)
    expect(cuadra(polizaRefund.lines)).toBe(true)
    expect(linea(polizaRefund.lines, 'IVA_OUTPUT')!.debitCents).toBe(690) // $100 → 50/50 → IVA de $50 al 16 %
    expect(linea(polizaRefund.lines, 'SALES_RETURN')!.debitCents).toBe(9310)
  })

  it('un ajuste del proveedor SIN fiscalByRateCents se postea como hoy y grita 🚨 con el id', async () => {
    const error = jest.spyOn(logger, 'error')
    const { pago } = await cobroMixto()
    const { refundPaymentId } = await prisma.$transaction(tx =>
      writeRefundInTx(tx, reembolso(pago.id, { provenance: 'PROVIDER_ADJUSTMENT', generation: 1 })),
    )
    await generatePoliciesForVenue(venueId)

    const polizaRefund = await poliza(`refund:${refundPaymentId}:v1`)
    expect(linea(polizaRefund.lines, 'IVA_OUTPUT')!.debitCents).toBe(690)
    expect(error.mock.calls.some(([msg]) => String(msg).includes('🚨') && String(msg).includes(refundPaymentId))).toBe(true)
    error.mockRestore()
  })

  it('un ajuste con IVA fuera de [0, venta] NUNCA queda sin póliza: 🚨 y mezcla de la orden, propina incluida', async () => {
    // Composición que el reconciliador SÍ puede producir: el gravado llevaba $50 de descuento y el
    // superviviente no ⇒ la diferencia de IVA sale NEGATIVA ({'0.16': -689}).
    const error = jest.spyOn(logger, 'error')
    const { pago } = await sembrarCobro({
      venueId,
      staffId,
      saleCents: 20000,
      tipCents: 1000,
      commissionPercent: 30,
      items: [
        { productId: gravado.id, productName: gravado.name, quantity: 1, totalCents: 10000 },
        { productId: exento.id, productName: exento.name, quantity: 1, totalCents: 10000 },
      ],
    })
    const { refundPaymentId } = await prisma.$transaction(tx =>
      writeRefundInTx(
        tx,
        reembolso(pago.id, { tipRefundCents: 500, fiscalByRateCents: { '0.16': -689 }, provenance: 'PROVIDER_ADJUSTMENT', generation: 1 }),
      ),
    )
    await generatePoliciesForVenue(venueId)

    const polizaRefund = await poliza(`refund:${refundPaymentId}:v1`)
    expect(cuadra(polizaRefund.lines)).toBe(true)
    expect(linea(polizaRefund.lines, 'IVA_OUTPUT')!.debitCents).toBe(690) // mezcla de la orden
    expect(linea(polizaRefund.lines, 'SALES_RETURN')!.debitCents).toBe(9310)
    expect(linea(polizaRefund.lines, 'TIPS_PAYABLE')!.debitCents).toBe(500)
    expect(error.mock.calls.some(([msg]) => String(msg).includes('🚨') && String(msg).includes(refundPaymentId))).toBe(true)
    error.mockRestore()
  })
})
