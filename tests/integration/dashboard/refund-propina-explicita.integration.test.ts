/**
 * 🔴 DINERO — «conservar la propina del mesero» es una RESTRICCIÓN, no una sugerencia.
 *
 * El defecto que ancla (auditoría Codex gpt-6-astra, 2026-09-12): la pantalla de reembolso
 * de Android e iOS ofrece desmarcar «Incluir propina», y las dos apps mandan correctamente
 * `tipRefundCents: 0`. El servidor lo valida contra el cobro ORIGINAL y después vuelve a
 * encajar el reparto contra los componentes RESTANTES —también cuando hubo override—, así
 * que puede devolver propina que el cajero pidió respetar. La discrepancia sólo dejaba un
 * `warn` en el log: al cajero no se le volvía a preguntar y al mesero nadie le avisaba.
 *
 * El escenario, con números:
 *
 *   cobro original      $100 de venta + $20 de propina
 *   ya reembolsado      $90 de venta  + $0  de propina
 *   queda               $10 de venta  + $20 de propina
 *   el cajero pide      $20 «sin tocar la propina»
 *   ANTES               devolvía $10 de venta + $10 de PROPINA  ← la promesa rota
 *   AHORA               400, diciendo cuánto sí se puede devolver sin tocarla
 *
 * Por qué INTEGRACIÓN y no unit: el reparto se decide DENTRO de la transacción que toma el
 * `SELECT … FOR UPDATE` del cobro original y que lee sus reembolsos previos. Un mock del
 * acumulado afirmaría lo que el autor cree que hay, y es justo el acumulado —lo ya devuelto
 * de cada componente— lo que dispara el defecto.
 *
 * Requiere `TEST_DATABASE_URL` exportado (guardrail del repo, no un bug).
 */
import prisma from '@/utils/prismaClient'
import { setupTestData, teardownTestData } from '@tests/helpers/test-data-setup'
import { issueRefund } from '@/services/dashboard/refund.dashboard.service'
import { Prisma } from '@prisma/client'

jest.setTimeout(60000)

describe('Reembolso con propina excluida explícitamente', () => {
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

  /** Un cobro con propina, como el que produce cualquier venta con tarjeta. */
  async function cobrarConPropina(ventaPesos: number, propinaPesos: number) {
    const total = ventaPesos + propinaPesos
    const order = await prisma.order.create({
      data: {
        venueId,
        orderNumber: `PROP-${Date.now()}-${Math.floor(ventaPesos)}`,
        type: 'TAKEOUT',
        source: 'TPV',
        status: 'COMPLETED',
        completedAt: new Date(),
        subtotal: new Prisma.Decimal(ventaPesos),
        taxAmount: new Prisma.Decimal(0),
        total: new Prisma.Decimal(ventaPesos),
        paidAmount: new Prisma.Decimal(total),
        remainingBalance: new Prisma.Decimal(0),
        paymentStatus: 'PAID',
        createdById: staffId,
      },
    })

    return prisma.payment.create({
      data: {
        venueId,
        orderId: order.id,
        amount: new Prisma.Decimal(ventaPesos),
        tipAmount: new Prisma.Decimal(propinaPesos),
        method: 'CREDIT_CARD',
        status: 'COMPLETED',
        type: 'REGULAR',
        splitType: 'FULLPAYMENT',
        source: 'TPV',
        processedById: staffId,
        feePercentage: 0,
        feeAmount: new Prisma.Decimal(0),
        netAmount: new Prisma.Decimal(total),
      },
    })
  }

  it('🔴 no consume la propina en silencio cuando ya no queda venta suficiente', async () => {
    const cobro = await cobrarConPropina(100, 20)

    // 1) Primera devolución: $90, SÓLO de la venta. Cabe de sobra ($100 disponibles).
    await issueRefund({
      venueId,
      paymentId: cobro.id,
      amount: 9_000,
      tipRefundCents: 0,
      reason: 'RETURNED_GOODS',
      staffId,
    })

    // 2) Segunda: $20 «sin tocar la propina», pero sólo quedan $10 de venta.
    //    El servidor NO puede resolverlo tomando $10 de la propina del mesero.
    await expect(
      issueRefund({
        venueId,
        paymentId: cobro.id,
        amount: 2_000,
        tipRefundCents: 0,
        reason: 'RETURNED_GOODS',
        staffId,
      }),
    ).rejects.toThrow(/propina/i)

    // 3) Y lo que importa de verdad: NO se escribió ninguna devolución de propina.
    const reembolsos = await prisma.payment.findMany({
      where: { venueId, type: 'REFUND', orderId: cobro.orderId },
    })
    const propinaDevuelta = reembolsos.reduce((suma, r) => suma + Math.abs(Number(r.tipAmount)), 0)
    expect(propinaDevuelta).toBe(0)
    expect(reembolsos).toHaveLength(1)
  })

  it('lo que SÍ cabe sin tocar la propina se sigue devolviendo', async () => {
    const cobro = await cobrarConPropina(100, 20)

    await issueRefund({
      venueId,
      paymentId: cobro.id,
      amount: 9_000,
      tipRefundCents: 0,
      reason: 'RETURNED_GOODS',
      staffId,
    })

    // Quedan $10 de venta: pedir exactamente $10 sin propina es factible.
    await issueRefund({
      venueId,
      paymentId: cobro.id,
      amount: 1_000,
      tipRefundCents: 0,
      reason: 'RETURNED_GOODS',
      staffId,
    })

    const reembolsos = await prisma.payment.findMany({
      where: { venueId, type: 'REFUND', orderId: cobro.orderId },
    })
    const propinaDevuelta = reembolsos.reduce((suma, r) => suma + Math.abs(Number(r.tipAmount)), 0)
    const ventaDevuelta = reembolsos.reduce((suma, r) => suma + Math.abs(Number(r.amount)), 0)
    expect(propinaDevuelta).toBe(0)
    expect(ventaDevuelta).toBe(100)
  })

  /**
   * 🔴 EL RECHAZO ES DE LOS DOS LADOS — decisión del founder (2026-09-12), con la
   * recomendación de una auditoría independiente (Codex gpt-6-astra) enfrente.
   *
   * La primera versión de este guard rechazaba sólo cuando el reparto factible tomaría MÁS
   * propina de la pedida. El razonamiento era «tomar MENOS propina no puede perjudicar al
   * mesero», y era cierto —pero incompleto: **perjudica al NEGOCIO**. «Devuelve $20, todo de
   * la propina» es una instrucción exacta; sustituirla por consumo cambia lo que el cajero
   * autorizó, y lo cambia en silencio.
   *
   * El caso que lo hace concreto: el cajero devuelve $20 de propina, no está seguro de que
   * haya pasado (pantalla lenta, red intermitente) y repite. La segunda vez ya no queda
   * propina, así que el servidor sacaba los $20 del CONSUMO: el cliente se llevaba $40 y el
   * negocio perdía $20 sin que nadie se enterara.
   *
   * ⚠️ Lo que este guard NO arregla, y conviene no confundir: si TODAVÍA queda propina
   * suficiente, ese mismo reintento devuelve dos veces y aquí cabe. Eso es falta de
   * idempotencia —una llave por operación— y es trabajo aparte. Este guard cierra que el
   * servidor MIENTA sobre el concepto, no que se pueda devolver dos veces.
   */
  it('🔴 pedir propina que ya no existe se RECHAZA, no se cobra al consumo', async () => {
    const cobro = await cobrarConPropina(100, 20)

    // 1) Se devuelve la propina entera. Cabe: hay $20 de propina.
    await issueRefund({
      venueId,
      paymentId: cobro.id,
      amount: 2_000,
      tipRefundCents: 2_000,
      reason: 'RETURNED_GOODS',
      staffId,
    })

    // 2) El cajero repite la MISMA operación. Ya no queda propina: el servidor debe
    //    detenerse, no sacar los $20 del consumo.
    await expect(
      issueRefund({
        venueId,
        paymentId: cobro.id,
        amount: 2_000,
        tipRefundCents: 2_000,
        reason: 'RETURNED_GOODS',
        staffId,
      }),
    ).rejects.toThrow(/propina/i)

    const reembolsos = await prisma.payment.findMany({
      where: { venueId, type: 'REFUND', orderId: cobro.orderId },
    })
    const propinaDevuelta = reembolsos.reduce((suma, r) => suma + Math.abs(Number(r.tipAmount)), 0)
    const ventaDevuelta = reembolsos.reduce((suma, r) => suma + Math.abs(Number(r.amount)), 0)
    // Una sola fila, la legítima. Y NI UN PESO de consumo que nadie pidió devolver.
    expect(reembolsos).toHaveLength(1)
    expect(propinaDevuelta).toBe(20)
    expect(ventaDevuelta).toBe(0)
  })

  /** El mensaje tiene que servir en el mostrador: qué se devolvió ya, y cuánto queda. */
  it('el rechazo DICE lo que ya se devolvió, para que el cajero no lo reintente a ciegas', async () => {
    const cobro = await cobrarConPropina(100, 20)
    await issueRefund({
      venueId,
      paymentId: cobro.id,
      amount: 2_000,
      tipRefundCents: 2_000,
      reason: 'RETURNED_GOODS',
      staffId,
    })

    await expect(
      issueRefund({
        venueId,
        paymentId: cobro.id,
        amount: 2_000,
        tipRefundCents: 2_000,
        reason: 'RETURNED_GOODS',
        staffId,
      }),
    ).rejects.toThrow(/\$20\.00 de propina/)
  })

  /**
   * El reparto PROPORCIONAL (sin override) conserva su comportamiento: ahí re-encajar contra
   * lo que queda es lo correcto, porque nadie pidió un reparto concreto.
   */
  it('sin override, el reparto proporcional sigue re-encajándose solo', async () => {
    const cobro = await cobrarConPropina(100, 20)

    await issueRefund({
      venueId,
      paymentId: cobro.id,
      amount: 9_000,
      tipRefundCents: 0,
      reason: 'RETURNED_GOODS',
      staffId,
    })

    // Sin `tipRefundCents`: el servidor decide, y puede usar la propina.
    await issueRefund({
      venueId,
      paymentId: cobro.id,
      amount: 2_000,
      reason: 'RETURNED_GOODS',
      staffId,
    })

    const reembolsos = await prisma.payment.findMany({
      where: { venueId, type: 'REFUND', orderId: cobro.orderId },
    })
    const total = reembolsos.reduce(
      (suma, r) => suma + Math.abs(Number(r.amount)) + Math.abs(Number(r.tipAmount)),
      0,
    )
    expect(reembolsos).toHaveLength(2)
    expect(total).toBe(110)
  })
})
