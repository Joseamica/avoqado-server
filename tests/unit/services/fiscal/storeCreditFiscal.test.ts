/**
 * Saldo a favor en lo fiscal (spec 2026-10-30-saldo-a-favor §5.3, tarea S3). La devolución a saldo es una devolución de la VENTA: resta
 * el ingreso, pero su alcance fiscal (método y comercio) es el del cobro original o de su raíz, nunca el del destino. Al gastar el
 * saldo, la venta nueva entra como ingreso normal: el ingreso se cuenta UNA vez.
 *
 * Lo que protege:
 * - el autoposteo no inventa una salida del banco (BANK_RECEIPT): la deja en «pendientes de revisión contable», como las tarjetas;
 * - el estado de resultados (con el cargador de libros real): el efectivo fuera de libros y el comercio fuera de la contabilidad
 *   también sacan la devolución a saldo de su venta; y 500 − 200 a saldo + 200 del canje = ingreso e IVA de 500;
 * - la nota de crédito sale con forma de pago 17 (Compensación), la del medio de saldo a favor.
 */
import { OrderStatus, PaymentMethod, PaymentType, Prisma } from '@prisma/client'

jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn() },
    payment: { findMany: jest.fn() },
    fiscalEmisor: { findFirst: jest.fn() },
    journalEntry: { findMany: jest.fn() },
    organization: { findUnique: jest.fn() },
  },
}))
jest.mock('../../../../src/services/fiscal/chartOfAccounts.service', () => ({ resolveScopeOrNull: jest.fn() }))
jest.mock('../../../../src/services/fiscal/accountMapping.service', () => ({ getMappings: jest.fn() }))
jest.mock('../../../../src/services/fiscal/journalEntry.service', () => ({ postJournalEntry: jest.fn() }))
jest.mock('../../../../src/services/fiscal/cogs.service', () => ({
  generateCogsPolicyForVenue: jest.fn(),
  computePeriodCogsCents: jest.fn(),
}))
jest.mock('@/services/giftCards/giftCardLedger', () => ({
  ...jest.requireActual('@/services/giftCards/giftCardLedger'),
  prepararSobreDeSaldoAFavorEnTx: jest.fn(),
}))

import prisma from '../../../../src/utils/prismaClient'
import { resolveScopeOrNull } from '../../../../src/services/fiscal/chartOfAccounts.service'
import { getMappings } from '../../../../src/services/fiscal/accountMapping.service'
import { postJournalEntry } from '../../../../src/services/fiscal/journalEntry.service'
import { esPendienteDeRevisionContable, generatePoliciesForVenue } from '../../../../src/services/fiscal/autoPosting.service'
import { esDevolucionASaldoAFavor } from '../../../../src/services/fiscal/fiscalScope'
import { estadoDeResultadosEnFoto } from '../../../../src/services/dashboard/accounting.dashboard.service'
import { recorrerLibros } from '../../../../src/services/fiscal/librosDeOrdenes'
import { formaPagoDeLaNota, type LoadedRefundForCreditNote } from '../../../../src/services/fiscal/cfdiCreditNote.service'
import { writeRefundInTx, type CobroBloqueado, type WriteRefundInput } from '../../../../src/services/dashboard/refund.dashboard.service'
import { prepararSobreDeSaldoAFavorEnTx } from '@/services/giftCards/giftCardLedger'

const p = prisma as unknown as {
  venue: { findUnique: jest.Mock }
  payment: { findMany: jest.Mock }
  fiscalEmisor: { findFirst: jest.Mock }
  journalEntry: { findMany: jest.Mock }
  organization: { findUnique: jest.Mock }
}
const MOVIMIENTOS = ['SALES_REVENUE', 'SALES_RETURN', 'IVA_OUTPUT', 'CASH_RECEIPT', 'BANK_RECEIPT', 'TIPS_PAYABLE', 'PROCESSOR_FEE']
const T = new Date('2026-10-15T18:00:00.000Z')
const despues = (min: number) => new Date(T.getTime() + min * 60_000)

describe('esDevolucionASaldoAFavor', () => {
  it.each([
    ['devolución con el medio STORE_CREDIT (autoposteo)', { type: 'REFUND', tenderType: { systemKind: 'STORE_CREDIT' } }, true],
    ['devolución con el medio STORE_CREDIT (libros)', { type: 'REFUND', tenderSystemKind: 'STORE_CREDIT' }, true],
    ['cobro con el medio STORE_CREDIT (no existe, pero no es devolución)', { type: 'REGULAR', tenderSystemKind: 'STORE_CREDIT' }, false],
    ['devolución de saldo de regalo', { type: 'REFUND', tenderType: { systemKind: 'GIFT_CARD' } }, false],
    ['devolución del crédito de un cambio', { type: 'REFUND', tenderSystemKind: 'EXCHANGE_CREDIT' }, false],
    ['devolución sin medio', { type: 'REFUND', tenderType: null }, false],
  ])('%s', (_n, fila, esperado) => {
    expect(esDevolucionASaldoAFavor(fila)).toBe(esperado)
  })
})

describe('autoposteo', () => {
  const devolucionASaldo = {
    id: 'r-saldo',
    amount: -200,
    tipAmount: 0,
    feeAmount: 0,
    method: PaymentMethod.OTHER,
    type: PaymentType.REFUND,
    createdAt: T,
    merchantAccount: null,
    ecommerceMerchant: null,
    tenderType: { systemKind: 'STORE_CREDIT' },
    order: {
      status: OrderStatus.COMPLETED,
      orderNumber: '7',
      items: [{ id: 'i1', quantity: 1, unitPrice: 500, total: 500, discountAmount: 0, giftCardId: null, product: { taxRate: 0.16 } }],
      orderDiscounts: [],
      serviceCharges: [],
    },
  }
  beforeEach(() => {
    jest.clearAllMocks()
    ;(resolveScopeOrNull as jest.Mock).mockResolvedValue({ organizationId: 'org1', rfc: 'RFC', venueType: 'RETAIL' })
    ;(getMappings as jest.Mock).mockResolvedValue({
      mappings: MOVIMIENTOS.map(m => ({ movementType: m, account: { id: `acc:${m}`, code: m } })),
    })
    p.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City' })
    p.fiscalEmisor.findFirst.mockResolvedValue({ includeCashInAccounting: true })
    p.journalEntry.findMany.mockResolvedValue([])
    p.organization.findUnique.mockResolvedValue({ ivaMixtoAlgunaVez: false })
    ;(postJournalEntry as jest.Mock).mockResolvedValue({ id: 'je1' })
  })

  it('autoposteo la deja en pendientes de revisión contable, sin BANK_RECEIPT', async () => {
    p.payment.findMany.mockResolvedValueOnce([devolucionASaldo]).mockResolvedValue([])
    const r = await generatePoliciesForVenue('v1')
    expect(r).toMatchObject({ candidates: 1, posted: 0, pendientesDeRevision: 1 })
    // Una devolución que no es efectivo saldría contra el banco: el saldo a favor no salió de ningún banco.
    expect(postJournalEntry).not.toHaveBeenCalled()
    expect(esPendienteDeRevisionContable(devolucionASaldo)).toBe(true)
  })
})

describe('estado de resultados con el cargador de libros real', () => {
  // La transacción del reporte: sólo lecturas. El enumerador, el conteo, los descuentos y los campos de las devoluciones van por SQL.
  const tx = {
    fiscalEmisor: { findFirst: jest.fn() },
    $queryRaw: jest.fn(),
    order: { findMany: jest.fn() },
    orderItem: { findMany: jest.fn() },
    payment: { findMany: jest.fn() },
  }
  type Mov = Record<string, unknown> & { id: string; orderId: string }
  let movimientos: Mov[] = []
  let devoluciones: Array<Record<string, unknown>> = []
  const renglon = (orderId: string, total: number) => ({
    id: `oi-${orderId}`,
    orderId,
    quantity: 1,
    unitPrice: total,
    total,
    discountAmount: 0,
    orderPromotionId: null,
    isCortesia: false,
    ivaTratamiento: null,
    product: { taxRate: 0.16, ivaTratamiento: 'IVA_16' },
  })
  const renglones: Record<string, ReturnType<typeof renglon>> = { o1: renglon('o1', 500), o2: renglon('o2', 200) }
  const mov = (o: Mov): Mov => ({
    createdAt: T,
    type: 'REGULAR',
    tipAmount: 0,
    method: 'CREDIT_CARD',
    tenderType: null,
    merchantAccount: null,
    ecommerceMerchant: null,
    ...o,
  })
  /** La devolución a saldo de $200 de la venta o1, como la escribe `writeRefundInTx`: medio STORE_CREDIT, sin comercio. */
  const devolucionASaldo = (originalMethod: string, incluirOrigen: boolean | null) => {
    devoluciones = [{ id: 'r1', provenance: 'MANUAL', originalMethod, fiscalByRateCents: null, refundedItems: null, incluirOrigen }]
    return mov({
      id: 'r1',
      orderId: 'o1',
      createdAt: despues(5),
      type: 'REFUND',
      amount: -200,
      method: 'OTHER',
      tenderType: { systemKind: 'STORE_CREDIT' },
    })
  }
  const ordenesDe = () => [...new Set(movimientos.map(m => m.orderId))].sort()

  beforeEach(() => {
    jest.clearAllMocks()
    movimientos = []
    devoluciones = []
    tx.fiscalEmisor.findFirst.mockResolvedValue(null) // sin emisor ⇒ el efectivo fuera de los libros fiscales (default)
    tx.order.findMany.mockImplementation(async (a: any) =>
      a.where.id.in.map((id: string) => ({ id, discountAmount: 0, contratoDePrecio: 'IVA_INCLUIDO', originSystem: 'AVOQADO' })),
    )
    tx.orderItem.findMany.mockImplementation(async (a: any) => (a.where.id ? [] : a.where.orderId.in.map((id: string) => renglones[id])))
    tx.payment.findMany.mockImplementation(async (a: any) => movimientos.filter(m => a.where.orderId.in.includes(m.orderId)))
    tx.$queryRaw.mockImplementation(async (s: Prisma.Sql) => {
      if (s.sql.includes('WITH ORDINALITY')) return devoluciones
      if (s.sql.includes('AS reparto')) return []
      if (s.sql.includes('jsonb_object_keys'))
        return ordenesDe().map(orderId => ({
          orderId,
          folio: orderId,
          renglones: 1,
          descuentos: 0,
          destinos: 0,
          movimientos: movimientos.filter(m => m.orderId === orderId).length,
          articulos: 0,
          articulosPorDevolucion: 0,
          bytesDelCongelado: 0,
          bytesDeRepartos: 0,
        }))
      return ordenesDe().map(orderId => ({ orderId })) // la enumeración del periodo
    })
  })
  const estado = () =>
    estadoDeResultadosEnFoto(
      tx as unknown as Prisma.TransactionClient,
      { id: 'v1', name: 'IQ', timezone: 'America/Mexico_City' },
      {
        from: '2026-10-01',
        to: '2026-10-31',
      },
    )

  it('venta 500 − devolución a saldo 200 + venta del canje 200 = ingreso e IVA de 500 una sola vez', async () => {
    movimientos = [
      mov({ id: 'p1', orderId: 'o1', amount: 500, merchantAccount: { fiscalConfig: { includeInAccounting: true } } }),
      devolucionASaldo('CREDIT_CARD', true),
      // El canje: la venta nueva pagada con el saldo (medio de tarjetas), en otra orden.
      mov({ id: 'p2', orderId: 'o2', createdAt: despues(10), amount: 200, method: 'OTHER', tenderType: { systemKind: 'GIFT_CARD' } }),
    ]
    const r = await estado()
    // IVA de $500 (16 % incluido): 500 − 500/1.16 = $68.97, una sola vez.
    expect(r.fiscalRevenue).toMatchObject({ grossSalesCents: 70000, refundsCents: 20000, netRevenueCents: 50000, ivaCents: 6897 })
    expect(r.revenue).toMatchObject({ netRevenueCents: 50000, ivaCents: 6897 })
  })

  it('negocio con efectivo fuera de libros: la devolución a saldo de una venta en efectivo no resta', async () => {
    movimientos = [mov({ id: 'p1', orderId: 'o1', amount: 500, method: 'CASH' }), devolucionASaldo('CASH', null)]
    const r = await estado()
    expect(r.fiscalRevenue).toMatchObject({ grossSalesCents: 0, refundsCents: 0, netRevenueCents: 0, ivaCents: 0 })
    // El gerencial lo ve todo.
    expect(r.revenue).toMatchObject({ grossSalesCents: 50000, refundsCents: 20000 })
  })

  it('comercio con includeInAccounting=false: su venta devuelta a saldo no resta', async () => {
    movimientos = [
      mov({ id: 'p1', orderId: 'o1', amount: 500, merchantAccount: { fiscalConfig: { includeInAccounting: false } } }),
      // La fila no lleva comercio (los lectores de banco creerían que el banco devolvió): el alcance sale del cobro original.
      devolucionASaldo('CREDIT_CARD', false),
    ]
    const r = await estado()
    expect(r.fiscalRevenue).toMatchObject({ grossSalesCents: 0, refundsCents: 0, netRevenueCents: 0, ivaCents: 0 })
    expect(r.revenue).toMatchObject({ grossSalesCents: 50000, refundsCents: 20000 })
  })

  it('el cargador lee el interruptor del comercio del cobro de ORIGEN (la raíz o el original), sin tocar el processorData', async () => {
    movimientos = [mov({ id: 'p1', orderId: 'o1', amount: 500 }), devolucionASaldo('CREDIT_CARD', false)]
    const vistos: Array<Record<string, unknown>> = []
    await recorrerLibros(tx as unknown as Prisma.TransactionClient, { venueId: 'v1', orderIds: ['o1'], hasta: despues(60) }, m =>
      vistos.push(m as unknown as Record<string, unknown>),
    )
    const r1 = vistos.find(m => m.id === 'r1')!
    expect(r1).toMatchObject({ tenderSystemKind: 'STORE_CREDIT', incluirEnContabilidad: false })
    expect(r1.processorData).toEqual({ provenance: 'MANUAL', originalMethod: 'CREDIT_CARD', fiscalByRateCents: null, refundedItems: null })
    const sql = (tx.$queryRaw.mock.calls.map(c => c[0] as Prisma.Sql).find(s => s.sql.includes('WITH ORDINALITY')) as Prisma.Sql).sql
    expect(sql).toContain(`COALESCE(p."processorData" ->> 'rootPaymentId', p."processorData" ->> 'originalPaymentId')`)
    expect(sql).toContain('"MerchantFiscalConfig"')
    // Minor 13 (S10): la subconsulta correlacionada sólo se calcula para las devoluciones a saldo a favor (CASE por el medio).
    expect(sql).toMatch(
      /CASE WHEN NOT EXISTS \(SELECT 1 FROM "VenueTenderType" sc_t [^)]*'STORE_CREDIT'\) THEN NULL ELSE \(SELECT coalesce\(mfc\."includeInAccounting"/,
    )
    // Las demás devoluciones siguen con el interruptor de su propia fila.
    expect(vistos.find(m => m.id === 'p1')).not.toHaveProperty('incluirOrigen')
  })
})

describe('la nota de crédito', () => {
  it('la nota de crédito sale con forma 17', async () => {
    const create = jest.fn().mockResolvedValue({ id: 'r1' })
    const ftx = {
      shift: {
        findFirst: jest.fn().mockResolvedValue({ id: 's1', status: 'OPEN' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      payment: { create, update: jest.fn(), findFirst: jest.fn() },
      // develop (pedidos fase 2): la devolución sólo lleva su movimiento si el cobro original tiene el suyo.
      venueTransaction: { findUnique: jest.fn().mockResolvedValue({ id: 'cmviy09ma0009mywab26u6rlw' }), create: jest.fn() },
    }
    ;(prepararSobreDeSaldoAFavorEnTx as jest.Mock).mockResolvedValue({ venueId: 'v1', customerId: 'c1', sobre: null })
    const bloqueado = {
      original: {
        id: 'p1',
        venueId: 'v1',
        status: 'COMPLETED',
        type: 'REGULAR',
        method: 'CREDIT_CARD',
        source: 'TPV',
        amount: 500,
        tipAmount: 0,
        orderId: 'o1',
        shiftId: null,
        merchantAccountId: 'm1',
        processorData: {},
        fundsFlow: 'AVOQADO_PROCESSED',
        externalSource: null,
        tenderTypeId: null,
        tenderCountsAsCash: null,
        tenderRevision: null,
        tenderLabel: null,
        tenderCaptureTip: null,
        tenderSatFormaPago: null,
        tenderCommissionPercent: null,
        tenderSystemKind: null,
      },
      existingRefunds: [],
      alreadyRefundedCents: 0,
      refundedSalesCents: 0,
      refundedTipsCents: 0,
      unclassifiedPriorRefundCents: 0,
      remainingBeforeCents: 50000,
    } as unknown as CobroBloqueado
    await writeRefundInTx(
      ftx as unknown as Prisma.TransactionClient,
      {
        originalPaymentId: 'p1',
        venueId: 'v1',
        salesRefundCents: 20000,
        tipRefundCents: 0,
        refundedItems: [],
        reason: 'RETURNED_GOODS',
        tenderCommission: 'NONE',
        shift: 'CLAIM_LIVE',
        provenance: 'MANUAL',
        bloqueado,
        aSaldoAFavor: {
          tender: {
            method: 'OTHER',
            fundsFlow: 'EXTERNAL_RECORDED',
            merchantAccountId: null,
            source: 'OTHER',
            tenderTypeId: 'sc',
            tenderRevision: 1,
            tenderLabel: 'Saldo a favor',
            tenderCountsAsCash: false,
            tenderCaptureTip: false,
            tenderSatFormaPago: '17',
          },
          customerId: 'c1',
          abonar: jest.fn().mockResolvedValue({}),
        },
      } as WriteRefundInput,
    )
    const fila = create.mock.calls[0][0].data
    // La venta original se pagó con tarjeta (04): la nota dice cómo se devolvió, y se devolvió como saldo (17, Compensación).
    const loaded = {
      original: { formaPago: '04' },
      refund: { method: fila.method, tenderSatFormaPago: fila.tenderSatFormaPago ?? null, processorData: fila.processorData },
    } as LoadedRefundForCreditNote
    expect(formaPagoDeLaNota(loaded)).toBe('17')
  })
})
