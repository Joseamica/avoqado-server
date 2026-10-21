// tests/unit/schemas/passIntegrations.schema.test.ts
import {
  confirmModeSchema,
  connectTotalPassSchema,
  listVisitsSchema,
  productLinksSchema,
  sessionCapSchema,
  visitActionSchema,
  visitsSummarySchema,
  weeklyCapSchema,
} from '@/schemas/dashboard/passIntegrations.schema'

const params = { venueId: 'v1', provider: 'totalpass' }
describe('esquemas de pases', () => {
  // nuevo
  it('la llave se acepta con espacios y llega recortada', () => {
    const r = connectTotalPassSchema.parse({ params: { venueId: 'v1' }, body: { placeApiKey: '  abc-123-xyz-000  ' }, query: {} })
    expect(r.body.placeApiKey).toBe('abc-123-xyz-000')
  })
  // nuevo
  it('rechaza llaves vacías y campos de más', () => {
    expect(() => connectTotalPassSchema.parse({ params: { venueId: 'v1' }, body: { placeApiKey: '   ' }, query: {} })).toThrow()
    expect(() =>
      connectTotalPassSchema.parse({ params: { venueId: 'v1' }, body: { placeApiKey: 'abc-123-xyz', extra: 1 }, query: {} }),
    ).toThrow()
  })
  // nuevo
  it('proveedor en la URL: sólo totalpass o wellhub', () => {
    expect(() =>
      confirmModeSchema.parse({ params: { ...params, provider: 'fitpass' }, body: { confirmMode: 'AUTO' }, query: {} }),
    ).toThrow()
  })
  // nuevo
  it('ligas sin producto repetido', () => {
    expect(() =>
      productLinksSchema.parse({
        params,
        body: {
          links: [
            { productId: 'p', externalPlanId: '1' },
            { productId: 'p', externalPlanId: '2' },
          ],
        },
        query: {},
      }),
    ).toThrow(/repetid/)
  })
  // nuevo
  it('reglas: rangos de día, hora y lugares', () => {
    expect(() =>
      weeklyCapSchema.parse({ params: { venueId: 'v1' }, body: { weekday: 7, startMinute: null, maxSpots: 1 }, query: {} }),
    ).toThrow()
    expect(() => sessionCapSchema.parse({ params: { venueId: 'v1', classSessionId: 's1' }, body: { maxSpots: 501 }, query: {} })).toThrow()
    expect(
      sessionCapSchema.parse({ params: { venueId: 'v1', classSessionId: 's1' }, body: { maxSpots: null }, query: {} }).body.maxSpots,
    ).toBeNull()
  })
  // nuevo — P2-14: días locales, no instantes UTC
  it('lista de visitas: límite tope 100 y fechas como días AAAA-MM-DD', () => {
    const r = listVisitsSchema.parse({ params: { venueId: 'v1' }, body: {}, query: { limit: '500', from: '2030-01-01', to: '2030-01-31' } })
    expect(r.query.limit).toBe(100)
    expect(r.query.from).toBe('2030-01-01')
    expect(() => listVisitsSchema.parse({ params: { venueId: 'v1' }, body: {}, query: { from: '2030-01-01T00:00:00Z' } })).toThrow()
  })
  // nuevo
  it('resumen: mes AAAA-MM', () => {
    expect(() => visitsSummarySchema.parse({ params: { venueId: 'v1' }, body: {}, query: { month: '2030-1' } })).toThrow()
  })
  // nuevo — los mensajes llegan tal cual al usuario: español, con género y mayúscula
  it('mensajes en español: id inválido y campo de más', () => {
    const msgs = (r: { success: boolean; error?: { issues: { message: string }[] } }) => (r.error?.issues ?? []).map(i => i.message)
    expect(msgs(visitActionSchema.safeParse({ params: { venueId: 'v1', visitId: 123 }, body: {}, query: {} }))).toEqual([
      'El id de la visita no es válido.',
    ])
    expect(
      msgs(sessionCapSchema.safeParse({ params: { venueId: 'v1', classSessionId: 's1' }, body: { maxSpots: 1, extra: true }, query: {} })),
    ).toEqual(['Hay un campo que no se esperaba'])
  })
})
