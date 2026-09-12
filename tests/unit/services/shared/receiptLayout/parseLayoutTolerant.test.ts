import { effectiveLayout, parseLayoutTolerant } from '@/services/shared/receiptLayout/parseLayoutTolerant'
import { CANONICAL_LAYOUT } from '@/services/shared/receiptLayout/templates'

const canonicalRaw = () => JSON.parse(JSON.stringify(CANONICAL_LAYOUT)) as unknown[]

describe('parseLayoutTolerant — bloque a bloque, ignorando lo desconocido', () => {
  it('un tipo desconocido se descarta y el resto sobrevive (ignoreUnknownKeys no cubre miembros de una unión)', () => {
    const raw = [...canonicalRaw()]
    raw.splice(3, 0, { type: 'hologram', intensity: 9 })
    const r = parseLayoutTolerant(raw)
    expect(r.dropped).toBe(1)
    expect(r.blocks).toEqual(CANONICAL_LAYOUT)
  })
  it('un bloque conocido pero malformado también se descarta', () => {
    const r = parseLayoutTolerant([{ type: 'text', lines: 'no es lista' }, { type: 'signature' }])
    expect(r).toEqual({ blocks: [{ type: 'signature' }], dropped: 1 })
  })
  it('lo que no es una lista no es una receta', () => {
    expect(parseLayoutTolerant({ blocks: [] })).toEqual({ blocks: [], dropped: 0 })
  })
})

describe('effectiveLayout — nunca un ticket sin dato legal', () => {
  it('receta íntegra → custom', () => {
    expect(effectiveLayout(canonicalRaw())).toMatchObject({ source: 'custom', dropped: 0 })
  })
  it('🔴 si tras descartar falta un obligatorio, cae a la canónica embebida', () => {
    const raw = canonicalRaw().filter(b => (b as { type: string }).type !== 'totals')
    expect(effectiveLayout(raw)).toEqual({ blocks: CANONICAL_LAYOUT, source: 'fallback', dropped: 0 })
  })
  it('basura → canónica', () => {
    expect(effectiveLayout('nada')).toMatchObject({ source: 'fallback' })
  })
})
