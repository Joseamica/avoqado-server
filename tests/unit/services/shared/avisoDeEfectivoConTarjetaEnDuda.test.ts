/**
 * D10-B: lo que decide el rastro sin tocar la base. El recorrido real (POS, cola, terminal, panel y el aprobado tardío) vive en
 * `tests/integration/payments/efectivoConTarjetaEnDuda.integration.test.ts`.
 */
import logger from '@/config/logger'
import { logAction } from '@/services/dashboard/activity-log.service'
import { avisarEfectivoConTarjetaEnDuda } from '@/services/shared/avisoDeEfectivoConTarjetaEnDuda'
import { findLiveTerminalCharge } from '@/services/shared/orderCancelGuard'

jest.mock('@/services/shared/orderCancelGuard', () => ({ findLiveTerminalCharge: jest.fn() }))

const hallarDuda = findLiveTerminalCharge as jest.Mock
const COBRO = { id: 'p1', venueId: 'v1', orderId: 'o1', amount: 100, tipAmount: 0, method: 'CASH', processedById: 's1' }

beforeEach(() => {
  jest.clearAllMocks()
  hallarDuda.mockResolvedValue({ requestId: 'r1' })
})

describe('avisarEfectivoConTarjetaEnDuda', () => {
  it('efectivo sobre una venta en duda ⇒ asiento con la solicitud y el importe', async () => {
    await avisarEfectivoConTarjetaEnDuda(COBRO)
    expect(logAction).toHaveBeenCalledWith({
      action: 'CASH_WITH_CARD_IN_DOUBT',
      entity: 'Order',
      entityId: 'o1',
      venueId: 'v1',
      staffId: 's1',
      data: { requestId: 'r1', paymentId: 'p1', amount: 100, tipAmount: 0 },
    })
  })

  it('un vale que cuenta como efectivo y la propina sola también son dinero en el cajón', async () => {
    await avisarEfectivoConTarjetaEnDuda({ ...COBRO, method: 'OTHER', tenderTypeId: 't1', tenderCountsAsCash: true })
    await avisarEfectivoConTarjetaEnDuda({ ...COBRO, amount: 0, tipAmount: 50 })
    expect(logAction).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['tarjeta', { method: 'CREDIT_CARD' }],
    ['un tipo de pago que no entra al cajón', { method: 'CASH', fundsFlow: 'EXTERNAL_RECORDED' }],
    ['un cobro en $0', { amount: 0, tipAmount: 0 }],
  ])('%s ⇒ ni consulta ni asiento', async (_nombre, cambio) => {
    await avisarEfectivoConTarjetaEnDuda({ ...COBRO, ...cambio })
    expect(hallarDuda).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })

  it('sin duda ⇒ nada', async () => {
    hallarDuda.mockResolvedValue(null)
    await avisarEfectivoConTarjetaEnDuda(COBRO)
    expect(logAction).not.toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('nunca lanza: ni con la consulta rota ni con la bitácora rota', async () => {
    hallarDuda.mockRejectedValueOnce(new Error('base caída'))
    await expect(avisarEfectivoConTarjetaEnDuda(COBRO)).resolves.toBeUndefined()
    ;(logAction as jest.Mock).mockRejectedValueOnce(new Error('bitácora rota'))
    await expect(avisarEfectivoConTarjetaEnDuda(COBRO)).resolves.toBeUndefined()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('no se pudo revisar'), expect.objectContaining({ orderId: 'o1' }))
  })
})
