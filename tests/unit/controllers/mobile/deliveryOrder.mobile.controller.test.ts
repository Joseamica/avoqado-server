/**
 * Aceptar / rechazar un pedido de delivery desde la cocina (T6 del plan «Rappi fase 2», D1).
 *
 * 🔴 POR QUÉ EXISTE: las apps de la cocina muestran `message` cuando una llamada falla, y estos dos controladores sólo
 * ponían `error`. El mesero veía un texto genérico en vez de «Espera: se está marcando listo». Ahora CADA respuesta de
 * error trae `message` igual a `error` (aditivo: las apps viejas siguen leyendo `error`).
 *
 * Y el texto de «tienda desconectada» decía «Uber» fijo aunque el pedido fuera de Rappi: ahora nombra al proveedor del pedido.
 */
const mockAceptar = jest.fn()
const mockRechazar = jest.fn()
const mockProveedorDeLaOrden = jest.fn()

jest.mock('@/services/delivery-channels/core/respondToDeliveryOrder.service', () => ({
  acceptDeliveryOrder: (...a: unknown[]) => mockAceptar(...a),
  denyDeliveryOrder: (...a: unknown[]) => mockRechazar(...a),
  proveedorDeLaOrden: (...a: unknown[]) => mockProveedorDeLaOrden(...a),
}))

import { acceptOrder, denyOrder } from '@/controllers/mobile/deliveryOrder.mobile.controller'
import { DeliveryWriteNotSentError } from '@/services/delivery-channels/core/types'
import { assertTiendaEscribible } from '@/services/delivery-channels/providers/rappi/rappi.http'

type Resp = { status: jest.Mock; json: jest.Mock }

function res(): Resp {
  const r: any = {}
  r.status = jest.fn(() => r)
  r.json = jest.fn(() => r)
  return r
}

const req = (body: unknown = {}) =>
  ({ params: { venueId: 'venue1', orderId: 'order1' }, body, authContext: { userId: 'staff1', venueId: 'venue1' } }) as any

/** Lo que salió por `res.json` y con qué status. */
const salida = (r: Resp) => ({ status: r.status.mock.calls[0]?.[0], cuerpo: r.json.mock.calls[0]?.[0] })

const TEXTO_NO_ENVIADO = 'No se pudo contactar a la app de delivery; no se envió nada, intenta de nuevo.'

/** Las dos operaciones del KDS, con su mock de servicio, para correr los mismos casos de error en ambas. */
const OPERACIONES = [
  { nombre: 'acceptOrder', controlador: acceptOrder, servicio: mockAceptar },
  { nombre: 'denyOrder', controlador: denyOrder, servicio: mockRechazar },
] as const

beforeEach(() => {
  mockAceptar.mockReset()
  mockRechazar.mockReset()
  mockProveedorDeLaOrden.mockReset().mockResolvedValue('UBER_EATS')
})

describe.each(OPERACIONES)('$nombre — cada respuesta de error trae `message`', ({ controlador, servicio }) => {
  it.each([
    ['404 el pedido no es de delivery', { outcome: 'NOT_A_DELIVERY_ORDER' }, 404, undefined],
    ['409 reserva: otra operación en curso', { outcome: 'OP_IN_PROGRESS', ocupadaPor: 'READY' }, 409, 'DELIVERY_OP_IN_PROGRESS'],
    ['409 reserva: sin operación conocida', { outcome: 'OP_IN_PROGRESS' }, 409, 'DELIVERY_OP_IN_PROGRESS'],
    ['409 reserva: retiro de renglón en curso', { outcome: 'LINE_ACTION_IN_PROGRESS' }, 409, 'LINE_ACTION_IN_PROGRESS'],
    ['502 la app de delivery no confirmó', { outcome: 'FAILED', error: 'HTTP 500' }, 502, 'HTTP 500'],
  ])('🔴 %s ⇒ `message` con el mismo texto que `error`', async (_nombre, respuestaServicio, status, code) => {
    servicio.mockResolvedValue(respuestaServicio)
    const r = res()

    await controlador(req(), r as any, jest.fn())

    const { status: s, cuerpo } = salida(r)
    expect(s).toBe(status)
    expect(cuerpo.ok).toBe(false)
    expect(typeof cuerpo.error).toBe('string')
    expect(cuerpo.error.length).toBeGreaterThan(0)
    expect(cuerpo.message).toBe(cuerpo.error) // 🔴 D1
    if (code) expect(cuerpo.code).toBe(code) // el campo de siempre se queda
  })

  it('🔴 503: «no se envió» (UNAVAILABLE) ⇒ PROVIDER_NOT_CONTACTED, con `message` igual a `error`', async () => {
    servicio.mockRejectedValue(new DeliveryWriteNotSentError('UNAVAILABLE', 'sin token'))
    const r = res()

    await controlador(req(), r as any, jest.fn())

    const { status, cuerpo } = salida(r)
    expect(status).toBe(503)
    expect(cuerpo).toEqual({ ok: false, code: 'PROVIDER_NOT_CONTACTED', error: TEXTO_NO_ENVIADO, message: TEXTO_NO_ENVIADO })
    // Un 503 no depende del proveedor: no hace falta ir a buscarlo.
    expect(mockProveedorDeLaOrden).not.toHaveBeenCalled()
  })

  it('🔴 409: tienda desconectada (STORE_NOT_AUTHORIZED) ⇒ STORE_NOT_CONNECTED, con `message` igual a `error`', async () => {
    servicio.mockRejectedValue(new DeliveryWriteNotSentError('STORE_NOT_AUTHORIZED', 'sin consentimiento'))
    const r = res()

    await controlador(req(), r as any, jest.fn())

    const { status, cuerpo } = salida(r)
    expect(status).toBe(409)
    expect(cuerpo.code).toBe('STORE_NOT_CONNECTED')
    expect(cuerpo.message).toBe(cuerpo.error)
  })

  it('el proveedor se busca con el negocio y el pedido de la ruta (nunca con el de otro negocio)', async () => {
    servicio.mockRejectedValue(new DeliveryWriteNotSentError('STORE_NOT_AUTHORIZED', 'x'))

    await controlador(req(), res() as any, jest.fn())

    expect(mockProveedorDeLaOrden).toHaveBeenCalledWith('venue1', 'order1')
  })
})

describe('STORE_NOT_CONNECTED nombra al proveedor DEL PEDIDO', () => {
  it.each(OPERACIONES)(
    '🔴 $nombre: una escritura bloqueada de Rappi ⇒ 409 STORE_NOT_CONNECTED que dice «Rappi», no «Uber»',
    async ({ controlador, servicio }) => {
      // El error REAL del candado de Rappi: si no fuera un «no se envió», el controlador lo dejaría pasar como un 500.
      let bloqueo: unknown
      try {
        assertTiendaEscribible('900105814', [])
      } catch (e) {
        bloqueo = e
      }
      servicio.mockRejectedValue(bloqueo)
      mockProveedorDeLaOrden.mockResolvedValue('RAPPI')
      const next = jest.fn()
      const r = res()

      await controlador(req(), r as any, next)

      const { status, cuerpo } = salida(r)
      expect(next).not.toHaveBeenCalled()
      expect(status).toBe(409)
      expect(cuerpo.code).toBe('STORE_NOT_CONNECTED')
      expect(cuerpo.error).toBe('Rappi está desconectada para esta tienda; reconéctala desde el panel.')
      expect(cuerpo.message).toBe(cuerpo.error)
      expect(cuerpo.error).not.toMatch(/Uber/)
    },
  )

  it.each([
    ['UBER_EATS', 'Uber Eats está desconectada para esta tienda; reconéctala desde el panel.'],
    ['RAPPI', 'Rappi está desconectada para esta tienda; reconéctala desde el panel.'],
    // Proveedor sin nombre visible conocido, o pedido que ya no se puede leer: una palabra neutra, nunca «Uber».
    ['DIDI_FOOD', 'La app de delivery está desconectada para esta tienda; reconéctala desde el panel.'],
    [null, 'La app de delivery está desconectada para esta tienda; reconéctala desde el panel.'],
  ])('proveedor %s ⇒ «%s»', async (proveedor, texto) => {
    mockAceptar.mockRejectedValue(new DeliveryWriteNotSentError('STORE_NOT_AUTHORIZED', 'x'))
    mockProveedorDeLaOrden.mockResolvedValue(proveedor)
    const r = res()

    await acceptOrder(req(), r as any, jest.fn())

    expect(salida(r).cuerpo.error).toBe(texto)
    expect(salida(r).cuerpo.message).toBe(texto)
  })

  it('🔴 si NO se puede buscar el proveedor (la base falla) igual se contesta el 409, con la palabra neutra', async () => {
    mockAceptar.mockRejectedValue(new DeliveryWriteNotSentError('STORE_NOT_AUTHORIZED', 'x'))
    mockProveedorDeLaOrden.mockRejectedValue(new Error('base caída'))
    const next = jest.fn()
    const r = res()

    await acceptOrder(req(), r as any, next)

    expect(next).not.toHaveBeenCalled()
    const { status, cuerpo } = salida(r)
    expect(status).toBe(409)
    expect(cuerpo.code).toBe('STORE_NOT_CONNECTED')
    expect(cuerpo.error).toBe('La app de delivery está desconectada para esta tienda; reconéctala desde el panel.')
  })
})

describe('REGRESIÓN — lo que no cambia', () => {
  it('el éxito de acceptOrder sigue siendo `{ ok: true, outcome }`, sin `message`', async () => {
    mockAceptar.mockResolvedValue({ outcome: 'ACCEPTED' })
    const r = res()

    await acceptOrder(req(), r as any, jest.fn())

    expect(r.status).not.toHaveBeenCalled()
    expect(r.json).toHaveBeenCalledWith({ ok: true, outcome: 'ACCEPTED' })
  })

  it('el éxito de denyOrder sigue siendo `{ ok: true, outcome }`, sin `message`', async () => {
    mockRechazar.mockResolvedValue({ outcome: 'CANCELLED' })
    const r = res()

    await denyOrder(req({ reason: 'TOO_BUSY' }), r as any, jest.fn())

    expect(mockRechazar).toHaveBeenCalledWith('venue1', 'order1', 'TOO_BUSY', 'staff1')
    expect(r.json).toHaveBeenCalledWith({ ok: true, outcome: 'CANCELLED' })
  })

  it('el plazo vencido sigue siendo un 409 con el código del servicio, y su texto de siempre', async () => {
    mockAceptar.mockResolvedValue({ outcome: 'FAILED', error: 'PEDIDO_YA_NO_ACTIVO' })
    const r = res()

    await acceptOrder(req(), r as any, jest.fn())

    expect(salida(r)).toEqual({
      status: 409,
      cuerpo: {
        ok: false,
        code: 'PEDIDO_YA_NO_ACTIVO',
        error: 'El pedido ya no está activo: la app de delivery lo canceló por tiempo. No hace falta reintentar.',
        message: 'El pedido ya no está activo: la app de delivery lo canceló por tiempo. No hace falta reintentar.',
      },
    })
  })

  it('el 502 de denyOrder conserva su texto', async () => {
    mockRechazar.mockResolvedValue({ outcome: 'FAILED', error: 'HTTP 500' })
    const r = res()

    await denyOrder(req(), r as any, jest.fn())

    expect(salida(r)).toEqual({
      status: 502,
      cuerpo: {
        ok: false,
        code: 'HTTP 500',
        error: 'No se pudo avisarle a la app de delivery. Intenta de nuevo.',
        message: 'No se pudo avisarle a la app de delivery. Intenta de nuevo.',
      },
    })
  })

  it('el 409 de «otra operación en curso» nombra la operación, como antes', async () => {
    mockAceptar.mockResolvedValue({ outcome: 'OP_IN_PROGRESS', ocupadaPor: 'REMOVE_ITEM' })
    const r = res()

    await acceptOrder(req(), r as any, jest.fn())

    expect(salida(r).cuerpo.error).toBe('Espera: se está retirando un artículo. Intenta en un momento.')
  })

  it.each(OPERACIONES)(
    '$nombre: un error que NO es «no se envió» sigue yendo a `next` (500 del manejador global)',
    async ({ controlador, servicio }) => {
      const boom = new Error('boom')
      servicio.mockRejectedValue(boom)
      const next = jest.fn()
      const r = res()

      await controlador(req(), r as any, next)

      expect(next).toHaveBeenCalledWith(boom)
      expect(r.status).not.toHaveBeenCalled()
      expect(mockProveedorDeLaOrden).not.toHaveBeenCalled()
    },
  )
})
