// H5 (r2): el Zod de ajustes usa la MISMA validación que la precarga (`isValidOrderingHours`, tarea 3).
import { pauseSchema, settingsPatchBody } from '@/schemas/online-ordering.schema'

const dia = (enabled: boolean, ranges: Array<{ open: string; close: string }> = []) => ({ enabled, ranges })
const semana = (o: Record<string, unknown> = {}) => ({
  monday: dia(true, [{ open: '13:00', close: '22:00' }]),
  tuesday: dia(true, [{ open: '13:00', close: '22:00' }]),
  wednesday: dia(true, [{ open: '13:00', close: '22:00' }]),
  thursday: dia(true, [{ open: '13:00', close: '22:00' }]),
  friday: dia(true, [{ open: '20:00', close: '02:00' }]),
  saturday: dia(true, [{ open: '20:00', close: '02:00' }]),
  sunday: dia(false),
  ...o,
})

describe('settingsPatchBody.hours (H5)', () => {
  it('acepta un horario nocturno (20:00–02:00)', () => {
    expect(settingsPatchBody.safeParse({ hours: semana() }).success).toBe(true)
  })

  it('rechaza lo que la precarga también rechaza: un día abierto sin franjas o una franja de largo cero', () => {
    expect(settingsPatchBody.safeParse({ hours: semana({ monday: dia(true) }) }).success).toBe(false)
    expect(settingsPatchBody.safeParse({ hours: semana({ monday: dia(true, [{ open: '10:00', close: '10:00' }]) }) }).success).toBe(false)
  })
})

describe('settingsPatchBody: monto mínimo y pausa con fecha (validados en la ruta)', () => {
  it('el monto mínimo es ≥ 0 y con máximo 2 decimales', () => {
    for (const ok of [0, 150, 99.5, 186.25]) expect(settingsPatchBody.safeParse({ minOrderAmount: ok }).success).toBe(true)
    for (const mal of [-1, 10.555, 0.1 + 0.2, 1e-7]) expect(settingsPatchBody.safeParse({ minOrderAmount: mal }).success).toBe(false)
  })

  it('`pausedUntil` es una fecha ISO (en UTC o con desfase, como la manda el MCP) o null', () => {
    expect(settingsPatchBody.safeParse({ pausedUntil: '2026-10-14T19:00:00.000Z' }).success).toBe(true)
    expect(settingsPatchBody.safeParse({ pausedUntil: '2026-10-14T13:00:00-06:00' }).success).toBe(true)
    expect(settingsPatchBody.safeParse({ pausedUntil: null }).success).toBe(true)
    for (const mal of ['2026-10-14', 'mañana', '']) expect(settingsPatchBody.safeParse({ pausedUntil: mal }).success).toBe(false)
  })
})

describe('pauseSchema (R12: la pausa desde el piso)', () => {
  const pausa = (minutes: unknown) => pauseSchema.safeParse({ params: { venueId: 'v1' }, body: { minutes } })

  it('sólo 15, 30 o 60 minutos, o null para reanudar', () => {
    for (const ok of [15, 30, 60, null]) expect(pausa(ok).success).toBe(true)
  })

  it('cualquier otro valor se rechaza en la ruta, con el mensaje en español', () => {
    for (const mal of [45, 0, -15, '30', 30.5, undefined]) expect(pausa(mal).success).toBe(false)
    const r = pausa(45)
    expect(r.success === false && r.error.issues[0].message).toBe('Elige 15, 30 o 60 minutos')
  })
})
