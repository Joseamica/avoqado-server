/**
 * IVA por producto (spec planes 6-7, §5.5): por negocio, la última vez que una sesión del POS pidió algo SIN identidad de
 * aparato (una app vieja). La lee el encendido del 6b. Cuelga del camino del cobro: nunca lanza.
 */
import { prismaMock } from '@tests/__helpers__/setup'
import { registerPosSinAparato } from '@/services/mobile/deviceRegistry.service'
import { utcTs } from '@/utils/sqlDates'

describe('registerPosSinAparato', () => {
  beforeEach(() => jest.clearAllMocks())

  it('anota la fecha del negocio con un upsert monotónico (nunca la hace retroceder)', async () => {
    prismaMock.$executeRaw.mockResolvedValue(1 as any)

    const cuando = new Date('2026-10-01T18:30:00.000Z')
    await expect(registerPosSinAparato('venue_1', cuando)).resolves.toBe(true)

    // Plantilla etiquetada: el simulador recibe (textos, ...valores). Guarda EXACTAMENTE el instante que le pasan: el
    // middleware cuenta su hora de muestreo desde ese mismo instante (Codex N2).
    const [textos, ...valores] = prismaMock.$executeRaw.mock.calls[0] as any[]
    const texto = (textos as string[]).join('?')
    expect(texto).toContain('INSERT INTO "VenuePosSinAparato"')
    expect(texto).toContain('ON CONFLICT ("venueId")')
    expect(texto).toContain('GREATEST(')
    expect(valores).toEqual(['venue_1', utcTs(cuando)])
  })

  it('una falla de base no lanza y avisa con false (para reintentar pronto)', async () => {
    prismaMock.$executeRaw.mockRejectedValue(new Error('db caída'))
    await expect(registerPosSinAparato('venue_1', new Date())).resolves.toBe(false)
  })
})
