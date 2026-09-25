// tests/unit/services/fiscal/normalizarIvaDeProducto.test.ts
import { normalizarIvaDeProducto, traducirErrorDeIva } from '@/services/fiscal/normalizarIvaDeProducto'

const actual16 = { ivaTratamiento: 'IVA_16' as const, taxRate: 0.16 }
const actualExento = { ivaTratamiento: 'EXENTO' as const, taxRate: 0 }

describe('normalizarIvaDeProducto', () => {
  it('sin campos de IVA no escribe nada', () => {
    expect(normalizarIvaDeProducto({}, actual16, false)).toEqual({})
  })

  it('app vieja reenvía la MISMA tasa (edita otra cosa): no cambia el tratamiento, aunque sea EXENTO', () => {
    expect(normalizarIvaDeProducto({ taxRate: 0 }, actualExento, true)).toEqual({})
    expect(normalizarIvaDeProducto({ taxRate: '0.16' }, actual16, false)).toEqual({})
  })

  it('app vieja cambia la tasa (toggle «Exento» ⇒ 0) con la bandera apagada ⇒ 409 IVA_POR_PRODUCTO_APAGADO', () => {
    expect(() => normalizarIvaDeProducto({ taxRate: 0 }, actual16, false)).toThrow(
      expect.objectContaining({ statusCode: 409, code: 'IVA_POR_PRODUCTO_APAGADO' }),
    )
  })

  it('app vieja cambia la tasa con la bandera encendida ⇒ 409 IVA_REQUIERE_APP_NUEVA (no adivina tasa 0 vs exento)', () => {
    expect(() => normalizarIvaDeProducto({ taxRate: 0 }, actual16, true)).toThrow(
      expect.objectContaining({ statusCode: 409, code: 'IVA_REQUIERE_APP_NUEVA' }),
    )
  })

  it('cliente nuevo elige un tratamiento ofrecido con la bandera encendida', () => {
    expect(normalizarIvaDeProducto({ ivaTratamiento: 'IVA_0' }, actual16, true)).toEqual({ ivaTratamiento: 'IVA_0' })
  })

  it('cliente nuevo pide un tratamiento ≠ 16 con la bandera apagada ⇒ 409', () => {
    expect(() => normalizarIvaDeProducto({ ivaTratamiento: 'EXENTO' }, actual16, false)).toThrow(
      expect.objectContaining({ code: 'IVA_POR_PRODUCTO_APAGADO' }),
    )
  })

  it('volver a IVA_16 siempre se permite', () => {
    expect(normalizarIvaDeProducto({ ivaTratamiento: 'IVA_16' }, actualExento, false)).toEqual({ ivaTratamiento: 'IVA_16' })
  })

  it('un tratamiento no ofrecido en v1 (8 %, no objeto, bloqueados) se rechaza con 400', () => {
    for (const t of ['IVA_8', 'NO_OBJETO', 'BLOQUEADO_04', 'CUALQUIERA']) {
      expect(() => normalizarIvaDeProducto({ ivaTratamiento: t }, actual16, true)).toThrow(
        expect.objectContaining({ statusCode: 400, code: 'IVA_TRATAMIENTO_CONTRADICTORIO' }),
      )
    }
  })

  it('tratamiento + tupla que lo contradice ⇒ 400', () => {
    expect(() => normalizarIvaDeProducto({ ivaTratamiento: 'IVA_0', taxRate: 0.16 }, actual16, true)).toThrow(
      expect.objectContaining({ code: 'IVA_TRATAMIENTO_CONTRADICTORIO' }),
    )
  })

  it('producto nuevo (sin actual) sin campos de IVA ⇒ nada (nace IVA_16 por el default)', () => {
    expect(normalizarIvaDeProducto({}, null, false)).toEqual({})
  })
})

describe('traducirErrorDeIva', () => {
  it('convierte el error del trigger en el 409 con el mensaje en español', () => {
    const err = Object.assign(new Error('IVA_POR_PRODUCTO_APAGADO'), {
      code: 'P2010',
      meta: { code: 'P0001', message: 'IVA_POR_PRODUCTO_APAGADO' },
    })
    expect(() => traducirErrorDeIva(err)).toThrow(expect.objectContaining({ statusCode: 409, code: 'IVA_POR_PRODUCTO_APAGADO' }))
  })

  it('cualquier otro error pasa intacto (no lo traga)', () => {
    expect(() => traducirErrorDeIva(new Error('otra cosa'))).not.toThrow()
  })
})
