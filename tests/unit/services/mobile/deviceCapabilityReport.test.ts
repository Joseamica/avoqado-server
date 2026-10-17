// tests/unit/services/mobile/deviceCapabilityReport.test.ts
import { prismaMock } from '@tests/__helpers__/setup'
import { invalidateCustomerDisplayCache } from '@/services/customer-display/customerDisplayCache'
import { reportDeviceCapabilitiesSchema } from '@/schemas/mobile/deviceCapabilities.mobile.schema'
import type { ReportDeviceCapabilitiesInput } from '@/schemas/mobile/deviceCapabilities.mobile.schema'
import { MAX_INSTALLATION_SWITCHES, recordCapabilityReport, siguienteInstalacion } from '@/services/mobile/deviceCapabilityReport.service'

jest.mock('@/services/customer-display/customerDisplayCache', () => ({ invalidateCustomerDisplayCache: jest.fn() }))

const AHORA = new Date('2026-09-25T18:00:00.000Z')

describe('siguienteInstalacion', () => {
  it('la misma: nada cambia', () => {
    expect(siguienteInstalacion('inst-1', [], 'inst-1', AHORA)).toEqual({ tipo: 'igual' })
  })

  it('sobre una fila SIN instalación: adopción, con la hora del servidor, sin tocar la lista (decisión 4)', () => {
    expect(siguienteInstalacion(null, ['2026-09-24T00:00:00.000Z'], 'inst-1', AHORA)).toEqual({ tipo: 'adopcion', desde: AHORA })
  })

  it('otra: cambio, y la hora del servidor entra a la lista', () => {
    expect(siguienteInstalacion('inst-1', [], 'inst-2', AHORA)).toEqual({ tipo: 'cambio', desde: AHORA, switches: [AHORA.toISOString()] })
  })

  it(`la lista conserva las últimas ${MAX_INSTALLATION_SWITCHES}, las más nuevas`, () => {
    const previas = Array.from({ length: 5 }, (_, i) => `2026-09-2${i}T00:00:00.000Z`)
    const r = siguienteInstalacion('a', previas, 'b', AHORA)
    expect(r).toEqual({ tipo: 'cambio', desde: AHORA, switches: [...previas.slice(1), AHORA.toISOString()] })
  })

  it('una lista guardada que no es un arreglo de textos no truena: se ignora lo que no es texto', () => {
    expect(siguienteInstalacion('a', { raro: true }, 'b', AHORA)).toMatchObject({ tipo: 'cambio', switches: [AHORA.toISOString()] })
    expect(siguienteInstalacion('a', [1, 'x'], 'b', AHORA)).toMatchObject({ switches: ['x', AHORA.toISOString()] })
  })
})

describe('reportDeviceCapabilitiesSchema — los dos campos nuevos van JUNTOS', () => {
  const base = { customerDisplay: { present: true, invertible: false }, displayModeProtocolVersion: 1 }
  const valida = (body: unknown) => reportDeviceCapabilitiesSchema.safeParse({ body, params: { venueId: 'v' } })

  it('el cuerpo de siempre (app vieja) sigue siendo válido', () => {
    expect(valida(base).success).toBe(true)
  })
  it('versión e instalación juntas: válido', () => {
    expect(valida({ ...base, customerDisplayDesignVersion: 2, installationId: 'f1e2d3c4-0000-4000-8000-000000000001' }).success).toBe(true)
  })
  it.each([
    [{ customerDisplayDesignVersion: 1 }],
    [{ installationId: 'abc' }],
    [{ customerDisplayDesignVersion: 3, installationId: 'abc' }],
    [{ customerDisplayDesignVersion: 1.5, installationId: 'abc' }],
    [{ customerDisplayDesignVersion: 1, installationId: 'con espacio' }],
    [{ customerDisplayDesignVersion: 1, installationId: 'x'.repeat(65) }],
    [{ displayModeProtocolVersion: 2 }],
  ])('rechaza %j, con el mensaje en español', extra => {
    const r = valida({ ...base, ...extra })
    expect(r.success).toBe(false)
    if (!r.success) expect(r.error.errors[0].message).toMatch(/[áéíóúñ]|debe|va|es|no/i)
  })

  // «Vacío» = omitido O null: la app puede serializar con encodeDefaults=false (omite) o true (manda null). Un null que
  // diera 400 dejaría al poll pidiendo el reporte para siempre.
  it('los dos en null (encodeDefaults=true) = ninguno: válido, y al servicio le llegan AUSENTES, como la app vieja', () => {
    const r = valida({ ...base, customerDisplayDesignVersion: null, installationId: null })
    expect(r.success).toBe(true)
    if (r.success) {
      expect(r.data.body.customerDisplayDesignVersion).toBeUndefined()
      expect(r.data.body.installationId).toBeUndefined()
    }
  })
  it.each([[{ customerDisplayDesignVersion: 1, installationId: null }], [{ customerDisplayDesignVersion: null, installationId: 'abc' }]])(
    'uno en null y el otro con valor %j: el MISMO 400 de «van juntas»',
    extra => {
      const r = valida({ ...base, ...extra })
      expect(r.success).toBe(false)
      if (!r.success) expect(r.error.errors.map(e => e.message)).toEqual(['La versión de diseño y la instalación van juntas'])
    },
  )
})

describe('recordCapabilityReport — la ficha cacheada se tira SÓLO tras un reporte que se guardó', () => {
  const invalidar = invalidateCustomerDisplayCache as jest.Mock
  const entrada = (extra: Record<string, unknown> = {}) => ({
    venueId: 'v',
    terminalId: 't',
    deviceUid: 'd',
    staffId: 's',
    now: AHORA,
    body: {
      customerDisplay: { present: true, invertible: false },
      displayModeProtocolVersion: 1,
      ...extra,
    } as ReportDeviceCapabilitiesInput,
  })

  beforeEach(() => {
    invalidar.mockClear()
    prismaMock.terminal.updateMany.mockReset().mockResolvedValue({ count: 1 } as any)
    prismaMock.terminal.findFirst
      .mockReset()
      .mockResolvedValue({ customerDisplayInstallationId: 'inst-1', customerDisplayInstallationSwitches: [] } as any)
  })

  it('con versión: la versión cambia el recorte de la ficha (spec §5.3) ⇒ se invalida esa terminal', async () => {
    expect(await recordCapabilityReport(entrada({ customerDisplayDesignVersion: 2, installationId: 'inst-1' }))).toBe('OK')
    expect(invalidar).toHaveBeenCalledWith('t')
  })

  it('sin versión (app vieja): versión null y ack limpio, y también se invalida', async () => {
    expect(await recordCapabilityReport(entrada())).toBe('OK')
    expect(prismaMock.terminal.updateMany.mock.calls[0][0].data).toMatchObject({ customerDisplayDesignVersion: null })
    expect(invalidar).toHaveBeenCalledWith('t')
  })

  it('sin binding: SIN_BINDING y nada se invalida', async () => {
    prismaMock.terminal.updateMany.mockResolvedValue({ count: 0 } as any)
    expect(await recordCapabilityReport(entrada())).toBe('SIN_BINDING')
    expect(invalidar).not.toHaveBeenCalled()
  })

  // 🔴 Codex P2-1 (ronda final de F0-B): la hora la pone el SERVIDOR al recibir (`observedAt` del controlador), así que dice
  // qué reporte es más nuevo. Uno más viejo de la MISMA instalación ya no deshace uno más nuevo; el empate se escribe (como
  // siempre: sin orden que respetar).
  describe('un reporte más VIEJO que el guardado no lo pisa', () => {
    const DESPUES = new Date(AHORA.getTime() + 1_000)
    const masNuevo = (extra: Record<string, unknown> = {}) =>
      ({
        customerDisplayInstallationId: 'inst-1',
        customerDisplayInstallationSwitches: [],
        capabilitiesObservedAt: DESPUES,
        ...extra,
      }) as any
    const conHora = { OR: [{ capabilitiesObservedAt: null }, { capabilitiesObservedAt: { lte: AHORA } }] }

    it('misma instalación: el CAS exige que lo guardado no sea más nuevo que este reporte', async () => {
      expect(await recordCapabilityReport(entrada({ customerDisplayDesignVersion: 2, installationId: 'inst-1' }))).toBe('OK')
      expect(prismaMock.terminal.updateMany.mock.calls[0][0].where).toMatchObject(conHora)
    })

    it('misma instalación y ya hay uno más nuevo: OK sin escribir ni invalidar', async () => {
      prismaMock.terminal.findFirst.mockResolvedValue(masNuevo())
      expect(await recordCapabilityReport(entrada({ customerDisplayDesignVersion: 1, installationId: 'inst-1' }))).toBe('OK')
      expect(prismaMock.terminal.updateMany).not.toHaveBeenCalled()
      expect(invalidar).not.toHaveBeenCalled()
    })

    it('misma instalación, el más nuevo escribe ENTRE la lectura y la escritura: pierde el CAS, relee y no escribe', async () => {
      prismaMock.terminal.findFirst
        .mockResolvedValueOnce({ customerDisplayInstallationId: 'inst-1', customerDisplayInstallationSwitches: [] } as any)
        .mockResolvedValueOnce(masNuevo())
      prismaMock.terminal.updateMany.mockResolvedValue({ count: 0 } as any)
      expect(await recordCapabilityReport(entrada({ customerDisplayDesignVersion: 1, installationId: 'inst-1' }))).toBe('OK')
      expect(prismaMock.terminal.updateMany).toHaveBeenCalledTimes(1)
      expect(invalidar).not.toHaveBeenCalled()
    })

    it('DD6: OTRA instalación no se compara por hora — su cambio siempre se cuenta (lo guarda el CAS de la instalación)', async () => {
      prismaMock.terminal.findFirst.mockResolvedValue(masNuevo())
      expect(await recordCapabilityReport(entrada({ customerDisplayDesignVersion: 1, installationId: 'inst-2' }))).toBe('OK')
      expect(prismaMock.terminal.updateMany.mock.calls[0][0].where).not.toHaveProperty('OR')
    })

    it('app vieja (sin instalación): el mismo CAS por hora, y perderlo contra uno más nuevo es OK, no SIN_BINDING', async () => {
      prismaMock.terminal.updateMany.mockResolvedValue({ count: 0 } as any)
      prismaMock.terminal.findFirst.mockResolvedValue({ capabilitiesObservedAt: DESPUES } as any)
      expect(await recordCapabilityReport(entrada())).toBe('OK')
      expect(prismaMock.terminal.updateMany.mock.calls[0][0].where).toMatchObject(conHora)
      expect(invalidar).not.toHaveBeenCalled()
    })
  })

  it('🔴 otra instalación le gana el CAS dos veces: 409 CUSTOMER_DISPLAY_INSTALLATION_RACE, sin invalidar', async () => {
    prismaMock.terminal.updateMany.mockResolvedValue({ count: 0 } as any)
    await expect(recordCapabilityReport(entrada({ customerDisplayDesignVersion: 1, installationId: 'otra' }))).rejects.toMatchObject({
      statusCode: 409,
      code: 'CUSTOMER_DISPLAY_INSTALLATION_RACE',
    })
    expect(prismaMock.terminal.findFirst).toHaveBeenCalledTimes(2)
    expect(invalidar).not.toHaveBeenCalled()
  })
})
