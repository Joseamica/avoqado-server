/**
 * Etapa 3 del KDS (spec 2026-09-27 §2): el cobro desde Android/iOS (efectivo, transferencia, métodos propios; y el
 * PAY_CASH de la cola offline, que usa la misma función) arma la comanda de pantalla AL SALDAR. La marca durable
 * viaja en la MISMA escritura que salda la cuenta; un abono parcial no arma nada; sin pantalla, nada cambia.
 */
// FT-GRAVES S-EF: payCashOrder encola la comisión del cobro en su transacción, igual que la terminal. No es objeto de esta
// suite (su prueba es tests/integration/commission/efectivoPosMovil.integration.test.ts).
jest.mock('@/services/tpv/paymentEffects.service', () => ({
  ...jest.requireActual('@/services/tpv/paymentEffects.service'),
  enqueuePaymentCommissionInTx: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/services/venueSalesGuard', () => ({ __esModule: true, assertVenueSalesEnabled: jest.fn() }))
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn(() => null) } }))
jest.mock('@/services/dashboard/receipt.dashboard.service', () => ({
  generateAndStoreReceipt: jest.fn().mockResolvedValue({ id: 'receipt-1' }),
}))
const resolverTerminalMock = jest.fn()
jest.mock('@/services/tpv/payment.tpv.service', () => ({
  mapDigitalReceiptResponse: jest.fn(() => null),
  resolveAutofacturaAvailable: jest.fn().mockResolvedValue(false),
  resolveTerminalIdFromSerial: (...a: unknown[]) => resolverTerminalMock(...a),
}))
jest.mock('@/services/inventory/inventoryPosting.service', () => ({
  createSalePostingInTx: jest.fn().mockResolvedValue(null),
  applySalePosting: jest.fn().mockResolvedValue(null),
}))
jest.mock('@/services/dashboard/autoReorder.service', () => ({ runAutoReorderForVenue: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/referrals/referralQualification.service', () => ({ onOrderPaid: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/shared/loyaltyOnPaidOrder', () => ({ awardLoyaltyForPaidOrder: jest.fn().mockResolvedValue(undefined) }))
jest.mock('@/services/tpv/table.tpv.service', () => ({ releaseTableIfSettled: jest.fn() }))

const debeMarcarCocinaMock = jest.fn()
jest.mock('@/services/kds/kitchenDisplayStations', () => ({ debeMarcarCocina: (...a: unknown[]) => debeMarcarCocinaMock(...a) }))
const armarMock = jest.fn()
jest.mock('@/services/kds/kitchenTicketAuthoring.service', () => ({ armarComandasTrasCommit: (...a: unknown[]) => armarMock(...a) }))
const logActionMock = jest.fn()
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: (...a: unknown[]) => logActionMock(...a) }))

import { Decimal } from '@prisma/client/runtime/library'
import { MINUTOS_PARA_COMANDA_DE_LA_COLA, payCashOrder } from '@/services/mobile/order.mobile.service'
import { prismaMock } from '../../../__helpers__/setup'
import { releaseTableIfSettled } from '@/services/tpv/table.tpv.service'

function seedOrder(tableId: string | null = null) {
  prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
  prismaMock.order.findUnique.mockResolvedValue({
    id: 'order-1',
    orderNumber: 'ORD-1',
    paymentStatus: 'PENDING',
    subtotal: new Decimal(90),
    discountAmount: new Decimal(0),
    serviceChargeAmount: new Decimal(0),
    total: new Decimal(90),
    remainingBalance: new Decimal(90),
    version: 1,
    venueId: 'venue-1',
    tableId,
    areaTicketCheckoutSession: null,
    customerId: null,
    customer: null,
  } as any)
  prismaMock.payment.findMany.mockResolvedValue([])
  prismaMock.orderItem.findMany.mockResolvedValue([])
  prismaMock.staff.findUnique.mockResolvedValue({ id: 'staff-1' } as any)
  prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-1', staffId: 'staff-1', venueId: 'venue-1', active: true } as any)
  prismaMock.shift.findFirst.mockResolvedValue(null)
  prismaMock.payment.create.mockResolvedValue({ id: 'payment-1', receipts: [] } as any)
  prismaMock.venueTransaction.create.mockResolvedValue({ id: 'vtx-1' } as any)
  prismaMock.paymentAllocation.create.mockResolvedValue({ id: 'alloc-1' } as any)
  prismaMock.order.updateMany.mockResolvedValue({ count: 1 })
}

const escrituraConMarca = () =>
  (prismaMock.order.updateMany as jest.Mock).mock.calls.some(([a]) => a?.data?.kitchenPendingAt instanceof Date)

beforeEach(() => {
  jest.clearAllMocks()
  armarMock.mockResolvedValue(undefined)
  logActionMock.mockResolvedValue(undefined)
  resolverTerminalMock.mockImplementation(async (venueId: string, serial: string) =>
    venueId === 'venue-1' && serial === 'AVQD-2841548417' ? 'terminal-1' : null,
  )
  ;(releaseTableIfSettled as jest.Mock).mockReset().mockResolvedValue(true)
})

describe('payCashOrder — comanda de pantalla al saldar', () => {
  it('mesa saldada: libera la última cuenta después de registrar un solo pago', async () => {
    seedOrder('table-1')
    debeMarcarCocinaMock.mockResolvedValue(false)
    let committed = false
    let committedAtRelease = false
    prismaMock.$transaction.mockImplementation(async (cb: any) => {
      const result = await cb(prismaMock)
      committed = true
      return result
    })
    ;(releaseTableIfSettled as jest.Mock).mockImplementation(async () => {
      committedAtRelease = committed
      return true
    })

    const paid = await payCashOrder('venue-1', 'order-1', { amount: 9000, tip: 0, staffId: 'staff-1' })

    expect(paid).toMatchObject({ paymentId: 'payment-1', status: 'COMPLETED', remainingBalanceCents: 0 })
    expect(releaseTableIfSettled).toHaveBeenCalledTimes(1)
    expect(releaseTableIfSettled).toHaveBeenCalledWith('venue-1', 'table-1')
    expect(committedAtRelease).toBe(true)
    expect(prismaMock.payment.create).toHaveBeenCalledTimes(1)
  })

  it('mesa con abono parcial: conserva su ocupación', async () => {
    seedOrder('table-1')
    debeMarcarCocinaMock.mockResolvedValue(false)

    const paid = await payCashOrder('venue-1', 'order-1', { amount: 4000, tip: 0, staffId: 'staff-1' })

    expect(paid).toMatchObject({ orderPaymentStatus: 'PARTIAL', remainingBalanceCents: 5000 })
    expect(releaseTableIfSettled).not.toHaveBeenCalled()
  })

  it('fallo al liberar la mesa: conserva el pago aprobado y no vuelve a cobrar', async () => {
    seedOrder('table-1')
    debeMarcarCocinaMock.mockResolvedValue(false)
    ;(releaseTableIfSettled as jest.Mock).mockRejectedValue(new Error('Own table bookkeeping failure'))

    const paid = await payCashOrder('venue-1', 'order-1', { amount: 9000, tip: 0, staffId: 'staff-1' })

    expect(paid).toMatchObject({ paymentId: 'payment-1', status: 'COMPLETED', amount: 9000 })
    expect(releaseTableIfSettled).toHaveBeenCalledTimes(1)
    expect(prismaMock.payment.create).toHaveBeenCalledTimes(1)
  })

  it('venta saldada con pantalla: la marca va en la escritura que salda y la comanda se arma una vez', async () => {
    seedOrder()
    debeMarcarCocinaMock.mockResolvedValue(true)

    await payCashOrder('venue-1', 'order-1', { amount: 9000, tip: 0, staffId: 'staff-1' })

    expect(prismaMock.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ paymentStatus: 'PAID', kitchenPendingAt: expect.any(Date) }) }),
    )
    expect(armarMock).toHaveBeenCalledTimes(1)
    expect(armarMock).toHaveBeenCalledWith('venue-1', 'order-1', 'PAID')
  })

  it('abono PARCIAL: ni marca ni comanda (la comanda nace al saldar)', async () => {
    seedOrder()
    debeMarcarCocinaMock.mockResolvedValue(true)

    await payCashOrder('venue-1', 'order-1', { amount: 4000, tip: 0, staffId: 'staff-1' })

    expect(escrituraConMarca()).toBe(false)
    expect(armarMock).not.toHaveBeenCalled()
  })

  it('negocio sin pantalla: ni marca ni comanda', async () => {
    seedOrder()
    debeMarcarCocinaMock.mockResolvedValue(false)

    await payCashOrder('venue-1', 'order-1', { amount: 9000, tip: 0, staffId: 'staff-1' })

    expect(escrituraConMarca()).toBe(false)
    expect(armarMock).not.toHaveBeenCalled()
  })

  // 🔴 «Cobrar sin red» (S6): la terminal sube sin red las ventas que ya entregó en el mostrador. Si sube más de
  // MINUTOS_PARA_COMANDA_DE_LA_COLA después de cobrarse, la cocina NO recibe una comanda tardía: ni la marca durable (el barrido
  // `kitchen-tickets-reconciliation.job.ts` arma con `kitchenPendingAt`) ni la comanda directa. Android sigue igual.
  // 🔴 Codex servidor r1 #8: la edad SÓLO la da `edadDeLaVentaMs` (reloj monótono de la terminal). Sin ella (tras reiniciar el
  // aparato no la hay) la comanda sale como hoy: el reloj de pared atrasado hacía parecer vieja una venta de hace un minuto.
  describe('comanda tardía de la cola de la terminal', () => {
    const haceMinutos = (min: number) => Date.now() - min * 60_000
    const edad = (min: number) => min * 60_000
    const deLaTerminal = { terminalSerialNumber: 'AVQD-2841548417', isOfflineReplay: true }

    it('la perilla son 10 minutos', () => {
      expect(MINUTOS_PARA_COMANDA_DE_LA_COLA).toBe(10)
    })

    it('venta de la cola de terminal con 11 min ⇒ sin kitchenPendingAt y sin armarComandasTrasCommit', async () => {
      seedOrder()
      debeMarcarCocinaMock.mockResolvedValue(true)

      const paid = await payCashOrder('venue-1', 'order-1', {
        amount: 9000,
        tip: 0,
        staffId: 'staff-1',
        ...deLaTerminal,
        edadDeLaVentaMs: edad(11),
      })

      expect(paid).toMatchObject({ orderPaymentStatus: 'PAID' })
      expect(prismaMock.order.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ paymentStatus: 'PAID' }) }),
      )
      expect(escrituraConMarca()).toBe(false)
      expect(armarMock).not.toHaveBeenCalled()
    })

    it('con 9 min ⇒ como hoy: la marca va en la escritura que salda y la comanda se arma una vez', async () => {
      seedOrder()
      debeMarcarCocinaMock.mockResolvedValue(true)

      await payCashOrder('venue-1', 'order-1', {
        amount: 9000,
        tip: 0,
        staffId: 'staff-1',
        ...deLaTerminal,
        edadDeLaVentaMs: edad(9),
      })

      expect(escrituraConMarca()).toBe(true)
      expect(armarMock).toHaveBeenCalledTimes(1)
      expect(armarMock).toHaveBeenCalledWith('venue-1', 'order-1', 'PAID')
    })

    it.each([
      ['número', haceMinutos(30)],
      ['texto de dígitos', String(haceMinutos(30))],
    ])(
      '🔴 sin edadDeLaVentaMs, una hora de captura de hace 30 min (%s) NO omite la comanda: el reloj de pared no se cree',
      async (_c, hora) => {
        seedOrder()
        debeMarcarCocinaMock.mockResolvedValue(true)

        await payCashOrder('venue-1', 'order-1', {
          amount: 9000,
          tip: 0,
          staffId: 'staff-1',
          ...deLaTerminal,
          createdAtLocal: hora,
        })

        expect(escrituraConMarca()).toBe(true)
        expect(armarMock).toHaveBeenCalledTimes(1)
        expect(logActionMock).not.toHaveBeenCalled()
      },
    )

    it('venta de la cola de Android (sin serial) con 11 min ⇒ como hoy', async () => {
      seedOrder()
      debeMarcarCocinaMock.mockResolvedValue(true)

      await payCashOrder('venue-1', 'order-1', {
        amount: 9000,
        tip: 0,
        staffId: 'staff-1',
        isOfflineReplay: true,
        edadDeLaVentaMs: edad(11),
      } as any)

      expect(escrituraConMarca()).toBe(true)
      expect(armarMock).toHaveBeenCalledTimes(1)
    })

    it('la terminal EN LÍNEA (sin isOfflineReplay) con una hora vieja ⇒ como hoy', async () => {
      seedOrder()
      debeMarcarCocinaMock.mockResolvedValue(true)

      await payCashOrder('venue-1', 'order-1', {
        amount: 9000,
        tip: 0,
        staffId: 'staff-1',
        terminalSerialNumber: 'AVQD-2841548417',
        createdAtLocal: haceMinutos(60),
      })

      expect(escrituraConMarca()).toBe(true)
      expect(armarMock).toHaveBeenCalledTimes(1)
    })

    it('serial que no es de este negocio ⇒ no es pago de terminal: como hoy', async () => {
      seedOrder()
      debeMarcarCocinaMock.mockResolvedValue(true)

      await payCashOrder('venue-1', 'order-1', {
        amount: 9000,
        tip: 0,
        staffId: 'staff-1',
        terminalSerialNumber: 'AVQD-DE-OTRO-NEGOCIO',
        isOfflineReplay: true,
        edadDeLaVentaMs: edad(11),
      } as any)

      expect(escrituraConMarca()).toBe(true)
      expect(armarMock).toHaveBeenCalledTimes(1)
    })

    it('reloj del aparato adelantado (hora en el futuro) ⇒ se acota a la llegada: como hoy', async () => {
      seedOrder()
      debeMarcarCocinaMock.mockResolvedValue(true)

      await payCashOrder('venue-1', 'order-1', {
        amount: 9000,
        tip: 0,
        staffId: 'staff-1',
        ...deLaTerminal,
        createdAtLocal: haceMinutos(-4),
      })

      expect(escrituraConMarca()).toBe(true)
      expect(armarMock).toHaveBeenCalledTimes(1)
    })

    // Ronda 1, MINOR #1: el reloj de pared del aparato puede ir ATRASADO; su reloj monótono no. Si la terminal manda cuánto pasó
    // entre la venta y este envío (`edadDeLaVentaMs`), esa edad manda sobre `createdAtLocal`.
    describe('edadDeLaVentaMs (reloj monótono del aparato)', () => {
      const conEdad = (edadDeLaVentaMs: unknown, createdAtLocal = haceMinutos(30)) =>
        payCashOrder('venue-1', 'order-1', {
          amount: 9000,
          tip: 0,
          staffId: 'staff-1',
          ...deLaTerminal,
          createdAtLocal,
          edadDeLaVentaMs,
        } as any)

      it('edadDeLaVentaMs 2 min con createdAtLocal que parece de hace 30 min ⇒ manda comanda', async () => {
        seedOrder()
        debeMarcarCocinaMock.mockResolvedValue(true)

        await conEdad(2 * 60_000)

        expect(escrituraConMarca()).toBe(true)
        expect(armarMock).toHaveBeenCalledTimes(1)
        expect(logActionMock).not.toHaveBeenCalled()
      })

      it('edadDeLaVentaMs 11 min ⇒ sin comanda (aunque createdAtLocal parezca reciente)', async () => {
        seedOrder()
        debeMarcarCocinaMock.mockResolvedValue(true)

        await conEdad(11 * 60_000, haceMinutos(1))

        expect(escrituraConMarca()).toBe(false)
        expect(armarMock).not.toHaveBeenCalled()
      })

      it('🔴 ausente (la terminal se reinició) ⇒ la comanda sale aunque createdAtLocal parezca de hace 30 min', async () => {
        seedOrder()
        debeMarcarCocinaMock.mockResolvedValue(true)

        await conEdad(undefined)

        expect(escrituraConMarca()).toBe(true)
        expect(armarMock).toHaveBeenCalledTimes(1)
      })

      it.each([
        ['negativo', -60_000],
        ['NaN', Number.NaN],
        ['infinito', Number.POSITIVE_INFINITY],
        ['más de 30 días', 31 * 86_400_000],
        ['texto', '120000'],
      ])('inválido (%s) ⇒ se ignora: sin edad confiable la comanda sale (createdAtLocal no cuenta)', async (_cual, edadInvalida) => {
        seedOrder()
        debeMarcarCocinaMock.mockResolvedValue(true)

        // createdAtLocal de hace 30 min: con la edad ignorada, tampoco se adivina con el reloj de pared.
        await conEdad(edadInvalida, haceMinutos(30))

        expect(escrituraConMarca()).toBe(true)
        expect(armarMock).toHaveBeenCalledTimes(1)
      })

      it('en línea (sin isOfflineReplay) nunca cuenta: como hoy', async () => {
        seedOrder()
        debeMarcarCocinaMock.mockResolvedValue(true)

        await payCashOrder('venue-1', 'order-1', {
          amount: 9000,
          tip: 0,
          staffId: 'staff-1',
          terminalSerialNumber: 'AVQD-2841548417',
          edadDeLaVentaMs: 60 * 60_000,
        } as any)

        expect(escrituraConMarca()).toBe(true)
        expect(armarMock).toHaveBeenCalledTimes(1)
      })
    })

    // Ronda 1, MINOR #4: «¿por qué no salió la comanda?» se contesta con una fila de ActivityLog, no sólo con el log.
    describe('rastro en ActivityLog de la comanda omitida', () => {
      const omitida = () => logActionMock.mock.calls.filter(([p]) => p?.action === 'COMANDA_OMITIDA_VENTA_TARDIA')

      it('omitida ⇒ una fila con la orden, la edad usada y su fuente (siempre el reloj monótono)', async () => {
        seedOrder()
        debeMarcarCocinaMock.mockResolvedValue(true)

        await payCashOrder('venue-1', 'order-1', {
          amount: 9000,
          tip: 0,
          staffId: 'staff-1',
          ...deLaTerminal,
          createdAtLocal: haceMinutos(11),
          edadDeLaVentaMs: edad(11),
        } as any)

        expect(omitida()).toHaveLength(1)
        expect(omitida()[0][0]).toMatchObject({
          entity: 'Order',
          entityId: 'order-1',
          venueId: 'venue-1',
          data: expect.objectContaining({
            orderId: 'order-1',
            paymentId: 'payment-1',
            terminalId: 'terminal-1',
            edadMs: edad(11),
            fuenteDeLaEdad: 'edadDeLaVentaMs',
            umbralMinutos: MINUTOS_PARA_COMANDA_DE_LA_COLA,
          }),
        })
      })

      it('sin edad confiable (sólo createdAtLocal de hace 11 min) ⇒ no se omitió nada: sin fila', async () => {
        seedOrder()
        debeMarcarCocinaMock.mockResolvedValue(true)

        await payCashOrder('venue-1', 'order-1', {
          amount: 9000,
          tip: 0,
          staffId: 'staff-1',
          ...deLaTerminal,
          createdAtLocal: haceMinutos(11),
        })

        expect(omitida()).toHaveLength(0)
        expect(armarMock).toHaveBeenCalledTimes(1)
      })

      it('omitida por edadDeLaVentaMs ⇒ la fila dice esa edad y esa fuente', async () => {
        seedOrder()
        debeMarcarCocinaMock.mockResolvedValue(true)

        await payCashOrder('venue-1', 'order-1', {
          amount: 9000,
          tip: 0,
          staffId: 'staff-1',
          ...deLaTerminal,
          createdAtLocal: haceMinutos(1),
          edadDeLaVentaMs: 15 * 60_000,
        } as any)

        expect(omitida()).toHaveLength(1)
        expect(omitida()[0][0].data).toMatchObject({ edadMs: 15 * 60_000, fuenteDeLaEdad: 'edadDeLaVentaMs' })
      })

      it('sin pantalla de cocina, o abono parcial, o a tiempo ⇒ no se omitió nada: sin fila', async () => {
        const casos: Array<[cocina: boolean, amount: number, minutos: number]> = [
          [false, 9000, 11], // sin pantalla de cocina
          [true, 4000, 11], // abono parcial
          [true, 9000, 9], // a tiempo
        ]
        for (const [cocina, amount, minutos] of casos) {
          seedOrder()
          debeMarcarCocinaMock.mockResolvedValue(cocina)
          await payCashOrder('venue-1', 'order-1', {
            amount,
            tip: 0,
            staffId: 'staff-1',
            ...deLaTerminal,
            edadDeLaVentaMs: edad(minutos),
          } as any)
        }

        expect(omitida()).toHaveLength(0)
      })
    })
  })
})
