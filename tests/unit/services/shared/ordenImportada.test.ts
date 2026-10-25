import {
  esOrdenImportada,
  rechazarSiEsImportada,
  esPedidoDePlataforma,
  MENSAJE_ORDEN_IMPORTADA,
  MENSAJE_ORDEN_DE_PLATAFORMA,
} from '@/services/shared/ordenImportada'

describe('R11 (Codex r5): una cuenta importada de SoftRestaurant no se rearma desde Avoqado', () => {
  it('🔴 SoftRestaurant ⇒ rechazo 400 con la causa y su código', () => {
    let error: any
    try {
      rechazarSiEsImportada({ originSystem: 'POS_SOFTRESTAURANT' })
    } catch (e) {
      error = e
    }
    expect(error).toMatchObject({ statusCode: 400, code: 'ORDEN_IMPORTADA_DEL_POS', message: MENSAJE_ORDEN_IMPORTADA })
    expect(esOrdenImportada({ originSystem: 'POS_SOFTRESTAURANT' })).toBe(true)
  })
  it('control: AVOQADO pasa', () => {
    expect(() => rechazarSiEsImportada({ originSystem: 'AVOQADO' })).not.toThrow()
    expect(esOrdenImportada({ originSystem: 'AVOQADO' })).toBe(false)
    expect(esPedidoDePlataforma({ originSystem: 'AVOQADO' })).toBe(false)
  })
})

describe('Rappi 2b (T10): el total de un pedido de plataforma lo manda la plataforma', () => {
  it('🔴 DELIVERY_PLATFORM ⇒ rechazo 400 con su propio código y causa', () => {
    let error: any
    try {
      rechazarSiEsImportada({ originSystem: 'DELIVERY_PLATFORM' })
    } catch (e) {
      error = e
    }
    expect(error).toMatchObject({ statusCode: 400, code: 'ORDEN_DE_PLATAFORMA', message: MENSAJE_ORDEN_DE_PLATAFORMA })
  })

  it('la regla de IVA no cambia: un pedido de plataforma NO es «importada»', () => {
    expect(esOrdenImportada({ originSystem: 'DELIVERY_PLATFORM' })).toBe(false)
  })

  it('esPedidoDePlataforma sólo marca a la plataforma (las importadas siguen con esOrdenImportada)', () => {
    expect(esPedidoDePlataforma({ originSystem: 'DELIVERY_PLATFORM' })).toBe(true)
    expect(esPedidoDePlataforma({ originSystem: 'POS_SOFTRESTAURANT' })).toBe(false)
  })
})
