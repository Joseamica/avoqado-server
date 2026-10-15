import { appliesNow } from '@/services/mobile/menu.mobile.service'

const TZ = 'America/Mexico_City'
type MenuShape = Parameters<typeof appliesNow>[0]
const menu = (o: Partial<MenuShape> = {}): MenuShape => ({
  availableFrom: null,
  availableUntil: null,
  availableDays: [],
  startDate: null,
  endDate: null,
  ...o,
})

describe('appliesNow (exportada para la tienda en línea, R20)', () => {
  it('un menú sin horario ni días aplica siempre', () => {
    expect(appliesNow(menu(), new Date('2026-10-14T18:00:00Z'), TZ)).toBe(true)
  })

  it('respeta la ventana horaria en la zona del venue', () => {
    const desayuno = menu({ availableFrom: '08:00', availableUntil: '12:00' })
    expect(appliesNow(desayuno, new Date('2026-10-14T15:00:00Z'), TZ)).toBe(true) // 09:00 CDMX
    expect(appliesNow(desayuno, new Date('2026-10-14T20:00:00Z'), TZ)).toBe(false) // 14:00 CDMX
  })

  it('una franja que cruza medianoche es válida', () => {
    const bar = menu({ availableFrom: '22:00', availableUntil: '02:00' })
    expect(appliesNow(bar, new Date('2026-10-15T05:00:00Z'), TZ)).toBe(true) // 23:00 CDMX
    expect(appliesNow(bar, new Date('2026-10-14T18:00:00Z'), TZ)).toBe(false) // 12:00 CDMX
  })

  it('filtra por día de la semana', () => {
    const entreSemana = menu({ availableDays: ['MON', 'TUE', 'WED', 'THU', 'FRI'] })
    expect(appliesNow(entreSemana, new Date('2026-10-14T18:00:00Z'), TZ)).toBe(true) // miércoles
    expect(appliesNow(entreSemana, new Date('2026-10-17T18:00:00Z'), TZ)).toBe(false) // sábado
  })

  it('respeta fecha de inicio y de fin', () => {
    const temporada = menu({ startDate: new Date('2026-12-01T00:00:00Z'), endDate: new Date('2026-12-31T00:00:00Z') })
    expect(appliesNow(temporada, new Date('2026-10-14T18:00:00Z'), TZ)).toBe(false)
    expect(appliesNow(temporada, new Date('2026-12-10T18:00:00Z'), TZ)).toBe(true)
  })
})
