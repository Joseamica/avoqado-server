/**
 * IVA por producto, plan 6b (spec D12, §5.5): para encender, TODOS los aparatos vistos en 30 días en su versión mínima, sin tope; una
 * sesión del POS sin identidad en 30 días cuenta como aparato viejo; y 30 días completos de observación desde OBSERVADOR_POS_DESDE.
 */
import {
  avisosDeAparatos,
  bloqueosDeAparatos,
  revisarAparatos,
  soportaIvaPorProducto,
  type AparatoParaIva,
} from '@/services/fiscal/aparatosIva.service'
import { OBSERVADOR_POS_DESDE, POS_SIN_APARATO_MUESTREO_MS } from '@/services/mobile/deviceRegistry.service'

const DIA = 24 * 60 * 60 * 1000
const a = (over: Partial<AparatoParaIva>): AparatoParaIva => ({
  id: 't1',
  name: 'Caja 1',
  type: 'POS_ANDROID',
  brand: null,
  version: null,
  appVersionCode: null,
  ...over,
})
const db = (paginas: AparatoParaIva[][], marca: Date | null) => {
  let i = 0
  return {
    $queryRaw: jest.fn(async () => paginas[i++] ?? []),
    venuePosSinAparato: { findUnique: jest.fn(async () => (marca ? { ultimaVez: marca } : null)) },
  } as any
}
const DESPUES = new Date('2026-11-05T12:00:00Z') // observación completa

describe('soportaIvaPorProducto', () => {
  it.each([
    [a({ type: 'POS_ANDROID', version: '2.23.0' }), true],
    [a({ type: 'POS_ANDROID', version: '2.23.0-dev' }), true],
    [a({ type: 'POS_ANDROID', version: '2.22.9' }), false],
    [a({ type: 'POS_ANDROID', version: null }), false], // versión desconocida = vieja
    [a({ type: 'POS_IOS', version: '1.15.0' }), true],
    [a({ type: 'POS_IOS', version: '1.14.3' }), false],
    [a({ type: 'TPV_ANDROID', brand: 'PAX', appVersionCode: 117 }), true],
    [a({ type: 'TPV_ANDROID', brand: 'nexgo', appVersionCode: 117 }), true],
    [a({ type: 'TPV_ANDROID', brand: 'PAX', appVersionCode: 116 }), false],
    [a({ type: 'TPV_ANDROID', brand: 'PAX', appVersionCode: null }), false],
    [a({ type: 'TPV_ANDROID', brand: 'VERIFONE', appVersionCode: 999 }), false], // marca sin intérprete
    [a({ type: 'TPV_ANDROID', brand: null, appVersionCode: 999 }), false], // marca desconocida = vieja
    [a({ type: 'POS_DESKTOP', version: '9.9.9' }), false], // avoqado-desktop legacy (spec §3)
  ])('%#', (aparato, esperado) => expect(soportaIvaPorProducto(aparato)).toBe(esperado))
})

describe('revisarAparatos', () => {
  it('OBSERVADOR_POS_DESDE quedó fijo en 2026-10-01T22:00:00Z', () => {
    expect(OBSERVADOR_POS_DESDE.toISOString()).toBe('2026-10-01T22:00:00.000Z')
  })

  it('antes del 31-oct 22:00 UTC la observación no está completa y dice cuántos días faltan', async () => {
    const r = await revisarAparatos('v1', new Date('2026-10-20T00:00:00Z'), db([[]], null))
    expect(r.observacion).toEqual({ completa: false, faltanDias: 12 })
    expect(bloqueosDeAparatos(r, 'America/Mexico_City')).toEqual([
      expect.objectContaining({ codigo: 'APARATOS_VERIFICACION_PENDIENTE', mensaje: 'Verificación pendiente: faltan 12 días' }),
    ])
  })

  it('Minor T3-3: el último día dice «falta 1 día» (singular), nunca «faltan 1 días»', async () => {
    const r = await revisarAparatos('v1', new Date('2026-10-31T00:00:00Z'), db([[]], null))
    expect(r.observacion).toEqual({ completa: false, faltanDias: 1 })
    expect(bloqueosDeAparatos(r, 'America/Mexico_City')).toEqual([
      expect.objectContaining({ codigo: 'APARATOS_VERIFICACION_PENDIENTE', mensaje: 'Verificación pendiente: falta 1 día' }),
    ])
  })

  it('CX-6 · antes de completar la observación, la fecha se SUMA a los aparatos viejos y a la actividad sin identidad (no los tapa)', async () => {
    const ahora = new Date('2026-10-20T00:00:00Z')
    const r = await revisarAparatos('v1', ahora, db([[a({ name: 'Caja 2', version: '2.20.0' })]], new Date('2026-10-19T00:00:00Z')))
    expect(bloqueosDeAparatos(r, 'America/Mexico_City').map(b => b.codigo)).toEqual([
      'APARATOS_VERIFICACION_PENDIENTE',
      'APARATO_VIEJO',
      'POS_SIN_IDENTIDAD',
    ])
  })

  it('justo el 31-oct 22:00 UTC la observación ya está completa', async () => {
    const r = await revisarAparatos('v1', new Date('2026-10-31T22:00:00Z'), db([[]], null))
    expect(r.observacion).toEqual({ completa: true, faltanDias: 0 })
  })

  it('recorre TODAS las páginas (sin tope) y sólo deja los viejos', async () => {
    const pagina1 = Array.from({ length: 200 }, (_, i) => a({ id: `t${String(i).padStart(3, '0')}`, version: '2.23.0' }))
    const pagina2 = [a({ id: 'z1', name: 'Terminal 2', type: 'TPV_ANDROID', brand: 'PAX', appVersionCode: 110 })]
    const base = db([pagina1, pagina2], null)
    const r = await revisarAparatos('v1', DESPUES, base)
    expect(base.$queryRaw).toHaveBeenCalledTimes(2)
    expect(r.viejos.map(v => v.name)).toEqual(['Terminal 2'])
    expect(bloqueosDeAparatos(r, 'America/Mexico_City')).toEqual([
      expect.objectContaining({ codigo: 'APARATO_VIEJO', mensaje: 'Terminal 2 imprime el IVA de forma incorrecta' }),
    ])
  })

  it('un POS_DESKTOP y una terminal de marca desconocida vistos cuentan como viejos (no hay versión que imprima bien)', async () => {
    const r = await revisarAparatos(
      'v1',
      DESPUES,
      db(
        [
          [
            a({ id: 'd1', name: 'Windows 1', type: 'POS_DESKTOP', version: '9.9.9' }),
            a({ id: 't2', name: 'Terminal rara', type: 'TPV_ANDROID', brand: 'Ingenico', appVersionCode: 999 }),
            a({ id: 't3', name: 'Sunmi', type: 'POS_ANDROID', version: '2.23.0' }),
          ],
        ],
        null,
      ),
    )
    expect(r.viejos.map(v => v.name)).toEqual(['Windows 1', 'Terminal rara'])
  })

  it('la sesión del POS sin identidad cuenta 30 días + el muestreo, y luego vence sola', async () => {
    const dentro = new Date(DESPUES.getTime() - 30 * DIA - POS_SIN_APARATO_MUESTREO_MS + 60_000)
    const fuera = new Date(DESPUES.getTime() - 30 * DIA - POS_SIN_APARATO_MUESTREO_MS - 60_000)
    expect((await revisarAparatos('v1', DESPUES, db([[]], dentro))).sinIdentidad).toEqual({ ultimaVez: dentro })
    expect((await revisarAparatos('v1', DESPUES, db([[]], fuera))).sinIdentidad).toBeNull()
  })

  it('los avisos dicen el nombre del aparato y la fecha local de la última vez sin identidad', async () => {
    const r = await revisarAparatos('v1', DESPUES, db([[a({ name: 'Mesero 3', version: '2.20.0' })]], new Date('2026-11-01T03:00:00Z')))
    expect(avisosDeAparatos(r, 'America/Mexico_City')).toEqual([
      { codigo: 'APARATO_VIEJO', mensaje: 'Mesero 3 imprime el IVA de forma incorrecta; actualízalo' },
      {
        codigo: 'POS_SIN_IDENTIDAD',
        mensaje:
          'Un celular con una versión vieja de la app se usó el 31/10/2026; actualiza las apps de tus celulares. Este aviso se quita solo 30 días después de la última vez.',
      },
    ])
  })
})
