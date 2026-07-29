import { DeviceFormFactor } from '@prisma/client'

import { __resetDeviceSeenCache, registerDeviceMiddleware } from '../../../src/middlewares/registerDevice.middleware'
import { registerDeviceSeen } from '../../../src/services/mobile/deviceRegistry.service'

jest.mock('../../../src/services/mobile/deviceRegistry.service', () => ({
  registerDeviceSeen: jest.fn().mockResolvedValue({ terminalId: 't1', created: true, name: 'iPhone 15 Pro' }),
}))

const mockRegister = registerDeviceSeen as jest.Mock

const BASE_HEADERS = {
  'x-device-id': 'device-abc',
  'x-device-platform': 'IOS',
  'x-device-manufacturer': 'Apple',
  'x-device-model': 'iPhone16,1',
  'x-device-form-factor': 'PHONE',
  'x-device-os-version': 'iOS 17.2',
  'x-app-version': '1.4.0',
}

function makeReq(headers: Record<string, any> = BASE_HEADERS, authContext: any = { venueId: 'venue_1', userId: 'staff_1' }) {
  return { headers, authContext } as any
}

/**
 * El middleware engancha el trabajo a `res.on('finish')`. El helper simula esa
 * secuencia: corre el middleware y, salvo que se pida lo contrario, dispara el evento
 * como haría Express al terminar de enviar la respuesta.
 */
function run(req: any, { emitFinish = true }: { emitFinish?: boolean } = {}) {
  const next = jest.fn()
  const finishHandlers: Array<() => void> = []
  const res = {
    on: (event: string, handler: () => void) => {
      if (event === 'finish') finishHandlers.push(handler)
    },
  } as any

  registerDeviceMiddleware(req, res, next)
  if (emitFinish) finishHandlers.forEach(handler => handler())
  return next
}

beforeEach(() => {
  jest.clearAllMocks()
  __resetDeviceSeenCache()
  mockRegister.mockResolvedValue({ terminalId: 't1', created: true, name: 'iPhone 15 Pro' })
})

describe('registerDeviceMiddleware', () => {
  // ── FEATURE: camino feliz ─────────────────────────────────────────────────────
  describe('registro', () => {
    it('registra el dispositivo y sigue la cadena', () => {
      const next = run(makeReq())

      expect(next).toHaveBeenCalledTimes(1)
      expect(next).toHaveBeenCalledWith() // sin error
      expect(mockRegister).toHaveBeenCalledWith({
        venueId: 'venue_1',
        staffId: 'staff_1',
        identity: expect.objectContaining({
          deviceUid: 'device-abc',
          platform: 'IOS',
          manufacturer: 'Apple',
          modelIdentifier: 'iPhone16,1',
          formFactor: DeviceFormFactor.PHONE,
          osVersion: 'iOS 17.2',
          appVersion: '1.4.0',
        }),
      })
    })

    it('acepta plataforma en minúsculas', () => {
      run(makeReq({ ...BASE_HEADERS, 'x-device-platform': 'android' }))
      expect(mockRegister.mock.calls[0][0].identity.platform).toBe('ANDROID')
    })

    it('pasa el serial cuando el aparato lo expone', () => {
      run(makeReq({ ...BASE_HEADERS, 'x-device-serial': 'PAX123' }))
      expect(mockRegister.mock.calls[0][0].identity.serialNumber).toBe('PAX123')
    })
  })

  // ── FEATURE: debounce (el que evita tumbar el pool) ───────────────────────────
  describe('debounce', () => {
    it('50 requests seguidos del mismo dispositivo producen UNA sola escritura', () => {
      for (let i = 0; i < 50; i++) run(makeReq())
      expect(mockRegister).toHaveBeenCalledTimes(1)
    })

    it('los 50 requests igual siguen la cadena — el debounce no bloquea a nadie', () => {
      const nexts = Array.from({ length: 50 }, () => run(makeReq()))
      for (const next of nexts) expect(next).toHaveBeenCalledTimes(1)
    })

    it('dispositivos distintos NO se debouncean entre sí', () => {
      run(makeReq({ ...BASE_HEADERS, 'x-device-id': 'device-a' }))
      run(makeReq({ ...BASE_HEADERS, 'x-device-id': 'device-b' }))
      expect(mockRegister).toHaveBeenCalledTimes(2)
    })

    it('el mismo dispositivo en venues distintos NO se debouncea entre sí', () => {
      run(makeReq(BASE_HEADERS, { venueId: 'venue_1', userId: 'staff_1' }))
      run(makeReq(BASE_HEADERS, { venueId: 'venue_2', userId: 'staff_1' }))
      expect(mockRegister).toHaveBeenCalledTimes(2)
    })

    it('vuelve a escribir cuando expira la ventana', () => {
      const realNow = Date.now
      try {
        let clock = 1_000_000
        Date.now = () => clock

        run(makeReq())
        expect(mockRegister).toHaveBeenCalledTimes(1)

        clock += 59_000 // dentro de la ventana
        run(makeReq())
        expect(mockRegister).toHaveBeenCalledTimes(1)

        clock += 2_000 // ya expiró
        run(makeReq())
        expect(mockRegister).toHaveBeenCalledTimes(2)
      } finally {
        Date.now = realNow
      }
    })

    it('un segundo staff en el mismo dispositivo no salta el debounce', () => {
      // La ventana es por dispositivo, no por persona: si no, un cambio de turno
      // dispararía una escritura por cada mesero que entra.
      run(makeReq(BASE_HEADERS, { venueId: 'venue_1', userId: 'staff_1' }))
      run(makeReq(BASE_HEADERS, { venueId: 'venue_1', userId: 'staff_2' }))
      expect(mockRegister).toHaveBeenCalledTimes(1)
    })
  })

  // ── FEATURE: compatibilidad hacia atrás ──────────────────────────────────────
  describe('apps que todavía no mandan headers', () => {
    it('sin X-Device-Id no hace nada y sigue', () => {
      const next = run(makeReq({}))
      expect(next).toHaveBeenCalledTimes(1)
      expect(mockRegister).not.toHaveBeenCalled()
    })

    it('con X-Device-Id vacío no hace nada y sigue', () => {
      const next = run(makeReq({ ...BASE_HEADERS, 'x-device-id': '   ' }))
      expect(next).toHaveBeenCalledTimes(1)
      expect(mockRegister).not.toHaveBeenCalled()
    })

    it('sin plataforma no registra — no sabríamos qué tipo de terminal es', () => {
      const next = run(makeReq({ 'x-device-id': 'device-abc' }))
      expect(next).toHaveBeenCalledTimes(1)
      expect(mockRegister).not.toHaveBeenCalled()
    })

    it('sin authContext no registra y sigue', () => {
      // null, NO undefined: undefined activaría el valor por defecto de makeReq.
      const next = run(makeReq(BASE_HEADERS, null))
      expect(next).toHaveBeenCalledTimes(1)
      expect(mockRegister).not.toHaveBeenCalled()
    })

    it('sin venueId en el token no registra (aislamiento de tenant)', () => {
      const next = run(makeReq(BASE_HEADERS, { userId: 'staff_1' }))
      expect(next).toHaveBeenCalledTimes(1)
      expect(mockRegister).not.toHaveBeenCalled()
    })
  })

  // ── SEGURIDAD: los headers son entrada no confiable ──────────────────────────
  describe('entrada no confiable', () => {
    it('ignora un form factor inventado en vez de pasarlo a Prisma', () => {
      run(makeReq({ ...BASE_HEADERS, 'x-device-form-factor': 'DROP TABLE Terminal' }))
      expect(mockRegister.mock.calls[0][0].identity.formFactor).toBeUndefined()
    })

    it('ignora una plataforma inventada y no registra', () => {
      run(makeReq({ ...BASE_HEADERS, 'x-device-platform': 'WINDOWS_PHONE' }))
      expect(mockRegister).not.toHaveBeenCalled()
    })

    it('recorta un deviceUid enorme a 64 caracteres', () => {
      run(makeReq({ ...BASE_HEADERS, 'x-device-id': 'x'.repeat(5000) }))
      expect(mockRegister.mock.calls[0][0].identity.deviceUid).toHaveLength(64)
    })

    it('recorta textos enormes a 120 caracteres', () => {
      run(makeReq({ ...BASE_HEADERS, 'x-device-model': 'y'.repeat(5000) }))
      expect(mockRegister.mock.calls[0][0].identity.modelIdentifier).toHaveLength(120)
    })

    it('toma el primer valor si el header viene duplicado', () => {
      run(makeReq({ ...BASE_HEADERS, 'x-device-model': ['iPhone16,1', 'inyectado'] }))
      expect(mockRegister.mock.calls[0][0].identity.modelIdentifier).toBe('iPhone16,1')
    })
  })

  // ── FEATURE: jamás rompe el camino del cobro ─────────────────────────────────
  describe('jamás bloquea', () => {
    it('sigue la cadena aunque el servicio lance de forma síncrona', () => {
      mockRegister.mockImplementation(() => {
        throw new Error('boom')
      })
      const next = run(makeReq())
      expect(next).toHaveBeenCalledTimes(1)
      expect(next).toHaveBeenCalledWith()
    })

    it('sigue la cadena y no deja promesas rechazadas sin manejar', async () => {
      mockRegister.mockRejectedValue(new Error('base caída'))
      const next = run(makeReq())
      expect(next).toHaveBeenCalledTimes(1)
      await new Promise(resolve => setImmediate(resolve)) // deja correr el .catch
    })

    it('no toca la base durante el request — todo ocurre después de la respuesta', () => {
      // Sin disparar 'finish': el request ya terminó su paso por el middleware y no
      // se escribió nada. Es lo que garantiza cero latencia en el camino del cobro.
      const next = run(makeReq(), { emitFinish: false })

      expect(next).toHaveBeenCalledTimes(1)
      expect(mockRegister).not.toHaveBeenCalled()
    })

    it('sigue la cadena aunque res.on no exista', () => {
      const next = jest.fn()
      registerDeviceMiddleware(makeReq(), {} as any, next)
      expect(next).toHaveBeenCalledTimes(1)
    })
  })
})
