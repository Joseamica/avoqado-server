/**
 * Lo que la pagina publica de la tarjeta necesita saber ANTES de que el cliente se
 * identifique: como se llama el negocio y si de verdad tiene sellos.
 *
 * 🔴 Existe por un defecto real (27-ago): el cartel del mostrador apuntaba al widget
 * de reservas, y ese se cierra entero cuando el negocio no tiene reservaciones
 * publicas — 69 de 73 negocios activos. Testarudo, un café, respondia en produccion
 * "Las reservaciones en linea estan deshabilitadas" al escanear su propio cartel. Una
 * tarjeta de sellos no puede depender de si el negocio acepta citas.
 */
import { getPublicCardInfo } from '@/services/wallet/publicCardInfo.service'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = {
  id: 'v1',
  name: 'Testarudo Cafe',
  slug: 'testarudo-cafe',
  logo: 'https://cdn/logo.jpg',
  primaryColor: '#6D4C41',
}

describe('getPublicCardInfo', () => {
  beforeEach(() => jest.clearAllMocks())

  it('devuelve la marca del negocio SIN preguntar por reservaciones', async () => {
    prismaMock.venue.findFirst.mockResolvedValue(VENUE as any)
    prismaMock.loyaltyConfig.findUnique.mockResolvedValue({
      stampsEnabled: true,
      stampsRequired: 7,
      stampRewardLabel: 'Un café gratis',
    } as any)

    const r = await getPublicCardInfo('testarudo-cafe')
    expect(r).toEqual({
      venue: { name: 'Testarudo Cafe', slug: 'testarudo-cafe', logo: 'https://cdn/logo.jpg', primaryColor: '#6D4C41' },
      stampsEnabled: true,
      stampsRequired: 7,
      rewardLabel: 'Un café gratis',
    })
    // 🔴 La prueba que da sentido a todo el archivo: si alguien "reusa" el camino de
    // reservas, esta llamada aparece y el café vuelve a quedar fuera.
    expect(prismaMock.reservationSettings.findUnique).not.toHaveBeenCalled()
  })

  it('dice stampsEnabled:false cuando el negocio no usa sellos', async () => {
    prismaMock.venue.findFirst.mockResolvedValue(VENUE as any)
    prismaMock.loyaltyConfig.findUnique.mockResolvedValue({ stampsEnabled: false } as any)
    const r = await getPublicCardInfo('testarudo-cafe')
    expect(r?.stampsEnabled).toBe(false)
  })

  it('tambien cuando no hay configuracion de lealtad', async () => {
    prismaMock.venue.findFirst.mockResolvedValue(VENUE as any)
    prismaMock.loyaltyConfig.findUnique.mockResolvedValue(null)
    const r = await getPublicCardInfo('testarudo-cafe')
    expect(r?.stampsEnabled).toBe(false)
    expect(r?.rewardLabel).toBe('')
  })

  it('devuelve null si el negocio no existe o esta inactivo', async () => {
    prismaMock.venue.findFirst.mockResolvedValue(null)
    expect(await getPublicCardInfo('no-existe')).toBeNull()
  })

  it('NO expone nada del negocio mas alla de su marca', async () => {
    // Es un endpoint sin sesion: cualquiera con el slug lo puede pedir. Solo debe
    // salir lo que ya va impreso en el cartel de la entrada.
    prismaMock.venue.findFirst.mockResolvedValue(VENUE as any)
    prismaMock.loyaltyConfig.findUnique.mockResolvedValue({ stampsEnabled: true, stampsRequired: 7, stampRewardLabel: 'x' } as any)
    const r: any = await getPublicCardInfo('testarudo-cafe')
    expect(Object.keys(r.venue).sort()).toEqual(['logo', 'name', 'primaryColor', 'slug'])
    expect(r.venue).not.toHaveProperty('id')
  })
})
