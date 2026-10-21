// H5 (r2): el Zod de ajustes usa la MISMA validación que la precarga (`isValidOrderingHours`, tarea 3).
import { inboxSchema, menuAvailabilityBody, menuProductsSchema, pauseSchema, settingsPatchBody } from '@/schemas/online-ordering.schema'

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

describe('menuAvailabilityBody: ids seguros (A9)', () => {
  const marcar = (o: Record<string, unknown>) => menuAvailabilityBody.safeParse({ availableOnline: true, ...o })

  it('acepta ids cuid y los de formato heredado (UUID)', () => {
    expect(marcar({ productIds: ['cmgq0x0p30001abcd1234efgh', '8a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'] }).success).toBe(true)
    expect(marcar({ categoryIds: ['cmgq0x0p30001abcd1234efgh'] }).success).toBe(true)
  })

  it('rechaza ids con bytes de control, espacios o de más de 40 caracteres, con el mensaje en español', () => {
    for (const mal of ['p1\u0000', 'p\u001b1', 'p 1', 'p'.repeat(41)]) {
      const r = marcar({ productIds: [mal] })
      expect(r.success).toBe(false)
      expect(JSON.stringify(r)).toContain('Platillo inválido')
      const c = marcar({ categoryIds: [mal] })
      expect(c.success).toBe(false)
      expect(JSON.stringify(c)).toContain('Categoría inválida')
    }
  })
})

describe('inboxSchema: cursor de los activos (A8)', () => {
  const bandeja = (query: Record<string, unknown>) => inboxSchema.safeParse({ params: { venueId: 'v1' }, query })
  const CURSOR = '2026-10-14T18:30:00.000Z_cmgq0x0p30001abcd1234efgh'

  it('sin cursor responde igual que hoy; con cursor sólo para la lista de activos', () => {
    expect(bandeja({}).success).toBe(true)
    expect(bandeja({ status: 'active', cursor: CURSOR }).success).toBe(true)
  })

  it('un cursor mal formado, con otra lista o con bytes de control se rechaza en español', () => {
    for (const mal of [
      'x',
      '2026-10-14_ord1',
      `${CURSOR}\u0000`,
      '2026-99-99T99:99:99.000Z_ord1',
      `${CURSOR.slice(0, 25)}${'a'.repeat(60)}`,
    ]) {
      const r = bandeja({ status: 'active', cursor: mal })
      expect(r.success).toBe(false)
      expect(JSON.stringify(r)).toContain('Cursor inválido')
    }
    const otraLista = bandeja({ status: 'all', cursor: CURSOR })
    expect(otraLista.success).toBe(false)
    expect(JSON.stringify(otraLista)).toContain('El cursor sólo sirve para los pedidos activos (status=active)')
  })
})

describe('menuProductsSchema: la lista del menú en línea del panel (1b)', () => {
  const lista = (query: Record<string, unknown>) => menuProductsSchema.safeParse({ params: { venueId: 'v1' }, query })

  it('todo es opcional; limit llega como texto en el query y sale como número (1..100)', () => {
    expect(lista({}).success).toBe(true)
    for (const [entrada, salida] of [
      ['1', 1],
      ['50', 50],
      ['100', 100],
    ] as const) {
      const r = lista({ limit: entrada })
      expect(r.success && r.data.query.limit).toBe(salida)
    }
    for (const mal of ['0', '101', '2.5', 'abc', '']) {
      const r = lista({ limit: mal })
      expect({ mal, success: r.success }).toEqual({ mal, success: false })
      expect(JSON.stringify(r)).toContain('Límite inválido')
    }
  })

  it('cursor y categoryId son ids seguros; uno inválido se rechaza en español', () => {
    expect(lista({ cursor: 'cmgq0x0p30001abcd1234efgh', categoryId: 'cmgq0x0p30001abcd1234efgh' }).success).toBe(true)
    for (const mal of ['p 1', 'p1\u0000', 'p'.repeat(41), '']) {
      expect(JSON.stringify(lista({ cursor: mal }))).toContain('Cursor inválido')
      expect(JSON.stringify(lista({ categoryId: mal }))).toContain('Categoría inválida')
    }
    expect(lista({ cursor: ['a', 'b'] }).success).toBe(false)
  })

  it('search se recorta y mide 1..80', () => {
    const r = lista({ search: '  tacos  ' })
    expect(r.success && r.data.query.search).toBe('tacos')
    expect(lista({ search: 'x'.repeat(80) }).success).toBe(true)
    // Postgres no guarda el byte nulo en un texto: llegaría como 500 si pasara la validación.
    for (const mal of ['   ', 'x'.repeat(81), '\u0000', 'a\u0000b']) {
      const m = lista({ search: mal })
      expect(m.success).toBe(false)
      expect(JSON.stringify(m)).toContain('Búsqueda inválida')
    }
  })
})
