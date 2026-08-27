/**
 * Escanear el QR de la tarjeta de un cliente desde la terminal.
 *
 * 🔴 El código del QR lo puede leer CUALQUIERA que vea la pantalla del cliente: la
 * mesa de al lado, alguien en la fila, una foto. Por eso este camino tiene dos
 * candados que no se pueden relajar — sólo lo llama personal autenticado del negocio,
 * y sólo resuelve tarjetas de ESE negocio.
 *
 * Y una regla de privacidad: devuelve el NOMBRE del cliente y nada más. El cajero
 * necesita saber a quién le está cobrando, no su teléfono ni su correo.
 */
import { scanWalletPass } from '../../../../src/services/wallet/scanWalletPass.service'
import { prismaMock } from '../../../__helpers__/setup'

const PASE = { id: 'wp1', venueId: 'v1', customerId: 'c1', qrToken: 'tok-qr', active: true }
const CLIENTE = { id: 'c1', firstName: 'Ana', lastName: 'Ruiz', phone: '5551234567', email: 'ana@correo.com' }

describe('scanWalletPass', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.walletPass.findFirst.mockResolvedValue(PASE as any)
    prismaMock.customer.findFirst.mockResolvedValue(CLIENTE as any)
    prismaMock.loyaltyConfig.findUnique.mockResolvedValue({ stampsRequired: 7, stampRewardLabel: 'Un café gratis' } as any)
    prismaMock.stampCard.findFirst.mockResolvedValue({ stampsEarned: 3, stampsRequired: 7 } as any)
    prismaMock.stampReward.count.mockResolvedValue(0)
    prismaMock.stampReward.findMany.mockResolvedValue([] as any)
  })

  it('resuelve el QR al cliente y su avance', async () => {
    const r = await scanWalletPass('v1', 'tok-qr')

    expect(r.customer?.firstName).toBe('Ana')
    expect(r.stampsEarned).toBe(3)
    expect(r.stampsRequired).toBe(7)
  })

  it('🔴 devuelve el NOMBRE y nada más', async () => {
    // El cajero necesita saber a quién le cobra. No su teléfono ni su correo: eso es
    // dato personal que no hace falta para cobrar, y la pantalla de una terminal la
    // ve cualquiera que esté en el mostrador.
    const r = await scanWalletPass('v1', 'tok-qr')

    // El mock de Prisma NO respeta el `select`: devuelve la fila entera. Eso lo hace
    // el escenario perfecto para esta prueba — comprueba que el CÓDIGO filtra, no
    // sólo la consulta.
    expect(r.customer).toEqual({ id: 'c1', firstName: 'Ana', lastName: 'Ruiz' })
    expect(JSON.stringify(r)).not.toContain('5551234567')
    expect(JSON.stringify(r)).not.toContain('ana@correo.com')

    // Y que la consulta tampoco los pida: es el primer candado de los dos.
    const consulta = prismaMock.customer.findFirst.mock.calls[0][0] as any
    expect(consulta.select).toEqual({ id: true, firstName: true, lastName: true })
  })

  it('🔴 avisa cuando el cliente tiene un premio sin cobrar', async () => {
    // Es la razón de ser de esto: sin el aviso, el cajero tendría que acordarse de
    // preguntar "¿tienes premio?" en cada venta — que en la práctica no pasa, y el
    // cliente se va sin cobrar lo que ya se ganó.
    prismaMock.stampReward.findMany.mockResolvedValue([{ id: 'rw1', rewardLabel: 'Un café gratis' }] as any)

    const r = await scanWalletPass('v1', 'tok-qr')

    expect(r.rewardsToClaim).toEqual([{ id: 'rw1', rewardLabel: 'Un café gratis' }])
  })

  it('🔴 una tarjeta de OTRO negocio no se resuelve', async () => {
    // Sin este filtro, el QR de un cliente de otra sucursal identificaría a alguien
    // que no es cliente de aquí, y le sellaría una cartilla ajena.
    prismaMock.walletPass.findFirst.mockResolvedValue(null)

    const r = await scanWalletPass('v1', 'tok-de-otro-venue')

    expect(r.found).toBe(false)
    expect(r.customer).toBeUndefined()
  })

  it('un código inventado no revienta: simplemente no encuentra nada', async () => {
    prismaMock.walletPass.findFirst.mockResolvedValue(null)

    const r = await scanWalletPass('v1', 'basura-escaneada')

    expect(r.found).toBe(false)
  })

  it('un cliente sin cartilla todavía sale en ceros, no falla', async () => {
    prismaMock.stampCard.findFirst.mockResolvedValue(null)

    const r = await scanWalletPass('v1', 'tok-qr')

    expect(r.found).toBe(true)
    expect(r.stampsEarned).toBe(0)
  })

  it('🔴 un cliente SIN nombre no rompe la pantalla del cajero', async () => {
    // Pasa de verdad: un cliente creado desde un cobro rápido puede no tener nombre.
    // Si esto reventara o devolviera "undefined undefined", el cajero vería basura
    // justo cuando tiene a la persona enfrente.
    prismaMock.customer.findFirst.mockResolvedValue({ id: 'c1', firstName: null, lastName: null } as any)

    const r = await scanWalletPass('v1', 'tok-qr')

    expect(r.found).toBe(true)
    expect(r.customer).toEqual({ id: 'c1', firstName: null, lastName: null })
  })
})
