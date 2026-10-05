import fs from 'fs'
import path from 'path'
import { adapterFor, hasAdapter } from '@/services/aggregators/core/adapterRegistry'

describe('registro de adaptadores de pases', () => {
  // nuevo
  it('TOTALPASS tiene adaptador con la interfaz completa', () => {
    expect(hasAdapter('TOTALPASS')).toBe(true)
    const a = adapterFor('TOTALPASS')
    for (const fn of [
      'parseWebhook',
      'dedupKey',
      'publishSession',
      'updateSpots',
      'updateSessionDetails',
      'unpublishSession',
      'respondBooking',
      'cancelBooking',
      'validateVisit',
      'identify',
      'setup',
    ]) {
      expect(typeof (a as any)[fn]).toBe('function')
    }
  })
  // nuevo
  it('WELLHUB todavía no (Plan 4) y lo dice en español', () => {
    expect(hasAdapter('WELLHUB')).toBe(false)
    expect(() => adapterFor('WELLHUB')).toThrow(/No hay adaptador/)
  })
  // nuevo — guardia: el núcleo no nombra proveedores
  it('el núcleo no compara proveedores por nombre (sólo el registro puede)', () => {
    const dir = path.join(__dirname, '../../../../src/services/aggregators/core')
    const ofensores = fs
      .readdirSync(dir)
      .filter(f => f.endsWith('.ts') && f !== 'adapterRegistry.ts' && f !== 'types.ts')
      .filter(f => /(TOTALPASS|WELLHUB|totalpass|wellhub)/.test(fs.readFileSync(path.join(dir, f), 'utf8')))
    expect(ofensores).toEqual([])
  })
})
