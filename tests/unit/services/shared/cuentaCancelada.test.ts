import {
  CobroYaRegistrado,
  MENSAJE_CUENTA_CANCELADA,
  cierreAutomaticoPermitido,
  esCobroNuevo,
  estadoParaCobrar,
  reabrirSiRecibeDinero,
  rechazarCobroNuevoSobreCancelada,
  salirSiLaLlaveYaTienePago,
  volverAGastarUsosTrasElCobro,
} from '@/services/shared/cuentaCancelada'

describe('Founder 3-oct: cobrar una cuenta CANCELADA (el núcleo del servidor)', () => {
  it('🔴 Codex r10 #2: sólo es cobro nuevo el efectivo de cajón en vivo; lo demás es dinero ya capturado', () => {
    expect([
      esCobroNuevo({ enVivo: true, efectivoDeCajon: true }),
      esCobroNuevo({ enVivo: true, efectivoDeCajon: false }), // tarjeta ajena, transferencia: ya ocurrió
      esCobroNuevo({ enVivo: false, efectivoDeCajon: true }), // la cola: el efectivo ya está en el cajón
      esCobroNuevo({ enVivo: false, efectivoDeCajon: false }),
    ]).toEqual([true, false, false, false])
  })

  it('🔴 un cobro NUEVO sobre una cancelada o borrada se rechaza con el texto del founder y el código que las apps ya conocen', () => {
    expect(MENSAJE_CUENTA_CANCELADA).toBe('Esta cuenta está cancelada, abre una nueva.')
    for (const status of ['CANCELLED', 'DELETED']) {
      let error: any
      try {
        rechazarCobroNuevoSobreCancelada(status)
      } catch (e) {
        error = e
      }
      expect(error).toMatchObject({ statusCode: 400, code: 'ORDER_CANCELLED_NO_NEW_CHARGE', message: MENSAJE_CUENTA_CANCELADA })
    }
  })
  it('control: una viva no se rechaza', () => {
    expect(() => rechazarCobroNuevoSobreCancelada('PENDING')).not.toThrow()
  })

  it('🔴 Codex r12 #5 + r13 #1: una de AVOQADO se reabre con cualquier dinero; una externa sólo si lo cobrado cubre lo que debía como cancelada (cuando hoy salía de CANCELADA)', () => {
    expect(estadoParaCobrar({ status: 'CANCELLED', originSystem: 'AVOQADO' }, 50, false)).toBe('PENDING')
    expect(estadoParaCobrar({ status: 'CANCELLED', originSystem: 'DELIVERY_PLATFORM' }, 50, false)).toBe('CANCELLED')
    expect(estadoParaCobrar({ status: 'DELETED', originSystem: 'POS_SOFTRESTAURANT' }, 50, false)).toBe('DELETED')
    expect(estadoParaCobrar({ status: 'CANCELLED', originSystem: 'POS_SOFTRESTAURANT' }, 100, true)).toBe('PENDING')
    expect(estadoParaCobrar({ status: 'CANCELLED', originSystem: 'POS_SOFTRESTAURANT' }, 0, true)).toBe('CANCELLED')
  })
  it('🔴 cierreAutomaticoPermitido: una viva sí; una cancelada o borrada, de cualquier origen, nunca (si cubría lo que debía, ya salió de CANCELADA)', () => {
    expect([cierreAutomaticoPermitido('PENDING'), cierreAutomaticoPermitido('CANCELLED'), cierreAutomaticoPermitido('DELETED')]).toEqual([
      true,
      false,
      false,
    ])
  })

  // D26: la reapertura busca las filas que devolvieron su uso al anular; aquí no hay ninguna.
  const txDoble = () => ({
    order: { update: jest.fn().mockResolvedValue({}) },
    activityLog: { create: jest.fn().mockResolvedValue({}) },
    orderDiscount: { findMany: jest.fn().mockResolvedValue([]) },
  })
  it('🔴 dinero ya capturado sobre una cancelada de Avoqado ⇒ la reabre (PENDING) y deja UNA bitácora con el estado anterior, el canal y el cobro', async () => {
    const tx = txDoble()
    expect(
      await reabrirSiRecibeDinero(tx as any, {
        venueId: 'v',
        orderId: 'o',
        status: 'CANCELLED',
        originSystem: 'AVOQADO',
        cobrado: 116,
        cubreComoCancelada: false,
        canal: 'payCashOrder:cola',
        idempotencyKey: 'k-1',
      }),
    ).toBe('PENDING')
    // Pedidos en línea 1c (S1): la misma escritura trae su pedido en línea (`select`); aquí no hay (`{}`), así que nada más se escribe.
    expect(tx.order.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'o', venueId: 'v' }, data: { status: 'PENDING' } }))
    expect(tx.activityLog.create).toHaveBeenCalledTimes(1)
    expect(tx.activityLog.create.mock.calls[0][0].data).toMatchObject({
      action: 'ORDER_REOPENED_BY_CAPTURED_PAYMENT',
      entity: 'Order',
      entityId: 'o',
      venueId: 'v',
      data: {
        estadoAnterior: 'CANCELLED',
        estadoNuevo: 'PENDING',
        canal: 'payCashOrder:cola',
        idempotencyKey: 'k-1',
        paymentId: null,
        cobrado: '116.00',
      },
    })
  })
  it('🔴 D26: al revivir busca, en la misma transacción, los usos que la anulación devolvió; sin filas, sólo la bitácora de la reapertura', async () => {
    const tx = txDoble()
    await reabrirSiRecibeDinero(tx as any, {
      venueId: 'v',
      orderId: 'o',
      status: 'CANCELLED',
      originSystem: 'AVOQADO',
      cobrado: 90,
      cubreComoCancelada: false,
      canal: 'payCashOrder:cola',
    })
    expect(tx.orderDiscount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ orderId: 'o', usoDevueltoAlAnular: true }) }),
    )
    expect(tx.activityLog.create).toHaveBeenCalledTimes(1)
  })
  it('control: una viva, una cancelada sin dinero, o una cancelada EXTERNA que no cubre lo que debía (Codex r12 #5) no escriben nada', async () => {
    for (const [status, originSystem, cobrado] of [
      ['PENDING', 'AVOQADO', 116],
      ['CANCELLED', 'AVOQADO', 0],
      ['CANCELLED', 'DELIVERY_PLATFORM', 50],
    ] as const) {
      const tx = txDoble()
      expect(
        await reabrirSiRecibeDinero(tx as any, {
          venueId: 'v',
          orderId: 'o',
          status,
          originSystem,
          cobrado,
          cubreComoCancelada: false,
          canal: 'x',
        }),
      ).toBe(status)
      expect([tx.order.update.mock.calls.length, tx.activityLog.create.mock.calls.length]).toEqual([0, 0])
    }
  })
  it('🔴 Codex r13 #1: una cancelada EXTERNA que cubre lo que debía sale de CANCELADA como hoy, pero ahora PENDING (para calcularla viva) y con su bitácora', async () => {
    const tx = txDoble()
    expect(
      await reabrirSiRecibeDinero(tx as any, {
        venueId: 'v',
        orderId: 'o',
        status: 'CANCELLED',
        originSystem: 'POS_SOFTRESTAURANT',
        cobrado: 100,
        cubreComoCancelada: true,
        canal: 'payCashOrder:cola',
      }),
    ).toBe('PENDING')
    expect([tx.order.update.mock.calls.length, tx.activityLog.create.mock.calls.length]).toEqual([1, 1])
  })

  // Codex r13 #2: la identidad del cobro, otra vez, bajo el candado.
  const txPagos = (encontrado: { id: string; orderId: string } | null) => ({
    payment: { findUnique: jest.fn().mockResolvedValue(encontrado) },
  })
  it('🔴 Codex r13 #2: si la llave ya tiene un pago de ESTA orden, lanza CobroYaRegistrado (quien llama devuelve ese pago)', async () => {
    await expect(
      salirSiLaLlaveYaTienePago(txPagos({ id: 'pay-ganador', orderId: 'o' }) as any, { venueId: 'v', orderId: 'o', idempotencyKey: 'k-1' }),
    ).rejects.toBeInstanceOf(CobroYaRegistrado)
  })
  it('control — r13 #2: la llave de OTRA orden responde 409 IDEMPOTENCY_KEY_REUSED, como el atajo de hoy', async () => {
    await expect(
      salirSiLaLlaveYaTienePago(txPagos({ id: 'pay-x', orderId: 'otra' }) as any, { venueId: 'v', orderId: 'o', idempotencyKey: 'k-1' }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_KEY_REUSED' })
  })
  it('control — r13 #2: sin llave, o sin pago con ella, no hace nada (y sin llave ni consulta)', async () => {
    const sinPago = txPagos(null)
    await expect(salirSiLaLlaveYaTienePago(sinPago as any, { venueId: 'v', orderId: 'o', idempotencyKey: 'k-1' })).resolves.toBeUndefined()
    const sinLlave = txPagos({ id: 'pay-x', orderId: 'o' })
    await expect(salirSiLaLlaveYaTienePago(sinLlave as any, { venueId: 'v', orderId: 'o' })).resolves.toBeUndefined()
    expect(sinLlave.payment.findUnique).not.toHaveBeenCalled()
  })
})

describe('Rappi 2b (T8, Codex código r1 #3): un pedido de Rappi no se reabre al recibir dinero, por ningún canal', () => {
  it('cancelada de Rappi que recibe dinero que la cubre ⇒ sigue CANCELLED', () => {
    expect(estadoParaCobrar({ status: 'CANCELLED', originSystem: 'DELIVERY_PLATFORM', source: 'RAPPI' }, 205, true)).toBe('CANCELLED')
  })
  it('control: una cancelada de otra plataforma conserva la regla de hoy (sale de CANCELADA si cubre)', () => {
    expect(estadoParaCobrar({ status: 'CANCELLED', originSystem: 'DELIVERY_PLATFORM', source: 'UBER_EATS' }, 205, true)).not.toBe(
      'CANCELLED',
    )
  })
})

/**
 * 🔴 hz:e82938e1:D26, cruce de la publicación del 20-nov: la transacción de `recordOrderPayment` NO se reintenta (R63 b) y la venta de $0
 * de la TPV toma Shift → Discount. Si el cobro de la terminal tomaba Discount (para volver a gastar el uso de una cuenta anulada que
 * revive), Postgres podía abortar el registro de un cobro con tarjeta YA capturado. Ahora la TPV revive SIN tocar Discount
 * (`usos: 'despues'`) y, ya guardado el dinero, `volverAGastarUsosTrasElCobro` gasta en su propia transacción: Order → Discount, sin
 * Shift, con red por traba, sólo si la cuenta sigue viva, y nunca lanza.
 */
describe('🔴 D26 tras el cobro: el registro de la terminal no toca Discount; el uso se gasta después, aparte', () => {
  const { default: prisma } = jest.requireMock('@/utils/prismaClient') as { default: any }
  const { default: logger } = jest.requireMock('@/config/logger') as { default: any }
  const sql = (call: unknown[]) => (call[0] as string[]).join('?')

  const txDoble = () => ({
    order: { update: jest.fn().mockResolvedValue({}) },
    activityLog: { create: jest.fn().mockResolvedValue({}) },
    orderDiscount: { findMany: jest.fn().mockResolvedValue([{ id: 'od-1', discountId: 'promo-1' }]), updateMany: jest.fn() },
    discount: { update: jest.fn() },
    $queryRaw: jest.fn().mockResolvedValue([]),
  })

  it("reabrirSiRecibeDinero con `usos: 'despues'`: revive y deja su bitácora, pero ni busca las filas ni toma ni escribe Discount", async () => {
    const tx = txDoble()
    expect(
      await reabrirSiRecibeDinero(
        tx as any,
        {
          venueId: 'v',
          orderId: 'o',
          status: 'CANCELLED',
          originSystem: 'AVOQADO',
          cobrado: 90,
          cubreComoCancelada: false,
          canal: 'recordOrderPayment',
          paymentId: 'pay-1',
          usos: 'despues',
        } as any,
      ),
    ).toBe('PENDING')
    expect(tx.order.update).toHaveBeenCalledWith(expect.objectContaining({ data: { status: 'PENDING' } }))
    expect(tx.activityLog.create).toHaveBeenCalledTimes(1)
    expect(tx.activityLog.create.mock.calls[0][0].data.action).toBe('ORDER_REOPENED_BY_CAPTURED_PAYMENT')
    expect(tx.orderDiscount.findMany).not.toHaveBeenCalled()
    expect(tx.$queryRaw).not.toHaveBeenCalled()
    expect(tx.discount.update).not.toHaveBeenCalled()
  })

  it('regresión: sin la opción (POS, panel, cola, recálculo con reintento) sigue gastando en la misma transacción', async () => {
    const tx = txDoble()
    tx.$queryRaw.mockResolvedValue([{ id: 'promo-1', name: 'Primeros 100', currentUses: 40, maxTotalUses: 100 }])
    await reabrirSiRecibeDinero(tx as any, {
      venueId: 'v',
      orderId: 'o',
      status: 'CANCELLED',
      originSystem: 'AVOQADO',
      cobrado: 90,
      cubreComoCancelada: false,
      canal: 'payCashOrder:cola',
    })
    expect(tx.orderDiscount.findMany).toHaveBeenCalled()
    expect(tx.discount.update).toHaveBeenCalledWith({ where: { id: 'promo-1' }, data: { currentUses: { increment: 1 } } })
  })

  /** La transacción del paso posterior es el propio `prismaMock` (setup: `$transaction(cb) ⇒ cb(prismaMock)`). */
  function escenario(o: { marcada?: boolean; status?: string; falla?: Error } = {}) {
    prisma.$transaction.mockReset().mockImplementation((cb: any) => cb(prisma))
    prisma.orderDiscount.findFirst.mockReset().mockResolvedValue(o.marcada === false ? null : { id: 'od-1' })
    prisma.order.findFirst.mockReset().mockResolvedValue({ status: o.status ?? 'PENDING' })
    prisma.orderDiscount.findMany.mockReset().mockResolvedValue([{ id: 'od-1', discountId: 'promo-1' }])
    prisma.orderDiscount.updateMany.mockReset().mockResolvedValue({ count: 1 })
    prisma.discount.update.mockReset().mockResolvedValue({})
    prisma.activityLog.create.mockReset().mockResolvedValue({})
    prisma.$executeRawUnsafe.mockReset().mockResolvedValue(0)
    prisma.$queryRaw.mockReset().mockImplementation(async (strings: string[]) => {
      if (o.falla) throw o.falla
      const texto = strings.join('?')
      if (texto.includes('FROM "Discount"')) return [{ id: 'promo-1', name: 'Primeros 100', currentUses: 40, maxTotalUses: 100 }]
      return [{ id: 'o', scopeTooLarge: false }]
    })
    logger.error.mockClear()
  }
  const llamar = () =>
    volverAGastarUsosTrasElCobro({ venueId: 'v', orderId: 'o', canal: 'recordOrderPayment', paymentId: 'pay-1', staffId: 'staff-1' })

  it('cuenta revivida y viva: toma la cuenta, DESPUÉS las filas Discount (sin turno), gasta el uso, suelta la marca y deja la bitácora', async () => {
    escenario()
    expect(await llamar()).toBe(1)
    const consultas = prisma.$queryRaw.mock.calls.map(sql)
    expect(consultas).toHaveLength(2)
    expect(consultas[0]).toMatch(/FROM "Order" o[\s\S]*FOR UPDATE OF o/)
    expect(consultas[1]).toMatch(/FROM "Discount"[\s\S]*FOR NO KEY UPDATE/)
    expect(consultas.join('\n')).not.toMatch(/"Shift"/)
    // Espera acotada (Codex r1 #2): el tope de espera se fija ANTES del primer candado.
    expect(prisma.$executeRawUnsafe).toHaveBeenCalledWith("SET LOCAL lock_timeout = '1000ms'")
    expect(prisma.$executeRawUnsafe.mock.invocationCallOrder[0]).toBeLessThan(prisma.$queryRaw.mock.invocationCallOrder[0])
    expect(prisma.discount.update).toHaveBeenCalledWith({ where: { id: 'promo-1' }, data: { currentUses: { increment: 1 } } })
    expect(prisma.orderDiscount.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { usoContado: true, usoDevueltoAlAnular: false } }),
    )
    expect(prisma.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'ORDER_REOPENED_DISCOUNT_USES_RESPENT',
        entityId: 'o',
        venueId: 'v',
        staffId: 'staff-1',
        data: expect.objectContaining({ canal: 'recordOrderPayment', paymentId: 'pay-1', usosGastados: 1 }),
      }),
    })
    // Con su red por traba: la transacción nace en `withDeadlockRetry` (lo prueba que pase por `$transaction` con opciones).
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
  })

  it.each(['CANCELLED', 'DELETED'])('la anularon otra vez entre los dos pasos (%s): no gasta ni escribe nada', async status => {
    escenario({ status })
    expect(await llamar()).toBe(0)
    expect(prisma.discount.update).not.toHaveBeenCalled()
    expect(prisma.orderDiscount.updateMany).not.toHaveBeenCalled()
    expect(prisma.activityLog.create).not.toHaveBeenCalled()
  })

  it('sin filas que devolvieron su uso (el reenvío normal de la terminal): una consulta y ni abre transacción', async () => {
    escenario({ marcada: false })
    expect(await llamar()).toBe(0)
    expect(prisma.orderDiscount.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ orderId: 'o', usoDevueltoAlAnular: true }) }),
    )
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('🔴 Codex r1 #2: otra caja retiene la cuenta o la promoción más de lo que espera (55P03): suelta todo, lo intenta otra vez y se rinde sin lanzar', async () => {
    escenario({ falla: Object.assign(new Error('lock timeout'), { code: 'P2010', meta: { code: '55P03' } }) })
    await expect(llamar()).resolves.toBe(0)
    expect(prisma.$transaction).toHaveBeenCalledTimes(2)
    expect(prisma.discount.update).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('D26'), expect.objectContaining({ orderId: 'o', paymentId: 'pay-1' }))
  })

  it('🔴 un error NUNCA sale al llamador (el dinero ya está guardado): logger.error con negocio, cuenta y cobro, y el uso queda libre', async () => {
    escenario({ falla: Object.assign(new Error('lock timeout'), { code: 'P2028' }) })
    await expect(llamar()).resolves.toBe(0)
    expect(prisma.discount.update).not.toHaveBeenCalled()
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('D26'),
      expect.objectContaining({ venueId: 'v', orderId: 'o', paymentId: 'pay-1' }),
    )
  })
})
