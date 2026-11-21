/**
 * Máquina de efectivo 1a · ronda 8 de Codex sobre el SERVIDOR (`docs/audit/2026-11-17-maquina-de-efectivo/codex-codigo-servidor-r8.md`).
 * El caso: la máquina cotizó la clase ($187.50), recepción registró la llegada y cobró esa misma clase antes del cierre de la máquina, y
 * el cierre llegó con $200 recibidos y $12.50 de cambio: $375 por una clase de $187.50.
 *
 * Recorte R6 de la 1a (La Galeterie no vende reservas en la máquina): un carrito ligado a una reserva o clase NUNCA se cobra en la
 * máquina. La cotización lo rechaza antes que nada (`RESERVA`) y, si una PC vieja o sin red cobró igual, su cierre nunca es venta: el
 * dinero queda como incidencia `NO_SE_PUDO_REGISTRAR` con motivo `RESERVA`, una sola vez.
 */
jest.mock('@/services/tpv/paymentEffects.service', () => ({
  ...jest.requireActual('@/services/tpv/paymentEffects.service'),
  enqueuePaymentCommissionInTx: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/services/venueSalesGuard', () => ({ __esModule: true, assertVenueSalesEnabled: jest.fn() }))
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/services/inventory/inventoryPosting.service', () => ({
  createSalePostingInTx: jest.fn().mockResolvedValue(null),
  applySalePosting: jest.fn().mockResolvedValue(null),
}))
jest.mock('@/services/shared/loyaltyOnPaidOrder', () => ({ awardLoyaltyForPaidOrder: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/kds/kitchenDisplayStations', () => ({
  ...jest.requireActual('@/services/kds/kitchenDisplayStations'),
  debeMarcarCocina: jest.fn().mockResolvedValue(false),
}))
jest.mock('@/services/mobile/areaTicketV7.mobile.service', () => ({
  lockAreaTicketCheckoutForPayment: jest.fn().mockResolvedValue(null),
  finalizeAreaTicketPaymentInTransaction: jest.fn().mockResolvedValue({ areaTicketOrder: false }),
}))
jest.mock('@/services/shared/paymentShiftClaim', () => ({
  ...jest.requireActual('@/services/shared/paymentShiftClaim'),
  resolvePaymentShiftReconciliationEnabled: jest.fn().mockResolvedValue(false),
}))

import { cotizarParaLaMaquina } from '@/services/cashMachine/cotizacionDeLaMaquina'
import { registrarVentaDeLaMaquina } from '@/services/cashMachine/ventaDeLaMaquina'
import type { CreateOrderInput } from '@/services/mobile/order.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'
import { CARRITO, PC, REF, VENUE, cierre, lector, prepararArnes, type Arnes } from '../../../__helpers__/arnesDeLaMaquina'

let a: Arnes
beforeEach(() => {
  jest.clearAllMocks()
  a = prepararArnes(prismaMock)
})

/** La cajera inscribió a la persona en la clase: el producto de $187.50 va en el carrito ligado a su reserva. */
const CLASE = { ...CARRITO, staffId: 'staff-cajera', reservationId: 'res-1' }

describe('Codex servidor r8 · una reserva o clase nunca se cobra en la máquina (recorte R6 de la 1a)', () => {
  it('🔴 paso 1: la cotización de la clase se rechaza con RESERVA, sin quoteId y antes de leer nada (la PC nunca manda el paycash)', async () => {
    const q = await cotizarParaLaMaquina(VENUE, CLASE as unknown as CreateOrderInput, { carrito: CLASE })
    expect(q).toEqual({
      quoteId: null,
      expiresAt: null,
      totalCents: null,
      saleCents: null,
      tipCents: null,
      discountCents: null,
      renglones: [],
      cobrableEnMaquina: false,
      motivo: 'RESERVA',
    })
    expect(prismaMock.order.findFirst).not.toHaveBeenCalled()
    expect(prismaMock.product.findMany).not.toHaveBeenCalled()
  })

  it('🔴 paso 3: una PC vieja o sin red cobró igual ($200, $12.50 de cambio) → el cierre nunca es venta: incidencia RESERVA con su dinero, una vez', async () => {
    const r = await registrarVentaDeLaMaquina(VENUE, PC, { referenceCC: REF, cierre: cierre(), pedido: CLASE }, lector)
    expect(r).toMatchObject({
      status: 202,
      body: { ack: 'TERMINADO', incident: 'NO_SE_PUDO_REGISTRAR', motivo: 'RESERVA', creditCents: 20000, changeDispensedCents: 1250 },
    })
    // Nunca se intenta la venta: ni cuenta ni pago (el índice de una cuenta viva por reserva sigue como última línea).
    expect(prismaMock.order.create).not.toHaveBeenCalled()
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
    expect(a.base.cierres).toEqual([
      expect.objectContaining({
        motivoSinRegistro: 'RESERVA',
        creditCents: 20000,
        changeDispensedCents: 1250,
        orderId: null,
        paymentId: null,
      }),
    ])
    expect(a.base.incidencias).toEqual([
      expect.objectContaining({
        kind: 'NO_SE_PUDO_REGISTRAR',
        payload: expect.objectContaining({ eventos: [expect.objectContaining({ motivo: 'RESERVA' })] }),
      }),
    ])

    // El reenvío del mismo cierre contesta lo mismo y no escribe nada nuevo.
    await expect(registrarVentaDeLaMaquina(VENUE, PC, { referenceCC: REF, cierre: cierre(), pedido: CLASE }, lector)).resolves.toEqual(r)
    expect(a.base.cierres).toHaveLength(1)
    expect(a.base.incidencias).toHaveLength(1)
    expect(prismaMock.payment.create).not.toHaveBeenCalled()
  })

  it('sin reserva, el mismo cierre sigue siendo venta (regresión)', async () => {
    expect(await registrarVentaDeLaMaquina(VENUE, PC, { referenceCC: REF, cierre: cierre(), pedido: CARRITO }, lector)).toMatchObject({
      status: 200,
      body: { ack: 'TERMINADO' },
    })
    expect(prismaMock.payment.create).toHaveBeenCalledTimes(1)
  })
})
