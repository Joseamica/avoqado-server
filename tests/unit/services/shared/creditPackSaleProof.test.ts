import { Prisma } from '@prisma/client'
import { firmarFotoDelPaquete, leerFotoDelPaquete } from '@/services/shared/creditPacksOnPaidOrder'

/**
 * La foto de lo vendido viaja por la app, firmada por el servidor: la app la guarda sin red y la devuelve al entregar. El
 * servidor sólo cree lo que él mismo firmó: «el monto lo pone el SERVIDOR, nunca quien llama».
 */
describe('Foto firmada del paquete vendido', () => {
  const pack = {
    id: 'pack-1',
    name: '10 clases',
    price: new Prisma.Decimal(1500),
    currency: 'MXN',
    validityDays: 30,
    items: [{ productId: 'prod-1', quantity: 10 }],
  }

  it('lee lo que firmó', () => {
    const foto = leerFotoDelPaquete(firmarFotoDelPaquete(pack))
    expect(foto).toMatchObject({
      creditPackId: 'pack-1',
      price: '1500.00',
      validityDays: 30,
      items: [{ productId: 'prod-1', quantity: 10 }],
    })
  })

  it('🔴 una foto alterada no vale', () => {
    const firmada = firmarFotoDelPaquete(pack)!
    const [cuerpo, firma] = firmada.split('.')
    const leida = JSON.parse(Buffer.from(cuerpo, 'base64url').toString())
    leida.foto.price = '1.00'
    leida.foto.items[0].quantity = 1000
    const alterada = `${Buffer.from(JSON.stringify(leida)).toString('base64url')}.${firma}`

    expect(leerFotoDelPaquete(alterada)).toBeNull()
  })

  it('🔴 una foto vencida no vale: a los 7 días se entrega el vigente', () => {
    const firmada = firmarFotoDelPaquete(pack)!
    const ocho = Date.now() + 8 * 24 * 60 * 60 * 1000
    const reloj = jest.spyOn(Date, 'now').mockReturnValue(ocho)
    try {
      expect(leerFotoDelPaquete(firmada)).toBeNull()
    } finally {
      reloj.mockRestore()
    }
  })

  it('🔴 el token de otro propósito con la misma forma no vale', async () => {
    const { signPlatformUnsubscribeToken } = await import('@/utils/platformUnsubscribeToken')
    expect(leerFotoDelPaquete(signPlatformUnsubscribeToken('a@b.com'))).toBeNull()
  })

  it.each([[undefined], [null], [''], ['basura'], ['a.b'], [123], [{}]])('basura (%p) no vale ni truena', valor => {
    expect(leerFotoDelPaquete(valor)).toBeNull()
  })

  it('un paquete que no se podría entregar no lleva foto, y no rompe la lista', () => {
    expect(firmarFotoDelPaquete({ ...pack, items: [] })).toBeNull()
  })
})
