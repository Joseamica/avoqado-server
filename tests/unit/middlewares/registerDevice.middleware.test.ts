import { DeviceFormFactor } from '@prisma/client'

import { __resetDeviceSeenCache, capturarVenueDeLaRuta, registerDeviceMiddleware } from '../../../src/middlewares/registerDevice.middleware'
import { resolveUserRoleForVenue } from '../../../src/middlewares/checkPermission.middleware'
import { POS_SIN_APARATO_MUESTREO_MS, registerDeviceSeen, registerPosSinAparato } from '../../../src/services/mobile/deviceRegistry.service'

jest.mock('../../../src/services/mobile/deviceRegistry.service', () => ({
  registerDeviceSeen: jest.fn().mockResolvedValue({ terminalId: 't1', created: true, name: 'iPhone 15 Pro' }),
  registerPosSinAparato: jest.fn().mockResolvedValue(true),
  // La constante REAL: si producción cambia el muestreo, estas pruebas lo miden (Codex N4).
  POS_SIN_APARATO_MUESTREO_MS: jest.requireActual('../../../src/services/mobile/deviceRegistry.service').POS_SIN_APARATO_MUESTREO_MS,
}))
jest.mock('../../../src/middlewares/checkPermission.middleware', () => ({ resolveUserRoleForVenue: jest.fn() }))

const mockRegister = registerDeviceSeen as jest.Mock
const mockPosSinAparato = registerPosSinAparato as jest.Mock
const mockRol = resolveUserRoleForVenue as jest.Mock

const BASE_HEADERS = {
  'x-device-id': 'device-abc',
  'x-device-platform': 'IOS',
  'x-device-manufacturer': 'Apple',
  'x-device-model': 'iPhone16,1',
  'x-device-form-factor': 'PHONE',
  'x-device-os-version': 'iOS 17.2',
  'x-app-version': '1.4.0',
}

function makeReq(
  headers: Record<string, any> = BASE_HEADERS,
  authContext: any = { venueId: 'venue_1', userId: 'staff_1' },
  params: Record<string, string> = {},
) {
  return { headers, authContext, params } as any
}

/**
 * El middleware engancha el trabajo a `res.on('finish')`. El helper simula esa
 * secuencia: corre el middleware y, salvo que se pida lo contrario, dispara el evento
 * como haría Express al terminar de enviar la respuesta.
 */
function run(
  req: any,
  {
    emitFinish = true,
    emitClose = false,
    locals = {},
    venueDeLaRuta,
  }: { emitFinish?: boolean; emitClose?: boolean; locals?: Record<string, unknown>; venueDeLaRuta?: string } = {},
) {
  const next = jest.fn()
  const handlers: Record<string, Array<() => void>> = {}
  const res = {
    locals,
    writableFinished: false,
    on: (event: string, handler: () => void) => {
      ;(handlers[event] ??= []).push(handler)
    },
  } as any

  registerDeviceMiddleware(req, res, next)
  // Lo que hace `router.param('venueId', …)` al resolver la ruta; después Express puede restaurar `req.params`.
  if (venueDeLaRuta) capturarVenueDeLaRuta(req, res, () => undefined, venueDeLaRuta)
  if (emitFinish) {
    res.writableFinished = true // Node lo marca justo antes de emitir `finish`
    ;(handlers.finish ?? []).forEach(handler => handler())
  }
  if (emitClose) (handlers.close ?? []).forEach(handler => handler())
  return next
}

beforeEach(() => {
  jest.clearAllMocks()
  __resetDeviceSeenCache()
  mockRegister.mockResolvedValue({ terminalId: 't1', created: true, name: 'iPhone 15 Pro' })
  mockPosSinAparato.mockResolvedValue(true)
  mockRol.mockResolvedValue({ role: 'CASHIER', source: 'staffVenue' })
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

// ── IVA por producto (spec planes 6-7, §5.5): una sesión del POS sin identidad de aparato es una app vieja ──────────
describe('sesión del POS sin identidad de aparato', () => {
  const SIN_IDENTIDAD = {}
  const HORA = POS_SIN_APARATO_MUESTREO_MS
  const pos = (venueId = 'venue_1') => ({ venueId, userId: 'staff_1', origen: 'POS' })
  const flush = () => new Promise(resolve => setImmediate(resolve))
  const anoto = (venueId: string) => expect(mockPosSinAparato).toHaveBeenCalledWith(venueId, expect.any(Date))
  /** Una escritura que la prueba termina cuando quiere (base lenta). */
  const escrituraPendiente = () => {
    let terminar!: (guardado: boolean) => void
    mockPosSinAparato.mockReturnValueOnce(new Promise<boolean>(resolve => (terminar = resolve)))
    return (guardado: boolean) => terminar(guardado)
  }
  let reloj: jest.SpyInstance

  beforeEach(() => {
    reloj = jest.spyOn(Date, 'now').mockReturnValue(1_000_000)
  })
  afterEach(() => reloj.mockRestore())

  it('anota el negocio del token, con la hora del instante, y no registra aparato', async () => {
    run(makeReq(SIN_IDENTIDAD, pos()))
    await flush()
    expect(mockRol).toHaveBeenCalledWith(expect.objectContaining({ userId: 'staff_1', targetVenueId: 'venue_1' }))
    expect(mockPosSinAparato).toHaveBeenCalledWith('venue_1', new Date(1_000_000))
    expect(mockRegister).not.toHaveBeenCalled()
  })

  it('🔴 R3-1: una persona dada de baja en el negocio de su propio token no anota ni le gasta el turno a un POS vigente', async () => {
    mockRol.mockResolvedValueOnce({ role: null, source: 'none' })
    run(makeReq(SIN_IDENTIDAD, pos()))
    await flush()
    expect(mockPosSinAparato).not.toHaveBeenCalled()

    run(makeReq(SIN_IDENTIDAD, pos()))
    await flush()
    anoto('venue_1')
  })

  it('una sesión de A operando en B marca B si la persona pertenece a B', async () => {
    run(makeReq(SIN_IDENTIDAD, pos('venue_A'), { venueId: 'venue_B' }))
    await flush()
    expect(mockRol).toHaveBeenCalledWith(expect.objectContaining({ userId: 'staff_1', targetVenueId: 'venue_B' }))
    anoto('venue_B')
  })

  it('🔴 N1: una sesión de A en la ruta de B SIN pertenecer a B no anota, ni le aparta el turno a un POS real de B', async () => {
    mockRol.mockResolvedValueOnce({ role: null, source: 'none' })
    run(makeReq(SIN_IDENTIDAD, pos('venue_A'), { venueId: 'venue_B' }))
    await flush()
    expect(mockPosSinAparato).not.toHaveBeenCalled()

    run(makeReq(SIN_IDENTIDAD, pos('venue_B')))
    await flush()
    anoto('venue_B')
  })

  it('🔴 #3: el negocio que capturó la ruta manda aunque Express ya haya restaurado `req.params`', async () => {
    run(makeReq(SIN_IDENTIDAD, pos('venue_A'), {}), { venueDeLaRuta: 'venue_B' })
    await flush()
    anoto('venue_B')
    expect(mockPosSinAparato).not.toHaveBeenCalledWith('venue_A', expect.anything())
  })

  it('un token del dashboard (sin origen) no anota nada', () => {
    run(makeReq(SIN_IDENTIDAD, { venueId: 'venue_1', userId: 'staff_1' }))
    expect(mockPosSinAparato).not.toHaveBeenCalled()
  })

  it('una app nueva con identidad no anota (se registra como siempre)', () => {
    run(makeReq(BASE_HEADERS, pos()))
    expect(mockPosSinAparato).not.toHaveBeenCalled()
    expect(mockRegister).toHaveBeenCalledTimes(1)
  })

  it('identidad incompleta (sin plataforma) cuenta como sin identidad', async () => {
    run(makeReq({ 'x-device-id': 'device-abc' }, pos()))
    await flush()
    anoto('venue_1')
  })

  it('sin negocio en la ruta ni en el token no anota', () => {
    run(makeReq(SIN_IDENTIDAD, { userId: 'staff_1', origen: 'POS' }))
    expect(mockPosSinAparato).not.toHaveBeenCalled()
  })

  it('no anota antes de que termine la respuesta', () => {
    run(makeReq(SIN_IDENTIDAD, pos()), { emitFinish: false })
    expect(mockPosSinAparato).not.toHaveBeenCalled()
  })

  it('🔴 #7: una petición abortada (`close` sin `finish`) también cuenta; un aparato con identidad no se registra por eso', async () => {
    run(makeReq(SIN_IDENTIDAD, pos()), { emitFinish: false, emitClose: true })
    await flush()
    anoto('venue_1')
    run(makeReq(BASE_HEADERS, pos()), { emitFinish: false, emitClose: true })
    expect(mockRegister).not.toHaveBeenCalled()
  })

  it('la pantalla de capacidades (registro explícito) no silencia la observación', async () => {
    run(makeReq(SIN_IDENTIDAD, pos()), { locals: { deviceRegistrationHandled: true } })
    await flush()
    anoto('venue_1')
  })

  it('dentro de la hora no vuelve a anotar; justo al cumplirse, sí; otro negocio no espera', async () => {
    run(makeReq(SIN_IDENTIDAD, pos()))
    await flush()
    reloj.mockReturnValue(1_000_000 + HORA - 1)
    run(makeReq(SIN_IDENTIDAD, pos()))
    run(makeReq(SIN_IDENTIDAD, pos('venue_2')))
    await flush()
    expect(mockPosSinAparato).toHaveBeenCalledTimes(2)
    reloj.mockReturnValue(1_000_000 + HORA)
    run(makeReq(SIN_IDENTIDAD, pos()))
    await flush()
    expect(mockPosSinAparato).toHaveBeenCalledTimes(3)
  })

  it('🔴 N2: la hora cuenta desde el instante GUARDADO, no desde que terminó una escritura lenta', async () => {
    const terminar = escrituraPendiente()
    run(makeReq(SIN_IDENTIDAD, pos()))
    await flush()
    reloj.mockReturnValue(1_000_000 + 10_000) // la base tardó 10 s
    terminar(true)
    await flush()
    reloj.mockReturnValue(1_000_000 + HORA)
    run(makeReq(SIN_IDENTIDAD, pos()))
    await flush()
    expect(mockPosSinAparato).toHaveBeenCalledTimes(2)
  })

  it('🔴 N3: si la reserva se expulsó mientras se escribía, al terminar no se reinserta', async () => {
    const terminar = escrituraPendiente()
    run(makeReq(SIN_IDENTIDAD, pos()))
    await flush()
    __resetDeviceSeenCache() // la poda (o un reinicio del caché) la quitó
    terminar(true)
    await flush()
    run(makeReq(SIN_IDENTIDAD, pos()))
    await flush()
    expect(mockPosSinAparato).toHaveBeenCalledTimes(2)
  })

  it('si la base falla, reintenta al minuto en vez de perder la hora', async () => {
    mockPosSinAparato.mockResolvedValueOnce(false)
    run(makeReq(SIN_IDENTIDAD, pos()))
    await flush()
    reloj.mockReturnValue(1_000_000 + 60_000 - 1)
    run(makeReq(SIN_IDENTIDAD, pos()))
    await flush()
    expect(mockPosSinAparato).toHaveBeenCalledTimes(1)
    reloj.mockReturnValue(1_000_000 + 60_000)
    run(makeReq(SIN_IDENTIDAD, pos()))
    await flush()
    expect(mockPosSinAparato).toHaveBeenCalledTimes(2)
  })

  it('si la anotación o la consulta de pertenencia lanzan, la cadena sigue y no queda promesa sin manejar', async () => {
    mockPosSinAparato.mockRejectedValueOnce(new Error('boom'))
    const next = run(makeReq(SIN_IDENTIDAD, pos()))
    mockRol.mockRejectedValueOnce(new Error('db caída'))
    run(makeReq(SIN_IDENTIDAD, pos('venue_A'), { venueId: 'venue_B' }))
    await flush()
    expect(mockPosSinAparato).toHaveBeenCalledTimes(1)
    expect(next).toHaveBeenCalledWith()
  })
})
