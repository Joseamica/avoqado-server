/**
 * ¿A qué horas acepta pedidos un canal de delivery?
 *
 * 🔴 Hasta hoy se publicaba 24/7, y eso mete pedidos a las 3 de la mañana que nadie va a
 * cocinar. Cada rechazo cuenta contra la tasa de inyección que Uber exige (99.9%; revoca por
 * debajo de 99%): un horario inventado no cuesta unos pedidos, cuesta la integración.
 *
 * El problema de fondo: Avoqado NO guarda a qué hora abre un negocio. Lo único parecido es
 * el horario del módulo de reservas. Por eso esto resuelve en cascada Y DICE de dónde salió.
 */
import prisma from '@/utils/prismaClient'
import { esHorarioValido, resolveDeliveryHours } from '@/services/delivery-channels/core/deliveryHours.service'

const mockedReservas = (prisma as any).reservationSettings.findUnique as jest.Mock

const dia = (open = '09:00', close = '22:00') => ({ enabled: true, ranges: [{ open, close }] })
const semana = (o?: string, c?: string) => ({
  monday: dia(o, c),
  tuesday: dia(o, c),
  wednesday: dia(o, c),
  thursday: dia(o, c),
  friday: dia(o, c),
  saturday: dia(o, c),
  sunday: dia(o, c),
})

const link = (config: unknown = null): any => ({ id: 'l1', venueId: 'v1', provider: 'UBER_EATS', config })

describe('resolveDeliveryHours — de dónde salen las horas que publicamos', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockedReservas.mockResolvedValue(null)
  })

  it('🔴 lo configurado en el CANAL gana: el horario de delivery no es el del local', async () => {
    // Muchos restaurantes dejan de repartir antes de cerrar. Si alguien lo configuró para
    // este canal, ese dato es mejor que cualquier otro.
    const r = await resolveDeliveryHours(link({ deliveryHours: semana('11:00', '20:00') }))

    expect(r.fuente).toBe('CANAL')
    expect(r.horario.monday.ranges[0]).toEqual({ open: '11:00', close: '20:00' })
    expect(mockedReservas).not.toHaveBeenCalled() // ni consulta
  })

  it('sin horario del canal, usa el de RESERVAS: es dato real del negocio', async () => {
    mockedReservas.mockResolvedValue({ operatingHours: semana('08:00', '23:00') })

    const r = await resolveDeliveryHours(link())

    expect(r.fuente).toBe('RESERVAS')
    expect(r.horario.monday.ranges[0].close).toBe('23:00')
  })

  it('🔴 sin NADA configurado estima L-S 09:00-22:00 — y NO 24/7', async () => {
    // De los dos errores posibles sólo uno es reversible: equivocarse hacia MENOS horas hace
    // perder ventas, se nota rápido y se arregla. Equivocarse hacia 24/7 mete pedidos de
    // madrugada que nadie cocina, y eso se paga con la tasa de inyección.
    const r = await resolveDeliveryHours(link())

    expect(r.fuente).toBe('ESTIMADO')
    expect(r.horario.sunday.enabled).toBe(false)
    expect(r.horario.monday.ranges[0]).toEqual({ open: '09:00', close: '22:00' })
  })

  it('🔴 un horario con forma inválida NO se publica: cae al siguiente de la cascada', async () => {
    // Publicar basura como horario es peor que estimar, porque nadie lo revisa.
    mockedReservas.mockResolvedValue({ operatingHours: semana() })

    const r = await resolveDeliveryHours(link({ deliveryHours: { monday: 'a las 9' } }))

    expect(r.fuente).toBe('RESERVAS')
  })

  describe('esHorarioValido', () => {
    it('🔴 rechaza un día PRENDIDO sin rangos: sería "abierto de nunca a nunca"', () => {
      expect(esHorarioValido({ ...semana(), tuesday: { enabled: true, ranges: [] } })).toBe(false)
    })

    it('un día apagado SÍ puede ir sin rangos: es "cerrado"', () => {
      expect(esHorarioValido({ ...semana(), sunday: { enabled: false, ranges: [] } })).toBe(true)
    })

    it('🔴 rechaza el horario ENTERO si un solo día está roto', () => {
      // Publicar la mitad buena y la mitad rota es peor que caer al estimado: nadie se
      // entera de la mitad rota.
      expect(esHorarioValido({ ...semana(), friday: { enabled: true, ranges: [{ open: '25:00', close: '30:00' }] } })).toBe(false)
    })

    it('rechaza cierre antes de apertura', () => {
      expect(esHorarioValido(semana('22:00', '09:00'))).toBe(false)
    })

    it('rechaza si falta un día completo', () => {
      const { sunday, ...incompleto } = semana()
      expect(esHorarioValido(incompleto)).toBe(false)
    })
  })
})
