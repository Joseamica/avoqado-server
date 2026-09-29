// tests/unit/services/fiscal/normalizarIvaDeProducto.test.ts
import { codigoDeBarreraIva, normalizarIvaDeProducto, traducirErrorDeIva } from '@/services/fiscal/normalizarIvaDeProducto'

const actual16 = { ivaTratamiento: 'IVA_16' as const, taxRate: 0.16, objetoImp: '02' }
const actualExento = { ivaTratamiento: 'EXENTO' as const, taxRate: 0, objetoImp: '02' }
// Heredado: un producto que ya traía objetoImp '04' (BLOQUEADO_04) antes de esta feature — el
// trigger lo permite tal cual (migración `iva_tratamiento_columnas`); ver Ruling R9.
const actualBloqueado04 = { ivaTratamiento: 'BLOQUEADO_04' as const, taxRate: 0.16, objetoImp: '04' }

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

  // Ruling R9: el dashboard reenvía el `objetoImp` de la fila en CADA guardado (prefiltrado del
  // propio renglón, ProductWizardDialog.tsx). Eso NO es un cambio y no debe disparar ni un 409 ni
  // una derivación — sea cual sea el objetoImp heredado, y esté la bandera prendida o no.
  it('reenviar el objetoImp heredado (BLOQUEADO_04) sin tocar la tasa, con la bandera apagada ⇒ nada', () => {
    expect(normalizarIvaDeProducto({ objetoImp: '04' }, actualBloqueado04, false)).toEqual({})
  })

  it('reenviar la tupla EXENTA completa (0 / 02), con la bandera encendida ⇒ nada', () => {
    expect(normalizarIvaDeProducto({ objetoImp: '02', taxRate: 0 }, actualExento, true)).toEqual({})
  })

  it('reenviar la tupla IVA_16 completa (0.16 / 02) ⇒ nada', () => {
    expect(normalizarIvaDeProducto({ objetoImp: '02', taxRate: 0.16 }, actual16, false)).toEqual({})
  })

  it('un objetoImp REALMENTE distinto al de la fila SÍ es un cambio y sigue vetado con la bandera apagada', () => {
    expect(() => normalizarIvaDeProducto({ objetoImp: '01' }, actual16, false)).toThrow(
      expect.objectContaining({ statusCode: 409, code: 'IVA_POR_PRODUCTO_APAGADO' }),
    )
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

// Plan 4 · Tarea 2: la detección se extrae para que el traslado y el catálogo (Tareas 3 y 4) reconozcan la misma barrera.
describe('codigoDeBarreraIva', () => {
  const HISTORIA =
    'Este negocio ya lleva contabilidad en Avoqado (pólizas o periodos cerrados) y la contabilidad todavía no maneja IVA distinto de 16 %. Por eso este producto se queda en IVA 16 %. Escríbenos a hola@avoqado.io si lo necesitas.'
  // Forma medida de un P0001 en una consulta de MODELO: sin code ni meta, el texto sólo en el mensaje (routes.test.ts, 2026-09-25).
  const deModelo = (codigo: string) =>
    new Error(`Invalid \`tx.product.update()\` invocation: PostgresError { code: "P0001", message: "${codigo}", severity: "ERROR" }`)

  it.each([
    'IVA_POR_PRODUCTO_APAGADO',
    'IVA_REQUIERE_APP_NUEVA',
    'IVA_TRATAMIENTO_CONTRADICTORIO',
    'IVA_CONTABILIDAD_CON_HISTORIA',
    'IVA_NEGOCIO_CAMBIO_DE_ORGANIZACION',
    'IVA_TRASLADO_INCOMPATIBLE',
    'IVA_TRASLADO_CON_CONTABILIDAD',
    'IVA_PRODUCTO_CON_AJUSTE_DE_DELIVERY',
  ])('reconoce %s y ninguna otra llave (ninguna es subcadena de otra)', codigo => {
    expect(codigoDeBarreraIva(deModelo(codigo))?.code).toBe(codigo)
  })

  it('devuelve el mensaje exacto para el cliente', () => {
    expect(codigoDeBarreraIva(deModelo('IVA_CONTABILIDAD_CON_HISTORIA'))).toEqual({
      code: 'IVA_CONTABILIDAD_CON_HISTORIA',
      message: HISTORIA,
    })
    expect(codigoDeBarreraIva(deModelo('IVA_NEGOCIO_CAMBIO_DE_ORGANIZACION'))).toEqual({
      code: 'IVA_NEGOCIO_CAMBIO_DE_ORGANIZACION',
      message: 'Este negocio acaba de cambiar de organización. Vuelve a intentarlo.',
    })
  })

  it('otro error ⇒ null', () => {
    expect(codigoDeBarreraIva(new Error('otra cosa'))).toBeNull()
    expect(codigoDeBarreraIva(undefined)).toBeNull()
  })

  // Plan 4 · Tarea 3: las dos barreras del traslado de un negocio (trigger de Venue) salen 409 con el texto para el cliente.
  it.each([
    [
      'IVA_TRASLADO_INCOMPATIBLE',
      'No se puede mover este negocio: la organización destino lleva contabilidad en Avoqado y el negocio tiene productos o facturas con IVA distinto de 16 %. La contabilidad todavía no maneja esa mezcla.',
    ],
    [
      'IVA_TRASLADO_CON_CONTABILIDAD',
      'No se puede mover este negocio: ya tiene pólizas en la contabilidad de su organización, y moverlo haría que sus ventas se registraran otra vez en la nueva. Pide ayuda a soporte.',
    ],
  ])('traducirErrorDeIva vuelve %s un 409 con su mensaje exacto', (codigo, message) => {
    expect(() => traducirErrorDeIva(deModelo(codigo))).toThrow(expect.objectContaining({ statusCode: 409, code: codigo, message }))
  })

  it('traducirErrorDeIva vuelve la inversa contable un 409 con su código y mensaje', () => {
    expect(() => traducirErrorDeIva(deModelo('IVA_CONTABILIDAD_CON_HISTORIA'))).toThrow(
      expect.objectContaining({ statusCode: 409, code: 'IVA_CONTABILIDAD_CON_HISTORIA', message: HISTORIA }),
    )
  })

  it('plan 4b · la regla C sale 409 con su mensaje exacto', () => {
    expect(() => traducirErrorDeIva(deModelo('IVA_PRODUCTO_CON_AJUSTE_DE_DELIVERY'))).toThrow(
      expect.objectContaining({
        statusCode: 409,
        code: 'IVA_PRODUCTO_CON_AJUSTE_DE_DELIVERY',
        message:
          'Este producto ya tuvo ajustes de delivery (Uber). Para venderlo con otro IVA, crea un producto nuevo con el IVA correcto.',
      }),
    )
  })
})
