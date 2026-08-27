jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }))

/**
 * 🔴 DINERO. Si la venta que otorgó un sello se reembolsa, el sello sobra: el cliente
 * avanza en su cartilla por algo que devolvió, y termina cobrando un premio que no se
 * ganó. Con un café son centavos; con siete clientes haciéndolo, es una cartilla
 * completa regalada cada semana.
 */
import { reverseStampForOrder } from '../../../../src/services/wallet/stampLedger.service'
import { prismaMock } from '../../../__helpers__/setup'
import { logAction } from '@/services/dashboard/activity-log.service'

describe('reverseStampForOrder', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.stampEvent.findFirst.mockResolvedValue({ id: 'se1', stampCardId: 'sc1', quantity: 1 } as any)
    prismaMock.stampEvent.count.mockResolvedValue(0)
    prismaMock.stampEvent.create.mockResolvedValue({ id: 'se2' } as any)
    prismaMock.stampCard.update.mockResolvedValue({} as any)
  })

  it('🔴 revierte el sello SIN borrar el original', async () => {
    const r = await reverseStampForOrder('v1', 'o1')

    expect(r.reversed).toBe(true)
    // 🔴 Es un LIBRO, no un contador: el sello otorgado se queda y nace un asiento
    // contrario. Borrar el original haría desaparecer el rastro de que ese cliente
    // sí compró, y el día que alguien reclame no habría con qué reconstruirlo.
    expect(prismaMock.stampEvent.delete).not.toHaveBeenCalled()
    expect(prismaMock.stampEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: 'REVERSAL', quantity: -1, stampCardId: 'sc1' }) }),
    )
  })

  it('🔴 baja el contador de la cartilla', async () => {
    // Sin esto el asiento existe pero el cliente sigue viendo su avance inflado, que
    // es la única cifra que él mira.
    await reverseStampForOrder('v1', 'o1')

    expect(prismaMock.stampCard.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'sc1' }, data: expect.objectContaining({ stampsEarned: { decrement: 1 } }) }),
    )
  })

  it('🔴 un reembolso parcial y otro total no revierten DOS veces', async () => {
    // Un mismo cobro puede reembolsarse en partes, y cada parte pasa por aquí. Sin
    // este guard, el cliente perdería dos sellos por una sola compra devuelta.
    prismaMock.stampEvent.count.mockResolvedValue(1)

    const r = await reverseStampForOrder('v1', 'o1')

    expect(r.reversed).toBe(false)
    expect(prismaMock.stampEvent.create).not.toHaveBeenCalled()
  })

  it('una venta que nunca dio sello no hace nada', async () => {
    // La mayoría de los reembolsos son de ventas sin cartilla. Corre en CADA
    // reembolso: tiene que ser un no-op barato y silencioso.
    prismaMock.stampEvent.findFirst.mockResolvedValue(null)

    const r = await reverseStampForOrder('v1', 'o1')

    expect(r.reversed).toBe(false)
    expect(prismaMock.stampCard.update).not.toHaveBeenCalled()
  })

  it('🔴 deja rastro en la bitácora, porque quitar un sello es una ANOMALÍA', async () => {
    // Otorgar un sello NO se registra: pasa en cada cobro de cada negocio e inflaría
    // la bitácora hasta volverla inútil (regla del repo: registrar las anomalías que
    // un dueño de verdad audita, no el ruido de todos los días). Quitarlo sí: es
    // exactamente lo que alguien va a mirar cuando un cliente reclame que perdió un
    // sello.
    await reverseStampForOrder('v1', 'o1')

    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'STAMP_REVERSED', venueId: 'v1' }),
    )
  })
})
