/**
 * Codex r2 #3 (12-nov): la cota de `loyaltySaleAt` («nunca después de la llegada») es la hora en que ENTRÓ la petición. Los
 * controladores de cobro esperan antes de llamar al servicio (`customerAttributionActorForRecordedPayment` con cliente): si el
 * servicio tomara la hora al empezar, una espera de 2 s a las 23:59:59 fecharía la venta a las 00:00:01. El controlador la toma
 * en su primera línea y la pasa explícita.
 */
import * as tpvController from '@/controllers/tpv/payment.tpv.controller'
import * as mobileController from '@/controllers/mobile/payment.mobile.controller'
import * as paymentTpvService from '@/services/tpv/payment.tpv.service'
import { customerAttributionActorForRecordedPayment } from '@/middlewares/customerAttribution.middleware'

jest.mock('@/services/tpv/payment.tpv.service')
jest.mock('@/services/tpv/sale-verification.service')
jest.mock('@/middlewares/customerAttribution.middleware', () => ({
  __esModule: true,
  customerAttributionActor: jest.fn(),
  customerAttributionActorForRecordedPayment: jest.fn(),
}))
jest.mock('@/utils/prismaClient', () => ({ __esModule: true, default: {} }))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

const ENTRADA = new Date('2026-11-13T05:59:59.000Z') // 23:59:59 en CDMX

const req = () =>
  ({
    params: { venueId: 'venue-1', orderId: 'order-1' },
    body: {
      amount: 10_000,
      tip: 0,
      method: 'CASH',
      isOfflineReplay: true,
      createdAtLocal: ENTRADA.getTime() + 86_400_000,
      customerId: 'cust-1',
    },
    authContext: { orgId: 'org-1', userId: 'staff-1', terminalSerialNumber: 'AVQD-N86TEST' },
    header: jest.fn(),
  }) as any
const res = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() }) as any

beforeEach(() => {
  jest.clearAllMocks()
  jest.useFakeTimers({
    doNotFake: [
      'nextTick',
      'setImmediate',
      'clearImmediate',
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'queueMicrotask',
      'hrtime',
      'performance',
    ],
  })
  jest.setSystemTime(ENTRADA)
  // La espera del controlador antes del servicio: 2 s después ya es otro día.
  ;(customerAttributionActorForRecordedPayment as jest.Mock).mockImplementation(async () => {
    jest.setSystemTime(ENTRADA.getTime() + 2_000)
    return {}
  })
  ;(paymentTpvService.recordFastPayment as jest.Mock).mockResolvedValue({ id: 'pay-1', status: 'COMPLETED' })
  ;(paymentTpvService.recordOrderPayment as jest.Mock).mockResolvedValue({ id: 'pay-1', status: 'COMPLETED' })
})
afterEach(() => jest.useRealTimers())

describe('la llegada del cobro se toma al ENTRAR al controlador', () => {
  it('/tpv/fast: pasa la hora de entrada aunque espere al cliente', async () => {
    await tpvController.recordFastPayment(req(), res(), jest.fn())
    expect((paymentTpvService.recordFastPayment as jest.Mock).mock.calls[0][5]).toEqual(ENTRADA)
  })

  it('/tpv/orders/:orderId: pasa la hora de entrada', async () => {
    await tpvController.recordPayment(req(), res(), jest.fn())
    expect((paymentTpvService.recordOrderPayment as jest.Mock).mock.calls[0][5]).toEqual(ENTRADA)
  })

  it('/mobile/fast (POS, mismo esquema): pasa la hora de entrada aunque espere al cliente', async () => {
    await mobileController.recordFastPayment(req(), res(), jest.fn())
    expect((paymentTpvService.recordFastPayment as jest.Mock).mock.calls[0][5]).toEqual(ENTRADA)
  })
})
