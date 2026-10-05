import {
  CobroYaRegistrado,
  MENSAJE_CUENTA_CANCELADA,
  cierreAutomaticoPermitido,
  esCobroNuevo,
  estadoParaCobrar,
  reabrirSiRecibeDinero,
  rechazarCobroNuevoSobreCancelada,
  salirSiLaLlaveYaTienePago,
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

  const txDoble = () => ({ order: { update: jest.fn().mockResolvedValue({}) }, activityLog: { create: jest.fn().mockResolvedValue({}) } })
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
    expect(tx.order.update).toHaveBeenCalledWith({ where: { id: 'o', venueId: 'v' }, data: { status: 'PENDING' } })
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
