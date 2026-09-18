/**
 * El aviso AL CAJERO cuando el cobro aparece TARDE, después de que él declaró que no había pasado
 * (plan 18-sep, Task 7).
 *
 * 🔴 Por qué existe: el tratamiento de la aprobación tardía ya detectaba este caso, pero sólo mandaba
 * `sendOpsAlert` — correo a operaciones. El cajero, que es quien puede cobrar de nuevo por error, no se
 * enteraba de nada. El mockup aprobado por el founder dibuja justamente esa pantalla.
 *
 * 🔴 Y una decisión de compatibilidad: NO se agrega un valor al enum `NotificationType`. El decoder estricto
 * de iOS tira el arreglo ENTERO al encontrar uno desconocido (la lección de los conteos cancelados), así que
 * un tipo nuevo dejaría sin buzón a las apps ya publicadas. Se reusa uno que todas conocen.
 */
import prisma from '@/utils/prismaClient'
import { avisarCobroTardioAlCajero } from '@/services/tpv/avisoDeCobroTardio'

const prismaMock = prisma as any

const ctx = {
  requestId: 'req-1',
  venueId: 'v1',
  paymentId: 'pay-1',
  terminalId: 'n860w173397',
  orderId: 'order-1',
}

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.notification.create.mockResolvedValue({})
  prismaMock.terminalPaymentRequest.findFirst.mockResolvedValue({
    id: 'row-1',
    amountCents: 7475,
    operatorReconciliation: { kind: 'UNCHARGED_VERIFIED', staffId: 'staff-cashier', id: 'r1' },
  })
})

describe('avisarCobroTardioAlCajero', () => {
  it('🔴 avisa A QUIEN DECLARÓ, con el importe en PESOS y el «no lo cobres otra vez»', async () => {
    await avisarCobroTardioAlCajero(ctx)
    expect(prismaMock.notification.create).toHaveBeenCalledTimes(1)
    const data = prismaMock.notification.create.mock.calls[0][0].data
    expect(data.recipientId).toBe('staff-cashier')
    expect(data.venueId).toBe('v1')
    expect(data.entityId).toBe('row-1')
    expect(data.message).toContain('74.75')
    expect(data.message).toMatch(/no lo cobres otra vez/i)
  })

  it('🔴 NO inventa un tipo de notificación nuevo: usa uno que las apps publicadas ya conocen', async () => {
    const { NotificationType } = await import('@prisma/client')
    await avisarCobroTardioAlCajero(ctx)
    const data = prismaMock.notification.create.mock.calls[0][0].data
    expect(Object.values(NotificationType)).toContain(data.type)
  })

  it('NO avisa si no hubo declaración: ese camino ya tiene su correo a operaciones', async () => {
    prismaMock.terminalPaymentRequest.findFirst.mockResolvedValue({ id: 'row-1', amountCents: 7475, operatorReconciliation: null })
    await avisarCobroTardioAlCajero(ctx)
    expect(prismaMock.notification.create).not.toHaveBeenCalled()
  })

  it('NO avisa si la declaración es la de GERENCIA («no se presentó tarjeta»): no es este caso', async () => {
    prismaMock.terminalPaymentRequest.findFirst.mockResolvedValue({
      id: 'row-1',
      amountCents: 7475,
      operatorReconciliation: { kind: 'NO_INSTRUMENT_PRESENTED', staffId: 'staff-manager' },
    })
    await avisarCobroTardioAlCajero(ctx)
    expect(prismaMock.notification.create).not.toHaveBeenCalled()
  })

  it('🔴 un fallo del aviso NO tumba el registro del dinero', async () => {
    prismaMock.notification.create.mockRejectedValue(new Error('db caída'))
    await expect(avisarCobroTardioAlCajero(ctx)).resolves.toBeUndefined()
  })

  it('🔴 si no se puede leer la fila tampoco revienta', async () => {
    prismaMock.terminalPaymentRequest.findFirst.mockRejectedValue(new Error('db caída'))
    await expect(avisarCobroTardioAlCajero(ctx)).resolves.toBeUndefined()
    expect(prismaMock.notification.create).not.toHaveBeenCalled()
  })
})
