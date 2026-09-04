/**
 * 🔴 AISLAMIENTO DE TENANT: un cobro CRIPTO no puede caer en el turno de OTRO negocio.
 *
 * El defecto (3-sep-2026): `initiateCryptoPayment` validaba el turno con
 * `shift.findUnique({ where: { id: shiftId } })` — **sin `venueId`** — y después persistía ESE
 * mismo id (el que mandó el cliente) en el `Payment`. La `Order` sí resolvía por negocio, así que
 * las dos mitades del MISMO cobro podían apuntar a turnos distintos: el venue A perdía el cobro de
 * su corte y el venue B sumaba dinero ajeno. La regla dura del repo no admite matices — toda
 * consulta filtra por `venueId`.
 *
 * Lo que fija esta prueba: al INICIAR, el turno se resuelve UNA sola vez con
 * `turnoAbiertoDelNegocio(tx, venueId)` y ese id provisional va a la Order Y al Payment PENDING.
 * El `shiftId` que llegue en la petición se ignora (ninguna app lo manda: `CryptoPaymentRequest`
 * de avoqado-tpv ni siquiera tiene el campo), y `null` —negocio sin turno abierto— no detiene el
 * intento. La atribución final del dinero se decide cuando el Payment pasa a COMPLETED; la Order
 * conserva este turno como historia de creación.
 */
jest.mock('@/utils/prismaClient', () => {
  const client: any = {
    payment: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn(), create: jest.fn() },
    order: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn(), create: jest.fn() },
    venue: { findUnique: jest.fn() },
    venueCryptoConfig: { findUnique: jest.fn() },
    venueSettings: { findUnique: jest.fn() },
    shift: { findUnique: jest.fn(), findFirst: jest.fn() },
    terminal: { findFirst: jest.fn() },
    activityLog: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(),
  }
  client.$transaction.mockImplementation((cb: any) => cb(client))
  return { __esModule: true, default: client }
})
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))
jest.mock('@/communication/sockets/managers/socketManager', () => ({
  socketManager: { broadcastToVenue: jest.fn() },
}))
jest.mock('@/services/tpv/digitalReceipt.tpv.service', () => ({
  generateDigitalReceipt: jest.fn(),
  generateReceiptUrl: jest.fn(),
}))
jest.mock('@/services/venueSalesGuard', () => ({
  assertVenueSalesEnabled: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({
  __esModule: true,
  logAction: jest.fn().mockResolvedValue(undefined),
}))

import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'
import { initiateCryptoPayment } from '@/services/b4bit/b4bit.service'

const mockPrisma = prisma as unknown as {
  payment: { create: jest.Mock; update: jest.Mock }
  order: { create: jest.Mock; findUnique: jest.Mock }
  shift: { findUnique: jest.Mock; findFirst: jest.Mock }
  terminal: { findFirst: jest.Mock }
  venueCryptoConfig: { findUnique: jest.Mock }
  venueSettings: { findUnique: jest.Mock }
}
const mockLogAction = logAction as unknown as jest.Mock

const VENUE_A = 'cvenuea000000000000000001'
const TURNO_DE_A = 'cshifta000000000000000001'
/** El turno abierto de OTRO negocio (venue B): válido y OPEN, pero ajeno. Es lo que mandaba el cliente. */
const TURNO_DE_B = 'cshiftb000000000000000001'
const STAFF_ID = 'cstaff0000000000000000001'
const ORDEN_EXISTENTE = 'corder0000000000000000001'

/** Cobro cripto SIN orden previa: crea la orden testigo y el pago en la misma transacción. */
const cobro = (over: Record<string, any> = {}) => ({
  venueId: VENUE_A,
  orgId: 'corg00000000000000000001',
  amount: 5500,
  tip: 0,
  staffId: STAFF_ID,
  // 🔴 El turno de OTRO negocio, tal como llegaría del cliente.
  shiftId: TURNO_DE_B,
  deviceSerialNumber: null,
  rating: null,
  ...over,
})

const datosDeLaOrden = () => mockPrisma.order.create.mock.calls[0]?.[0]?.data
const datosDelPago = () => mockPrisma.payment.create.mock.calls[0]?.[0]?.data

describe('initiateCryptoPayment — atribución PROVISIONAL al turno del NEGOCIO', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // Si alguien volviera a consultar el turno por id suelto, esto le devolvería el de OTRO venue:
    // es la trampa exacta del defecto, puesta a propósito.
    mockPrisma.shift.findUnique.mockResolvedValue({ id: TURNO_DE_B, status: 'OPEN' })
    mockPrisma.shift.findFirst.mockResolvedValue({ id: TURNO_DE_A })
    mockPrisma.terminal.findFirst.mockResolvedValue(null)
    mockPrisma.order.create.mockResolvedValue({ id: 'order-cripto-1', orderNumber: 'CRYPTO-1' })
    mockPrisma.payment.create.mockResolvedValue({ id: 'pay-cripto-1' })
    mockPrisma.payment.update.mockResolvedValue({})
    mockPrisma.venueCryptoConfig.findUnique.mockResolvedValue(null)
    // La llamada al proveedor va DESPUÉS de la transacción: reventarla ahí deja la orden y el pago
    // ya escritos y observables, sin tener que simular la API de B4Bit.
    global.fetch = jest.fn().mockRejectedValue(new Error('no debió llamarse a B4Bit')) as any
  })

  it('🔴 el Payment NO hereda el turno de otro negocio: cae en el turno de ESTE venue', async () => {
    await initiateCryptoPayment(cobro() as any).catch(() => undefined)

    expect(datosDelPago().shiftId).toBe(TURNO_DE_A)
    expect(datosDelPago().shiftId).not.toBe(TURNO_DE_B)
  })

  it('Order y Payment reciben el MISMO turno, resuelto UNA sola vez', async () => {
    await initiateCryptoPayment(cobro() as any).catch(() => undefined)

    expect(datosDeLaOrden().shiftId).toBe(TURNO_DE_A)
    expect(datosDelPago().shiftId).toBe(datosDeLaOrden().shiftId)
    // Dos resoluciones serían dos fuentes de verdad para el mismo dato: es de donde salió el defecto.
    expect(mockPrisma.shift.findFirst).toHaveBeenCalledTimes(1)
    expect(mockPrisma.shift.findFirst.mock.calls[0][0].where).toEqual({ venueId: VENUE_A, status: 'OPEN', endTime: null })
  })

  it('🔴 nunca consulta un turno por id suelto (un `findUnique` sin `venueId` es la regla rota)', async () => {
    await initiateCryptoPayment(cobro() as any).catch(() => undefined)

    expect(mockPrisma.shift.findUnique).not.toHaveBeenCalled()
  })

  it('sobre una orden EXISTENTE el pago también cae en el turno del negocio', async () => {
    mockPrisma.order.findUnique.mockResolvedValue({ id: ORDEN_EXISTENTE, status: 'PENDING', paymentStatus: 'PENDING' })

    await initiateCryptoPayment(cobro({ orderId: ORDEN_EXISTENTE }) as any).catch(() => undefined)

    expect(mockPrisma.order.create).not.toHaveBeenCalled()
    expect(datosDelPago().shiftId).toBe(TURNO_DE_A)
  })

  it('sin turno abierto del negocio, el pago cae SIN turno — nunca en el del cliente — y el cobro no se detiene', async () => {
    mockPrisma.shift.findFirst.mockResolvedValue(null)

    await initiateCryptoPayment(cobro() as any).catch(() => undefined)

    expect(mockPrisma.payment.create).toHaveBeenCalledTimes(1)
    expect(datosDelPago().shiftId ?? null).toBeNull()
    expect(datosDeLaOrden().shiftId ?? null).toBeNull()
  })
})

/**
 * La respuesta conserva el turno que estaba abierto al iniciar para compatibilidad, pero no
 * promete la atribución final del dinero: esa vive en Payment.shiftId después del COMPLETED.
 * Campo aditivo y opcional — nada se quita.
 */
describe('initiateCryptoPayment — la respuesta conserva el turno PROVISIONAL', () => {
  const respuestaDeB4Bit = () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    text: async () =>
      JSON.stringify({ identifier: 'req-b4bit-1', web_url: 'https://pos.b4bit.com/x', address: 'addr', input_currency: 'BTC' }),
  })

  beforeEach(() => {
    jest.clearAllMocks()
    mockPrisma.shift.findUnique.mockResolvedValue({ id: TURNO_DE_B, status: 'OPEN' })
    mockPrisma.terminal.findFirst.mockResolvedValue(null)
    mockPrisma.order.create.mockResolvedValue({ id: 'order-cripto-1', orderNumber: 'CRYPTO-1' })
    mockPrisma.payment.create.mockResolvedValue({ id: 'pay-cripto-1' })
    mockPrisma.payment.update.mockResolvedValue({})
    mockPrisma.venueCryptoConfig.findUnique.mockResolvedValue({
      b4bitDeviceId: 'device-uuid',
      b4bitSecretKey: 'abcd',
      status: 'ACTIVE',
    })
    mockPrisma.venueSettings.findUnique.mockResolvedValue({ enableShifts: true })
    global.fetch = jest.fn().mockResolvedValue(respuestaDeB4Bit()) as any
  })

  it('devuelve el turno abierto al iniciar, no el que mandó el cliente', async () => {
    mockPrisma.shift.findFirst.mockResolvedValue({ id: TURNO_DE_A })

    const resultado = await initiateCryptoPayment(cobro() as any)

    expect(resultado.shiftId).toBe(TURNO_DE_A)
  })

  it('devuelve `null` cuando al iniciar no hay turno abierto', async () => {
    mockPrisma.shift.findFirst.mockResolvedValue(null)

    const resultado = await initiateCryptoPayment(cobro() as any)

    expect(resultado.shiftId).toBeNull()
  })
})

/**
 * La iniciación todavía NO representa dinero confirmado.
 *
 * 🔴 Corre sobre el camino COMPLETO —con B4Bit contestando que sí—, no sobre uno que revienta a
 * media función. Un `not.toHaveBeenCalled()` medido sobre una llamada que muere antes de llegar a
 * la rama pasa por el motivo equivocado: no dice «no registró», dice «nunca llegó». Por eso cada
 * caso comprueba además que la función TERMINÓ (`resultado.paymentId`).
 */
describe('initiateCryptoPayment — no audita dinero antes de la confirmación', () => {
  const respuestaDeB4Bit = () => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    text: async () =>
      JSON.stringify({ identifier: 'req-b4bit-1', web_url: 'https://pos.b4bit.com/x', address: 'addr', input_currency: 'BTC' }),
  })

  /** $55.00 de cargo + $5.00 de propina = $60.00. En centavos: 5500 + 500. */
  const cobroConPropina = () => cobro({ tip: 500 })

  beforeEach(() => {
    jest.clearAllMocks()
    mockPrisma.shift.findUnique.mockResolvedValue({ id: TURNO_DE_B, status: 'OPEN' })
    mockPrisma.shift.findFirst.mockResolvedValue(null) // el negocio no tiene turno abierto
    mockPrisma.terminal.findFirst.mockResolvedValue(null)
    mockPrisma.order.create.mockResolvedValue({ id: 'order-cripto-1', orderNumber: 'CRYPTO-1' })
    mockPrisma.payment.create.mockResolvedValue({ id: 'pay-cripto-1' })
    mockPrisma.payment.update.mockResolvedValue({})
    mockPrisma.venueCryptoConfig.findUnique.mockResolvedValue({
      b4bitDeviceId: 'device-uuid',
      b4bitSecretKey: 'abcd',
      status: 'ACTIVE',
    })
    mockPrisma.venueSettings.findUnique.mockResolvedValue({ enableShifts: true })
    global.fetch = jest.fn().mockResolvedValue(respuestaDeB4Bit()) as any
  })

  it('no emite la señal al iniciar aunque todavía no exista turno', async () => {
    const resultado = await initiateCryptoPayment(cobroConPropina() as any)

    expect(resultado.paymentId).toBe('pay-cripto-1')
    expect(mockLogAction).not.toHaveBeenCalled()
    expect(mockPrisma.venueSettings.findUnique).not.toHaveBeenCalled()
  })

  it('con turno abierto NO ensucia la bitácora (el camino normal no es una anomalía)', async () => {
    mockPrisma.shift.findFirst.mockResolvedValue({ id: TURNO_DE_A })

    const resultado = await initiateCryptoPayment(cobroConPropina() as any)

    // Llegó hasta el final: el `not.toHaveBeenCalled()` de abajo mide la rama, no una muerte previa.
    expect(resultado.paymentId).toBe('pay-cripto-1')
    expect(mockLogAction).not.toHaveBeenCalled()
  })

  it('🔴 un negocio con los TURNOS APAGADOS no genera falsa alarma en cada cobro', async () => {
    mockPrisma.venueSettings.findUnique.mockResolvedValue({ enableShifts: false })

    const resultado = await initiateCryptoPayment(cobroConPropina() as any)

    expect(resultado.paymentId).toBe('pay-cripto-1')
    expect(mockLogAction).not.toHaveBeenCalled()
  })

  it('una fila ausente de VenueSettings tampoco se consulta hasta confirmar', async () => {
    mockPrisma.venueSettings.findUnique.mockResolvedValue(null)

    const resultado = await initiateCryptoPayment(cobroConPropina() as any)

    expect(resultado.paymentId).toBe('pay-cripto-1')
    expect(mockPrisma.venueSettings.findUnique).not.toHaveBeenCalled()
    expect(mockLogAction).not.toHaveBeenCalled()
  })

  it('un error preparado en la lectura del gate no afecta la iniciación porque aún no se lee', async () => {
    mockPrisma.venueSettings.findUnique.mockRejectedValue(new Error('db caída'))

    const resultado = await initiateCryptoPayment(cobroConPropina() as any)

    expect(resultado.paymentId).toBe('pay-cripto-1')
    expect(mockPrisma.venueSettings.findUnique).not.toHaveBeenCalled()
    expect(mockLogAction).not.toHaveBeenCalled()
  })

  it('🔴 si B4Bit rechaza la orden no queda rastro de un cobro que nunca ocurrió', async () => {
    // Un venue con la configuración cripto rota reintenta: sin esto, una fila de auditoría por
    // cada intento fallido, y la bitácora acaba llena de pagos que no existieron.
    global.fetch = jest.fn().mockRejectedValue(new Error('B4Bit caído')) as any

    await expect(initiateCryptoPayment(cobroConPropina() as any)).rejects.toThrow()

    expect(mockLogAction).not.toHaveBeenCalled()
    expect(mockPrisma.venueSettings.findUnique).not.toHaveBeenCalled()
  })
})
