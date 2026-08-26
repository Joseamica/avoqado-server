/**
 * 🔴 DINERO. Otorgar un sello es lo que el cliente cambia por producto gratis, así
 * que un sello de más es producto regalado y uno de menos es un cliente enojado.
 *
 * Las tres cosas que se prueban aquí y que duelen en producción:
 *
 * 1. **Un pago = exactamente un sello.** Un reintento de cobro no puede sellar dos
 *    veces. La garantía real es el índice único de la base; el código debe TRATAR
 *    su violación como "ya estaba sellado", no como error.
 * 2. **El tope diario se cuenta en el día del NEGOCIO**, no del servidor. En México
 *    con el servidor en UTC, el "día" se cortaría a las 6 de la tarde.
 * 3. **Cada sello lleva su autor.** Es lo que hace vendible esto frente al cartón:
 *    ahí el empleado sella de más a su amiga y nadie se entera.
 */
import { grantStamp } from '../../../../src/services/wallet/stampLedger.service'
import { prismaMock } from '../../../__helpers__/setup'

const VENUE = { id: 'v1', timezone: 'America/Mexico_City' }

const CONFIG_SELLOS = {
  venueId: 'v1',
  stampsEnabled: true,
  stampsRequired: 7,
  maxStampsPerDay: 1,
  stampRewardType: 'FREE_PRODUCT',
  stampRewardValue: null,
  stampRewardProductId: null,
  stampRewardLabel: 'Un café gratis',
  active: true,
}

function mockConfig(over: Record<string, unknown> = {}) {
  prismaMock.venue.findUnique.mockResolvedValue(VENUE as any)
  prismaMock.loyaltyConfig.findUnique.mockResolvedValue({ ...CONFIG_SELLOS, ...over } as any)
}

describe('grantStamp', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.stampEvent.findFirst.mockResolvedValue(null)
    prismaMock.stampEvent.count.mockResolvedValue(0)
    prismaMock.stampCard.findFirst.mockResolvedValue(null)
    prismaMock.stampCard.create.mockResolvedValue({ id: 'sc1', cycle: 1, stampsRequired: 7, stampsEarned: 0 } as any)
    prismaMock.stampEvent.create.mockResolvedValue({ id: 'se1' } as any)
    prismaMock.stampCard.update.mockResolvedValue({ id: 'sc1', stampsEarned: 1, stampsRequired: 7 } as any)
  })

  it('un negocio SIN sellos habilitados no sella nada', async () => {
    mockConfig({ stampsEnabled: false })

    const r = await grantStamp('v1', 'c1', 'o1')

    // No-op silencioso: la mayoría de los negocios usa puntos, no sellos, y
    // sellar de más ahí sería regalar producto que nadie prometió.
    expect(r.granted).toBe(false)
    expect(r.reason).toBe('STAMPS_DISABLED')
    expect(prismaMock.stampEvent.create).not.toHaveBeenCalled()
  })

  it('el primer sello abre la cartilla y la congela con la regla vigente', async () => {
    mockConfig({ stampsRequired: 7 })

    const r = await grantStamp('v1', 'c1', 'o1')

    expect(r.granted).toBe(true)
    // 🔴 stampsRequired se copia A LA CARTILLA. Si el negocio cambia de "al 7" a
    // "al 10" mañana, quien ya juntó 6 sigue necesitando 7.
    expect(prismaMock.stampCard.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ stampsRequired: 7, cycle: 1 }) }),
    )
  })

  it('🔴 el MISMO cobro no sella dos veces', async () => {
    mockConfig()
    prismaMock.stampEvent.findFirst.mockResolvedValue({ id: 'ya', stampCardId: 'sc1' } as any)

    const r = await grantStamp('v1', 'c1', 'o1')

    expect(r.granted).toBe(false)
    expect(r.reason).toBe('ALREADY_STAMPED')
    expect(prismaMock.stampEvent.create).not.toHaveBeenCalled()
  })

  it('🔴 una CARRERA contra el índice único se trata como ya sellado, no como error', async () => {
    mockConfig()
    // Dos cobros simultáneos pasan los dos el chequeo previo; la base rechaza el
    // segundo. Si eso se propaga como error, el cobro se ve fallido aunque el
    // dinero entró — que es peor que no sellar.
    const p2002: any = new Error('Unique constraint failed')
    p2002.code = 'P2002'
    prismaMock.$transaction.mockRejectedValueOnce(p2002)

    const r = await grantStamp('v1', 'c1', 'o1')

    expect(r.granted).toBe(false)
    expect(r.reason).toBe('ALREADY_STAMPED')
  })

  it('🔴 el tope diario se cuenta en el día del NEGOCIO, no del servidor', async () => {
    mockConfig({ maxStampsPerDay: 1 })
    prismaMock.stampEvent.count.mockResolvedValue(1)

    const r = await grantStamp('v1', 'c1', 'o2')

    expect(r.granted).toBe(false)
    expect(r.reason).toBe('DAILY_LIMIT_REACHED')

    // La ventana tiene que venir de la zona del venue. Con el servidor en UTC —
    // como corre producción — un día "de servidor" se corta a las 6 de la tarde
    // en México y el cliente podría sellar dos veces la misma noche.
    const filtro = prismaMock.stampEvent.count.mock.calls[0][0] as any
    expect(filtro.where.createdAt.gte).toBeInstanceOf(Date)
    expect(filtro.where.createdAt.lte).toBeInstanceOf(Date)
    const horas = (filtro.where.createdAt.lte - filtro.where.createdAt.gte) / 3_600_000
    expect(horas).toBeGreaterThan(23)
    expect(horas).toBeLessThan(25)
  })

  it('un tope de 0 significa SIN tope, no "no sellar nunca"', async () => {
    mockConfig({ maxStampsPerDay: 0 })
    prismaMock.stampEvent.count.mockResolvedValue(99)

    const r = await grantStamp('v1', 'c1', 'o3')

    // Un negocio que pone 0 quiere decir "sin límite". Interpretarlo como
    // "cero sellos al día" apagaría el programa entero sin avisar.
    expect(r.granted).toBe(true)
  })

  it('🔴 registra QUIÉN puso el sello y en qué terminal', async () => {
    mockConfig()

    await grantStamp('v1', 'c1', 'o1', { staffVenueId: 'sv9', terminalId: 't3' })

    expect(prismaMock.stampEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ createdById: 'sv9', terminalId: 't3', type: 'EARN', venueId: 'v1', orderId: 'o1' }),
      }),
    )
  })

  it('reusa la cartilla en curso en vez de abrir una nueva cada vez', async () => {
    mockConfig()
    prismaMock.stampCard.findFirst.mockResolvedValue({ id: 'sc7', cycle: 3, stampsRequired: 7, stampsEarned: 2 } as any)
    // El incremento lo hace la base; el mock devuelve el estado YA actualizado.
    prismaMock.stampCard.update.mockResolvedValue({ stampsEarned: 3, stampsRequired: 7 } as any)

    const r = await grantStamp('v1', 'c1', 'o1')

    // Abrir una cartilla por cada compra dejaría al cliente eternamente en 1 de 7.
    expect(prismaMock.stampCard.create).not.toHaveBeenCalled()
    expect(prismaMock.stampCard.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'sc7' } }))
    expect(r.stampsEarned).toBe(3)
    expect(r.completed).toBe(false)
  })

  it('🔴 al completarse nace el premio Y arranca la cartilla siguiente', async () => {
    mockConfig({ stampsRequired: 7, stampRewardLabel: 'Un café gratis', stampRewardType: 'FREE_PRODUCT' })
    prismaMock.stampCard.findFirst.mockResolvedValue({ id: 'sc7', cycle: 1, stampsRequired: 7, stampsEarned: 6 } as any)
    prismaMock.stampCard.update.mockResolvedValue({ stampsEarned: 7, stampsRequired: 7 } as any)
    prismaMock.stampReward.create.mockResolvedValue({ id: 'rw1' } as any)

    const r = await grantStamp('v1', 'c1', 'o1')

    expect(r.completed).toBe(true)
    expect(r.rewardId).toBe('rw1')

    // 🔴 El premio congela sus condiciones. Si el negocio cambia mañana "un café"
    // por "10% de descuento", quien ya lo ganó recibe lo que se le prometió.
    expect(prismaMock.stampReward.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          stampCardId: 'sc7',
          status: 'PENDING',
          rewardType: 'FREE_PRODUCT',
          rewardLabel: 'Un café gratis',
        }),
      }),
    )

    // 🔴 Y la siguiente cartilla arranca YA, no al canjear. Entre que se llena y
    // el cliente vuelve pueden pasar semanas: todo lo que compre mientras tanto
    // se tiraría a la basura. Es el hallazgo C7 de la auditoría.
    expect(prismaMock.stampCard.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ cycle: 2, stampsRequired: 7 }) }),
    )
  })

  it('la cartilla siguiente nace con la regla NUEVA, no con la vieja', async () => {
    // Al revés que la congelada: el ciclo que empieza usa la config de hoy.
    mockConfig({ stampsRequired: 10 })
    prismaMock.stampCard.findFirst.mockResolvedValue({ id: 'sc7', cycle: 4, stampsRequired: 7, stampsEarned: 6 } as any)
    prismaMock.stampCard.update.mockResolvedValue({ stampsEarned: 7, stampsRequired: 7 } as any)
    prismaMock.stampReward.create.mockResolvedValue({ id: 'rw1' } as any)

    await grantStamp('v1', 'c1', 'o1')

    expect(prismaMock.stampCard.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ cycle: 5, stampsRequired: 10 }) }),
    )
  })

  it('un sello que NO completa no crea premio ni cartilla nueva', async () => {
    mockConfig()
    prismaMock.stampCard.findFirst.mockResolvedValue({ id: 'sc7', cycle: 1, stampsRequired: 7, stampsEarned: 2 } as any)
    prismaMock.stampCard.update.mockResolvedValue({ stampsEarned: 3, stampsRequired: 7 } as any)

    await grantStamp('v1', 'c1', 'o1')

    expect(prismaMock.stampReward.create).not.toHaveBeenCalled()
    expect(prismaMock.stampCard.create).not.toHaveBeenCalled()
  })

  it('🔴 el último sello marca la cartilla como completa', async () => {
    mockConfig()
    prismaMock.stampCard.findFirst.mockResolvedValue({ id: 'sc7', cycle: 1, stampsRequired: 7, stampsEarned: 6 } as any)
    prismaMock.stampCard.update.mockResolvedValue({ stampsEarned: 7, stampsRequired: 7 } as any)

    const r = await grantStamp('v1', 'c1', 'o1')

    // Es la señal que dispara el premio (Tarea 3). Sin ella el cliente junta los
    // siete sellos y no pasa nada.
    expect(r.completed).toBe(true)
  })
})
