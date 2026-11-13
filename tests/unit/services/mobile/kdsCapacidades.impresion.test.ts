import { anexarCapacidades, type VentaDeComanda } from '@/services/mobile/kdsCapacidades'

const impresion = { proveedor: 'RAPPI', estacionUnicaId: 'est1', empaque: false, empaqueEstacionId: null }
const venta = (o: Partial<VentaDeComanda>) =>
  ({
    type: 'DELIVERY',
    conProveedor: true,
    status: 'OPEN',
    renglones: new Map(),
    retiros: new Map(),
    cursos: new Map(),
    impresionReparto: null,
    ...o,
  }) as unknown as VentaDeComanda
const k = { status: 'NEW', items: [{ id: 'i1' }] }

describe('anexarCapacidades · impresionReparto', () => {
  it('un reparto de proveedor trae impresionReparto', () => {
    const r = anexarCapacidades({ items: [{ id: 'i1' }] }, k, venta({ impresionReparto: impresion }))
    expect((r as any).impresionReparto).toEqual(impresion)
  })
  it('lo que no es reparto de proveedor no agrega la llave', () => {
    const r = anexarCapacidades({ items: [{ id: 'i1' }] }, k, venta({ conProveedor: false }))
    expect(r).not.toHaveProperty('impresionReparto')
  })
})
