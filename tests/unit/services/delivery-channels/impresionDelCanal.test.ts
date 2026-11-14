import { ValidationError } from '../../../../src/errors/AppError'
import {
  EstacionElegible,
  ImpresionDelCanal,
  leerImpresion,
  resolverImpresionReparto,
  validarEstacionesDeImpresion,
  validarFormaImpresion,
} from '../../../../src/services/delivery-channels/core/impresionDelCanal'

const est = (id: string, active = true, sendsComanda = true): [string, EstacionElegible] => [id, { id, active, sendsComanda }]
const DEFAULT = { comanda: 'SALON', empaque: 'NEGOCIO' }
const TODO: ImpresionDelCanal = { comanda: 'UNA_ESTACION', estacionId: 'cA', empaque: 'ESTACION', empaqueEstacionId: 'cB' }

describe('impresionDelCanal', () => {
  it('leerImpresion devuelve el default si falta o viene mal (nunca lanza)', () => {
    expect(leerImpresion(undefined)).toEqual(DEFAULT)
    expect(leerImpresion(null)).toEqual(DEFAULT)
    expect(leerImpresion({ impresion: 'basura' })).toEqual(DEFAULT)
    expect(leerImpresion({ impresion: { comanda: 'UNA_ESTACION', empaque: 'NO' } })).toEqual(DEFAULT)
  })

  it('leerImpresion lee una forma válida', () => {
    expect(leerImpresion({ impresion: TODO })).toEqual(TODO)
  })

  it('validarFormaImpresion', () => {
    expect(() => validarFormaImpresion({ comanda: 'UNA_ESTACION', empaque: 'NEGOCIO' })).toThrow(ValidationError)
    expect(() => validarFormaImpresion({ comanda: 'OTRA', empaque: 'NO' })).toThrow(ValidationError)
    expect(() => validarFormaImpresion({ comanda: 'SALON', empaque: 'ESTACION' })).toThrow(ValidationError)
    expect(() => validarFormaImpresion('x')).toThrow(ValidationError)
    expect(() => validarFormaImpresion({ comanda: 'SALON', empaque: 'NO' })).not.toThrow()
  })

  describe('resolverImpresionReparto', () => {
    it('estaciones elegibles', () => {
      expect(resolverImpresionReparto('RAPPI', TODO, new Map([est('cA'), est('cB')]))).toEqual({
        proveedor: 'RAPPI',
        estacionUnicaId: 'cA',
        empaque: true,
        empaqueEstacionId: 'cB',
      })
    })
    it('cA inactiva o ausente ⇒ null', () => {
      expect(resolverImpresionReparto('RAPPI', TODO, new Map([est('cA', false), est('cB')])).estacionUnicaId).toBeNull()
      expect(resolverImpresionReparto('RAPPI', TODO, new Map([est('cB')])).estacionUnicaId).toBeNull()
    })
    it('cB sin comanda ⇒ empaqueEstacionId null y empaque true', () => {
      const r = resolverImpresionReparto('RAPPI', TODO, new Map([est('cA'), est('cB', true, false)]))
      expect(r.empaqueEstacionId).toBeNull()
      expect(r.empaque).toBe(true)
    })
    it('empaque NO y NEGOCIO', () => {
      expect(resolverImpresionReparto('X', { comanda: 'SALON', empaque: 'NO' }, new Map())).toMatchObject({
        empaque: false,
        empaqueEstacionId: null,
        estacionUnicaId: null,
      })
      expect(resolverImpresionReparto('X', { comanda: 'SALON', empaque: 'NEGOCIO' }, new Map())).toMatchObject({
        empaque: true,
        empaqueEstacionId: null,
      })
    })
  })

  describe('validarEstacionesDeImpresion', () => {
    const db = (filas: unknown[]) => ({ printStation: { findMany: jest.fn().mockResolvedValue(filas) } }) as any
    it('estación de otro venue (no regresa) ⇒ lanza', async () => {
      const d = db([{ id: 'cA', active: true, sendsComanda: true }])
      await expect(validarEstacionesDeImpresion(d, 'v1', TODO)).rejects.toThrow(ValidationError)
      expect(d.printStation.findMany).toHaveBeenCalledWith({
        where: { venueId: 'v1', id: { in: ['cA', 'cB'] } },
        select: { id: true, active: true, sendsComanda: true },
        take: 2,
      })
    })
    it('apagada o sin comanda ⇒ lanza', async () => {
      await expect(
        validarEstacionesDeImpresion(db([{ id: 'cA', active: false, sendsComanda: true }, { id: 'cB', active: true, sendsComanda: true }]), 'v1', TODO),
      ).rejects.toThrow(ValidationError)
    })
    it('todas elegibles ⇒ resuelve; sin estaciones no consulta', async () => {
      await expect(
        validarEstacionesDeImpresion(db([{ id: 'cA', active: true, sendsComanda: true }, { id: 'cB', active: true, sendsComanda: true }]), 'v1', TODO),
      ).resolves.toBeUndefined()
      const d = db([])
      await validarEstacionesDeImpresion(d, 'v1', { comanda: 'SALON', empaque: 'NO' })
      expect(d.printStation.findMany).not.toHaveBeenCalled()
    })
  })
})
