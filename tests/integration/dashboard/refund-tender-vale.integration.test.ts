/**
 * 🔴 DINERO — reembolso de un VALE que SÍ entra al cajón, contra Postgres REAL.
 *
 * El bug que ancla: el reembolso heredaba `method` del pago original pero NINGÚN snapshot
 * del tipo del catálogo. Un vale con `countsAsPhysicalCash: true` se cobra como
 * `method = OTHER` y suma efectivo FÍSICO al cajón; su reembolso, sin el snapshot, caía al
 * fallback legacy (`method === 'CASH'` = false) → el arqueo seguía esperando un efectivo que
 * YA había salido. Un faltante inventado, y en la dirección que acusa al cajero.
 *
 * Por qué INTEGRACIÓN y no unit: los tests con mocks ya cubren la forma del `payment.create`,
 * pero afirman lo que el autor CREE que hace la consulta. Aquí el pago original se escribe de
 * verdad, `issueRefund` lo lee con su `SELECT ... FOR UPDATE` real, y el cajón se consulta
 * como lo consulta el arqueo. Es la diferencia que destapó el filtro `REGULAR` del reporte de
 * comisiones, que los mocks habían dado por bueno.
 *
 * Requiere `TEST_DATABASE_URL` exportado (guardrail del repo, no un bug).
 */
import prisma from '@/utils/prismaClient'
import { setupTestData, teardownTestData } from '@tests/helpers/test-data-setup'
import { issueRefund } from '@/services/dashboard/refund.dashboard.service'
import { paymentCountsAsDrawerCash } from '@/services/shared/tenderSemantics'
import { Prisma } from '@prisma/client'

jest.setTimeout(60000)

describe('Reembolso de un tipo de pago que entra al cajón (vale)', () => {
  let testData: Awaited<ReturnType<typeof setupTestData>>
  let venueId: string
  let staffId: string

  beforeAll(async () => {
    testData = await setupTestData()
    venueId = testData.venue.id
    staffId = testData.staff[0].id
  })

  afterAll(async () => {
    await teardownTestData()
  })

  /** Da de alta el tipo "Vale de despensa" con su revisión 1, como lo hace el dashboard. */
  async function crearVale() {
    const tender = await prisma.venueTenderType.create({
      data: {
        venueId,
        name: 'Vale de despensa',
        normalizedName: `vale-de-despensa-${Date.now()}`,
        baseMethod: 'OTHER',
        isSystem: false,
        countsAsPhysicalCash: true, // 🔑 ESTE es el caso: el papel entra al cajón
        captureTip: false,
        showOnPos: true,
        posSection: 'MORE',
        displayOrder: 50,
        satFormaPago: '05',
        revision: 1,
      },
    })
    await prisma.venueTenderTypeRevision.create({
      data: {
        venueId,
        tenderTypeId: tender.id,
        revision: 1,
        name: 'Vale de despensa',
        countsAsPhysicalCash: true,
        captureTip: false,
        commissionPercent: null,
        satFormaPago: '05',
        createdBy: null,
      },
    })
    return tender
  }

  /** Un cobro ya ocurrido con ese vale: exactamente lo que estampa `payCashOrder`/`fast`. */
  async function cobrarConVale(tenderId: string, montoPesos: number) {
    const order = await prisma.order.create({
      data: {
        venueId,
        orderNumber: `VALE-${Date.now()}`,
        type: 'TAKEOUT',
        source: 'TPV',
        status: 'COMPLETED',
        completedAt: new Date(),
        subtotal: new Prisma.Decimal(montoPesos),
        taxAmount: new Prisma.Decimal(0),
        total: new Prisma.Decimal(montoPesos),
        paidAmount: new Prisma.Decimal(montoPesos),
        remainingBalance: new Prisma.Decimal(0),
        paymentStatus: 'PAID',
        createdById: staffId,
      },
    })

    return prisma.payment.create({
      data: {
        venueId,
        orderId: order.id,
        amount: new Prisma.Decimal(montoPesos),
        tipAmount: new Prisma.Decimal(0),
        method: 'OTHER', // el vale se registra como OTHER; el NOMBRE es la capa de reporte
        status: 'COMPLETED',
        type: 'FAST',
        splitType: 'FULLPAYMENT',
        source: 'TPV',
        processedById: staffId,
        feePercentage: 0,
        feeAmount: new Prisma.Decimal(0),
        netAmount: new Prisma.Decimal(montoPesos),
        tenderTypeId: tenderId,
        tenderRevision: 1,
        tenderLabel: 'Vale de despensa',
        tenderCountsAsCash: true,
        tenderCaptureTip: false,
        tenderSatFormaPago: '05',
        fundsFlow: 'CASH_DRAWER',
      },
    })
  }

  it('🔴 el reembolso hereda "entra al cajón": el arqueo no puede exigir un efectivo que ya salió', async () => {
    const vale = await crearVale()
    const cobro = await cobrarConVale(vale.id, 200)

    const resultado = await issueRefund({
      venueId,
      paymentId: cobro.id,
      amount: 20000, // $200.00 en centavos
      reason: 'RETURNED_GOODS',
      staffId,
    })

    const reembolso = await prisma.payment.findFirst({
      where: { venueId, type: 'REFUND', orderId: cobro.orderId },
      orderBy: { createdAt: 'desc' },
    })

    expect(reembolso).not.toBeNull()
    // Identidad heredada: sin esto el desglose del corte agrupa la devolución aparte
    // de su venta y el neto POR TIPO miente.
    expect(reembolso!.tenderTypeId).toBe(vale.id)
    expect(reembolso!.tenderLabel).toBe('Vale de despensa')
    // Y lo que de verdad cuadra el dinero: el predicado compartido — la ÚNICA autoridad
    // sobre "¿este dinero estaba en el cajón?" — tiene que decir que SÍ.
    expect(paymentCountsAsDrawerCash(reembolso!)).toBe(true)
    expect(reembolso!.fundsFlow).toBe('CASH_DRAWER')
    // El monto va en negativo, como todo reembolso.
    expect(Number(reembolso!.amount)).toBe(-200)
    expect(resultado).toBeTruthy()
  })

  it('la comisión NO se hereda: inventar que la plataforma la devuelve sería un ahorro falso', async () => {
    const vale = await crearVale()
    const cobro = await cobrarConVale(vale.id, 100)

    await issueRefund({ venueId, paymentId: cobro.id, amount: 10000, reason: 'RETURNED_GOODS', staffId })

    const reembolso = await prisma.payment.findFirst({
      where: { venueId, type: 'REFUND', orderId: cobro.orderId },
      orderBy: { createdAt: 'desc' },
    })

    expect(reembolso!.tenderCommissionAmount).toBeNull()
    expect(reembolso!.tenderCommissionPercent).toBeNull()
  })

  // REGRESIÓN: un cobro clásico en efectivo no gana campos de tender por accidente.
  it('un reembolso de efectivo normal sigue sin campos de tipo de pago', async () => {
    const order = await prisma.order.create({
      data: {
        venueId,
        orderNumber: `EFE-${Date.now()}`,
        type: 'TAKEOUT',
        source: 'TPV',
        status: 'COMPLETED',
        completedAt: new Date(),
        subtotal: new Prisma.Decimal(50),
        taxAmount: new Prisma.Decimal(0),
        total: new Prisma.Decimal(50),
        paidAmount: new Prisma.Decimal(50),
        remainingBalance: new Prisma.Decimal(0),
        paymentStatus: 'PAID',
        createdById: staffId,
      },
    })
    const cobro = await prisma.payment.create({
      data: {
        venueId,
        orderId: order.id,
        amount: new Prisma.Decimal(50),
        tipAmount: new Prisma.Decimal(0),
        method: 'CASH',
        status: 'COMPLETED',
        type: 'FAST',
        splitType: 'FULLPAYMENT',
        source: 'TPV',
        processedById: staffId,
        feePercentage: 0,
        feeAmount: new Prisma.Decimal(0),
        netAmount: new Prisma.Decimal(50),
      },
    })

    await issueRefund({ venueId, paymentId: cobro.id, amount: 5000, reason: 'RETURNED_GOODS', staffId })

    const reembolso = await prisma.payment.findFirst({
      where: { venueId, type: 'REFUND', orderId: order.id },
      orderBy: { createdAt: 'desc' },
    })

    expect(reembolso!.tenderTypeId).toBeNull()
    expect(reembolso!.tenderLabel).toBeNull()
    // El efectivo sigue contando como cajón por el fallback legacy — comportamiento intacto.
    expect(paymentCountsAsDrawerCash(reembolso!)).toBe(true)
  })
})
