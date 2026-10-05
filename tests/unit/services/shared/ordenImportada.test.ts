import { esOrdenImportada, rechazarSiEsImportada, MENSAJE_ORDEN_IMPORTADA } from '@/services/shared/ordenImportada'

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
  it.each([['AVOQADO'], ['DELIVERY_PLATFORM']])('control: %s pasa', origen => {
    expect(() => rechazarSiEsImportada({ originSystem: origen })).not.toThrow()
    expect(esOrdenImportada({ originSystem: origen })).toBe(false)
  })
})
