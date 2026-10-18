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
import { Prisma } from '@prisma/client'
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
    prismaMock.loyaltyTransaction.findFirst.mockResolvedValue(null)
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
    // La forma REAL de este índice parcial (crudo, sin nombre en el esquema): la lista de columnas, como en turnoDeCaja.ts.
    const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { modelName: 'StampEvent', target: ['venueId', 'orderId'] },
    })
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

  // ── Auditoría A #3 (14-oct): carrera entre dos ventas DISTINTAS del mismo cliente ────────────────────────────
  it('🔴 el candado (negocio, cliente) es la PRIMERA sentencia de la transacción; el tope y la cartilla van detrás', async () => {
    mockConfig({ maxStampsPerDay: 1 })
    const orden: string[] = []
    prismaMock.$transaction.mockImplementationOnce((async (cb: any) => {
      orden.push('BEGIN')
      return cb(prismaMock)
    }) as never)
    prismaMock.$executeRaw
      .mockImplementationOnce((async () => {
        orden.push('candado')
        return 0
      }) as never)
      .mockImplementationOnce((async () => {
        orden.push('candado de la venta')
        return 0
      }) as never)
    // F2: el atajo de AFUERA (antes de BEGIN) no cuenta; dentro del candado la primera lectura es el sello de ESTA orden.
    prismaMock.stampEvent.findFirst.mockImplementation((async () => {
      if (orden.includes('BEGIN')) orden.push('propio')
      return null
    }) as never)
    // H4, tercera ola: y luego, si OTRO cliente ya recibió los puntos de esta venta.
    prismaMock.loyaltyTransaction.findFirst.mockImplementation((async () => {
      orden.push('puntos de otro')
      return null
    }) as never)
    prismaMock.stampEvent.count.mockImplementationOnce((async () => {
      orden.push('tope')
      return 0
    }) as never)
    prismaMock.stampCard.findFirst.mockImplementationOnce((async () => {
      orden.push('cartilla')
      return { id: 'sc7', cycle: 1, stampsRequired: 7, stampsEarned: 2 }
    }) as never)
    prismaMock.stampEvent.create.mockImplementationOnce((async () => {
      orden.push('sello')
      return { id: 'se1' }
    }) as never)
    prismaMock.stampCard.update.mockResolvedValue({ stampsEarned: 3, stampsRequired: 7 } as any)

    const r = await grantStamp('v1', 'c1', 'o1')

    expect(r.granted).toBe(true)
    expect(orden).toEqual(['BEGIN', 'candado', 'candado de la venta', 'propio', 'puntos de otro', 'tope', 'cartilla', 'sello'])
    const [plantilla, ...valores] = prismaMock.$executeRaw.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]]
    expect(plantilla.join('?')).toContain('pg_advisory_xact_lock(hashtext(?), hashtext(?))')
    expect(valores).toEqual(['v1', 'c1'])
    // H4, tercera ola: el SEGUNDO candado es el de la VENTA, el mismo que toma la escritura de los puntos.
    const [plantilla2, ...valores2] = prismaMock.$executeRaw.mock.calls[1] as unknown as [TemplateStringsArray, ...unknown[]]
    expect(plantilla2.join('?')).toContain('pg_advisory_xact_lock(hashtext(?), hashtext(?))')
    expect(valores2).toEqual(['v1', 'o1'])
  })

  it('cuarta ola: la transacción del sello lleva el MISMO presupuesto explícito que la de los puntos (también espera el candado de la venta)', async () => {
    mockConfig()
    await grantStamp('v1', 'c1', 'o1')
    expect(prismaMock.$transaction).toHaveBeenCalledWith(expect.any(Function), { maxWait: 10_000, timeout: 15_000 })
  })

  it('🔴 H4 (tercera ola): OTRO cliente ya recibió los PUNTOS de esta venta ⇒ OTHER_CUSTOMER, sin sello', async () => {
    mockConfig()
    prismaMock.loyaltyTransaction.findFirst.mockResolvedValue({ customerId: 'ana' } as any)
    const r = await grantStamp('v1', 'c1', 'o1')
    expect(r).toEqual({ granted: false, reason: 'OTHER_CUSTOMER' })
    expect(prismaMock.stampEvent.create).not.toHaveBeenCalled()
    expect(prismaMock.loyaltyTransaction.findFirst).toHaveBeenCalledWith({
      where: { orderId: 'o1', type: 'EARN', customerId: { not: 'c1' }, customer: { venueId: 'v1' } },
      select: { customerId: true },
    })
  })

  // ── F2 (S3b minor #2, rulings del código 15-oct): la MISMA orden dos veces a la vez ──────────────────────────────────────
  it('🔴 F2: el sello de ESTA orden aparece DENTRO del candado (la otra llamada lo hizo mientras ésta esperaba): ALREADY_STAMPED, no un DAILY_LIMIT engañoso', async () => {
    mockConfig({ maxStampsPerDay: 1 })
    // Afuera no había sello (la otra aún no hacía commit); al entrar al candado, ya está. Y el tope del día ya está lleno
    // por ESE mismo sello: sin la relectura, la respuesta diría «ya recibió su sello de hoy», que es falso para esta venta.
    // Con un contador y no con «Once»: si la relectura faltara, un valor «Once» sobrante se colaría en la prueba siguiente.
    let lecturas = 0
    prismaMock.stampEvent.findFirst.mockImplementation((async () => (++lecturas === 1 ? null : { id: 'ya', stampCardId: 'sc9' })) as never)
    prismaMock.stampEvent.count.mockResolvedValue(1)

    const r = await grantStamp('v1', 'c1', 'o1')

    expect(r).toEqual({ granted: false, reason: 'ALREADY_STAMPED', stampCardId: 'sc9' })
    expect(prismaMock.stampEvent.count).not.toHaveBeenCalled()
    expect(prismaMock.stampEvent.create).not.toHaveBeenCalled()
    expect(prismaMock.stampCard.create).not.toHaveBeenCalled()
    // La relectura es DENTRO del candado y busca el EARN de esta orden en este negocio.
    expect(prismaMock.stampEvent.findFirst).toHaveBeenNthCalledWith(2, {
      where: { venueId: 'v1', orderId: 'o1', type: 'EARN' },
      select: { id: true, stampCardId: true },
    })
  })

  it('el tope alcanzado DENTRO del candado: DAILY_LIMIT_REACHED, sin sello ni cartilla nueva', async () => {
    mockConfig({ maxStampsPerDay: 1 })
    prismaMock.stampEvent.count.mockResolvedValue(1)
    const r = await grantStamp('v1', 'c1', 'o2')
    expect(r).toEqual({ granted: false, reason: 'DAILY_LIMIT_REACHED' })
    expect(prismaMock.stampEvent.create).not.toHaveBeenCalled()
    expect(prismaMock.stampCard.create).not.toHaveBeenCalled()
  })

  it('el P2002 del índice del sello, reportado por NOMBRE, también es ya sellado', async () => {
    mockConfig()
    prismaMock.$transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: 'StampEvent_venueId_orderId_earn_unique' },
      }),
    )
    expect(await grantStamp('v1', 'c1', 'o1')).toEqual({ granted: false, reason: 'ALREADY_STAMPED' })
  })

  it.each<[string, Record<string, unknown> | undefined]>([
    ['🔴 el premio (dos ventas completando la misma cartilla)', { modelName: 'StampReward', target: ['stampCardId'] }],
    ['🔴 la cartilla siguiente', { modelName: 'StampCard', target: ['customerId', 'venueId', 'cycle'] }],
    ['un P2002 sin descriptor (no se adivina)', undefined],
  ])('un P2002 de OTRO único (%s) NO es «ya sellado»: se relanza y el reconciliador reintenta', async (_n, meta) => {
    mockConfig()
    const otro = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test', meta })
    prismaMock.$transaction.mockRejectedValueOnce(otro)
    await expect(grantStamp('v1', 'c1', 'o1')).rejects.toBe(otro)
  })
})
