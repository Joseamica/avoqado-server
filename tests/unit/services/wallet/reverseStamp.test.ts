jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }))

/**
 * 🔴 DINERO. Si la venta que otorgó un sello se reembolsa, el sello sobra: el cliente
 * avanza en su cartilla por algo que devolvió, y termina cobrando un premio que no se
 * ganó. Con un café son centavos; con siete clientes haciéndolo, es una cartilla
 * completa regalada cada semana.
 */
import { Prisma } from '@prisma/client'
import { reverseStampForOrder } from '../../../../src/services/wallet/stampLedger.service'
import { prismaMock } from '../../../__helpers__/setup'
import { logAction } from '@/services/dashboard/activity-log.service'

/** Cartillas del cliente para la regla de D3: `findFirst` filtra por nivel como la base (con sello, abierta/llena, premio). */
type Cartilla = { id: string; cycle: number; stampsEarned: number; llena: boolean; premio?: 'PENDING' | 'REDEEMED' }
function cartillas(lista: Cartilla[]) {
  prismaMock.stampCard.findFirst.mockImplementation((async (args: any) => {
    const w = args?.where ?? {}
    const ok = lista
      .filter(
        c =>
          (w.id === undefined || c.id === w.id) &&
          (w.stampsEarned?.gte === undefined || c.stampsEarned >= w.stampsEarned.gte) &&
          (w.completedAt === undefined || (w.completedAt === null ? !c.llena : c.llena)) &&
          (w.rewards?.some === undefined || c.premio === 'PENDING') &&
          (w.rewards?.none === undefined || c.premio !== 'PENDING'),
      )
      .sort((a, b) => b.cycle - a.cycle)
    return ok[0] ? { id: ok[0].id } : null
  }) as never)
  // La relectura bajo el candado de FILA de la cartilla elegida (y la cartilla de la venta) salen de la misma lista.
  prismaMock.stampCard.findUnique.mockImplementation((async (args: any) => {
    const c = lista.find(x => x.id === args?.where?.id)
    if (!c) return null
    return {
      id: c.id,
      venueId: 'v1',
      customerId: 'c1',
      cycle: c.cycle,
      stampsEarned: c.stampsEarned,
      completedAt: c.llena ? new Date('2026-08-20T18:00:00.000Z') : null,
      rewards: c.premio ? [{ status: c.premio }] : [],
    }
  }) as never)
}

describe('reverseStampForOrder', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // Sin colas «Once» sobrantes (un rechazo P2028 de una prueba no puede caer en la siguiente).
    prismaMock.$transaction.mockReset()
    prismaMock.$transaction.mockImplementation(((cb: any) => cb(prismaMock)) as never)
    prismaMock.stampEvent.findFirst.mockResolvedValue({ id: 'se1', stampCardId: 'sc1', quantity: 1 } as any)
    prismaMock.stampEvent.count.mockResolvedValue(0)
    prismaMock.stampEvent.create.mockResolvedValue({ id: 'se2' } as any)
    prismaMock.stampCard.update.mockResolvedValue({} as any)
    prismaMock.stampCard.findUnique.mockResolvedValue({
      id: 'sc1',
      venueId: 'v1',
      customerId: 'c1',
      cycle: 1,
      stampsEarned: 6,
      stampsRequired: 7,
      completedAt: null,
    } as any)
    // D3: por defecto, sólo la cartilla de la venta, abierta y con el sello.
    cartillas([{ id: 'sc1', cycle: 1, stampsEarned: 6, llena: false }])
    prismaMock.stampReward.updateMany.mockResolvedValue({ count: 0 } as any)
  })

  it('🔴 revierte el sello SIN borrar el original', async () => {
    const r = await reverseStampForOrder('v1', 'o1')

    expect(r.reversed).toBe(true)
    // 🔴 Es un LIBRO, no un contador: el sello otorgado se queda y nace un asiento
    // contrario. Borrar el original haría desaparecer el rastro de que ese cliente
    // sí compró, y el día que alguien reclame no habría con qué reconstruirlo.
    expect(prismaMock.stampEvent.delete).not.toHaveBeenCalled()
    expect(prismaMock.stampEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: 'REVERSAL', quantity: -1, stampCardId: 'sc1' }) }),
    )
  })

  it('🔴 baja el contador de la cartilla', async () => {
    // Sin esto el asiento existe pero el cliente sigue viendo su avance inflado, que
    // es la única cifra que él mira.
    await reverseStampForOrder('v1', 'o1')

    expect(prismaMock.stampCard.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'sc1' }, data: expect.objectContaining({ stampsEarned: { decrement: 1 } }) }),
    )
  })

  it('🔴 si el sello completó la cartilla, la reabre y cancela el premio pendiente', async () => {
    prismaMock.stampCard.findUnique.mockResolvedValue({
      id: 'sc1',
      venueId: 'v1',
      customerId: 'c1',
      cycle: 1,
      stampsEarned: 7,
      stampsRequired: 7,
      completedAt: new Date('2026-08-20T18:00:00.000Z'),
    } as any)
    cartillas([{ id: 'sc1', cycle: 1, stampsEarned: 7, llena: true, premio: 'PENDING' }])
    prismaMock.stampReward.updateMany.mockResolvedValue({ count: 1 } as any)

    await reverseStampForOrder('v1', 'o1')

    expect(prismaMock.stampCard.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'sc1' },
        data: expect.objectContaining({ stampsEarned: { decrement: 1 }, completedAt: null }),
      }),
    )
    expect(prismaMock.stampReward.updateMany).toHaveBeenCalledWith({
      where: { stampCardId: 'sc1', status: 'PENDING' },
      data: { status: 'CANCELLED' },
    })
  })

  // D2 (21-oct, Codex r1 de D1): la cartilla siguiente «en 0» puede tener historia (un sello que otra devolución descontó).
  // Borrarla se llevaba en cascada sus sellos y reversas: la misma venta podía revertirse otra vez. Ya no se borra ninguna.
  it('🔴 D2: reabre la cartilla llena SIN borrar la siguiente, aunque esté en 0 (puede tener sellos y reversas reales)', async () => {
    prismaMock.stampCard.findUnique.mockResolvedValue({
      id: 'sc1',
      venueId: 'v1',
      customerId: 'c1',
      cycle: 1,
      stampsEarned: 7,
      stampsRequired: 7,
      completedAt: new Date('2026-08-20T18:00:00.000Z'),
    } as any)
    cartillas([{ id: 'sc1', cycle: 1, stampsEarned: 7, llena: true, premio: 'PENDING' }])
    prismaMock.stampReward.updateMany.mockResolvedValue({ count: 1 } as any)

    await reverseStampForOrder('v1', 'o1')

    expect(prismaMock.stampCard.delete).not.toHaveBeenCalled()
    expect(prismaMock.stampCard.deleteMany).not.toHaveBeenCalled()
  })

  // D3 (21-oct, founder: «A, como Square»): la cartilla ABIERTA de la venta ya está en 0 (otra devolución consumió su sello).
  // Antes quedaba en −1 y la cartilla llena anterior conservaba su premio sin sellos que lo respaldaran. Ahora el sello sale
  // de la cartilla LLENA más reciente: si su premio no se ha cobrado, se cancela y se reabre. Nunca hay negativos.
  it('🔴 D3: la cartilla de la venta ya no alcanza: el sello sale de la LLENA más reciente, cuyo premio sin cobrar se cancela', async () => {
    prismaMock.stampEvent.findFirst.mockResolvedValue({ id: 'se3', stampCardId: 'sc2', quantity: 1 } as any)
    prismaMock.stampCard.findUnique.mockResolvedValue({
      id: 'sc2',
      venueId: 'v1',
      customerId: 'c1',
      cycle: 2,
      stampsEarned: 0,
      completedAt: null,
    } as any)
    // sc2 (la de la venta) está en 0: no tiene el sello. Sólo la 1, llena con premio sin cobrar.
    cartillas([
      { id: 'sc2', cycle: 2, stampsEarned: 0, llena: false },
      { id: 'sc1', cycle: 1, stampsEarned: 2, llena: true, premio: 'PENDING' },
    ])
    prismaMock.stampReward.updateMany.mockResolvedValue({ count: 1 } as any)

    expect(await reverseStampForOrder('v1', 'o3')).toMatchObject({ reversed: true })

    expect((prismaMock.stampCard.findFirst as jest.Mock).mock.calls[0][0]).toMatchObject({
      where: { venueId: 'v1', customerId: 'c1', stampsEarned: { gte: 1 } },
    })
    expect(prismaMock.stampReward.updateMany).toHaveBeenCalledWith({
      where: { stampCardId: 'sc1', status: 'PENDING' },
      data: { status: 'CANCELLED' },
    })
    expect(prismaMock.stampEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: 'REVERSAL', stampCardId: 'sc1' }) }),
    )
    expect(prismaMock.stampCard.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'sc1' },
        data: expect.objectContaining({ stampsEarned: { decrement: 1 }, completedAt: null }),
      }),
    )
    expect(prismaMock.stampCard.update).not.toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'sc2' } }))
  })

  it('🔴 D3: si el premio de la llena YA se cobró, no se le quita: la llena pierde el sello y sigue llena (nunca hay negativos)', async () => {
    prismaMock.stampEvent.findFirst.mockResolvedValue({ id: 'se3', stampCardId: 'sc2', quantity: 1 } as any)
    prismaMock.stampCard.findUnique.mockResolvedValue({
      id: 'sc2',
      venueId: 'v1',
      customerId: 'c1',
      cycle: 2,
      stampsEarned: 0,
      completedAt: null,
    } as any)
    cartillas([
      { id: 'sc2', cycle: 2, stampsEarned: 0, llena: false },
      { id: 'sc1', cycle: 1, stampsEarned: 2, llena: true, premio: 'REDEEMED' },
    ])

    await reverseStampForOrder('v1', 'o3')

    expect(prismaMock.stampReward.updateMany).not.toHaveBeenCalled() // lo ya cobrado no se toca

    const actualizacion = (prismaMock.stampCard.update as jest.Mock).mock.calls[0][0]
    expect(actualizacion.where).toEqual({ id: 'sc1' })
    expect(actualizacion.data).toEqual({ stampsEarned: { decrement: 1 } }) // sin reabrir
  })

  it('🔴 D3: el orden de la regla — abierta antes que premio sin cobrar, y éste antes que premio cobrado', async () => {
    cartillas([
      { id: 'sc1', cycle: 1, stampsEarned: 0, llena: false }, // la de la venta, ya sin el sello
      { id: 'sc3', cycle: 3, stampsEarned: 2, llena: true, premio: 'REDEEMED' },
      { id: 'sc2', cycle: 2, stampsEarned: 2, llena: true, premio: 'PENDING' },
      { id: 'sc4', cycle: 4, stampsEarned: 1, llena: false },
    ])
    await reverseStampForOrder('v1', 'o1')
    expect(prismaMock.stampCard.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'sc4' } }))
    expect(prismaMock.stampReward.updateMany).not.toHaveBeenCalled()

    jest.clearAllMocks()
    prismaMock.$transaction.mockImplementation(((cb: any) => cb(prismaMock)) as never)
    prismaMock.stampEvent.count.mockResolvedValue(0)
    prismaMock.stampReward.updateMany.mockResolvedValue({ count: 1 } as any)
    cartillas([
      { id: 'sc1', cycle: 1, stampsEarned: 0, llena: false },
      { id: 'sc3', cycle: 3, stampsEarned: 2, llena: true, premio: 'REDEEMED' },
      { id: 'sc2', cycle: 2, stampsEarned: 2, llena: true, premio: 'PENDING' },
    ])
    await reverseStampForOrder('v1', 'o1')
    expect(prismaMock.stampReward.updateMany).toHaveBeenCalledWith({
      where: { stampCardId: 'sc2', status: 'PENDING' },
      data: { status: 'CANCELLED' },
    })
    expect(prismaMock.stampCard.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'sc2' }, data: expect.objectContaining({ completedAt: null }) }),
    )
  })

  it('🔴 D3 (Codex D3-r2 #1 / r3 / r4): bajo la FILA del premio se vuelve a mirar — si en medio volvió a PENDING, se cancela', async () => {
    // Al elegir, la llena tenía su premio cobrado (nivel 3)…
    cartillas([
      { id: 'sc2', cycle: 2, stampsEarned: 0, llena: false },
      { id: 'sc1', cycle: 1, stampsEarned: 2, llena: true, premio: 'REDEEMED' },
    ])
    prismaMock.stampEvent.findFirst.mockResolvedValue({ id: 'se3', stampCardId: 'sc2', quantity: 1 } as any)
    // …pero alguien quitó el canje de su cuenta mientras tanto: con la fila bloqueada, el premio ya está PENDING.
    const elegir = prismaMock.stampCard.findUnique.getMockImplementation()!
    prismaMock.stampCard.findUnique.mockImplementation((async (args: any) =>
      args?.where?.id === 'sc1' && args?.select?.rewards
        ? { completedAt: new Date('2026-08-20T18:00:00.000Z'), rewards: [{ status: 'PENDING' }] }
        : elegir(args)) as never)
    prismaMock.stampReward.updateMany.mockResolvedValue({ count: 1 } as any)

    await reverseStampForOrder('v1', 'o3')

    expect(
      (prismaMock.$queryRaw as jest.Mock).mock.calls.some(c =>
        /FROM "StampReward" WHERE "stampCardId" = \? FOR UPDATE/.test(c[0].join('?')),
      ),
    ).toBe(true)
    // Y la fila del premio se pide DESPUÉS del asiento y ANTES de restarle a la cartilla.
    const orden = (fn: any) => (fn as jest.Mock).mock.invocationCallOrder[0]
    expect(orden(prismaMock.stampEvent.create)).toBeLessThan(orden(prismaMock.$queryRaw))
    expect(orden(prismaMock.$queryRaw)).toBeLessThan(orden(prismaMock.stampCard.update))
    expect(prismaMock.stampReward.updateMany).toHaveBeenCalledWith({
      where: { stampCardId: 'sc1', status: 'PENDING' },
      data: { status: 'CANCELLED' },
    })
    expect(prismaMock.stampCard.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'sc1' }, data: expect.objectContaining({ completedAt: null }) }),
    )
  })

  it('🔴 D3 (Codex D3-r5 #1): la cartilla cambia de nivel entre consultas (quitaron el canje): no se la salta, la relectura decide', async () => {
    prismaMock.stampEvent.findFirst.mockResolvedValue({ id: 'se1', stampCardId: 'sc1', quantity: 1 } as any)
    cartillas([{ id: 'sc1', cycle: 1, stampsEarned: 2, llena: true, premio: 'REDEEMED' }])
    const filtrar = prismaMock.stampCard.findFirst.getMockImplementation()!
    // Mientras busca por niveles, el premio pasa de cobrado a por cobrar: ninguna de las 3 primeras consultas la ve.
    prismaMock.stampCard.findFirst.mockImplementation((async (args: any) =>
      args?.where?.rewards || args?.where?.completedAt !== undefined ? null : filtrar(args)) as never)
    const leer = prismaMock.stampCard.findUnique.getMockImplementation()!
    prismaMock.stampCard.findUnique.mockImplementation((async (args: any) =>
      args?.select?.rewards
        ? { completedAt: new Date('2026-08-20T18:00:00.000Z'), rewards: [{ status: 'PENDING' }] }
        : leer(args)) as never)
    prismaMock.stampReward.updateMany.mockResolvedValue({ count: 1 } as any)

    await reverseStampForOrder('v1', 'o1')

    expect(prismaMock.stampReward.updateMany).toHaveBeenCalledWith({
      where: { stampCardId: 'sc1', status: 'PENDING' },
      data: { status: 'CANCELLED' },
    })
    expect(prismaMock.stampCard.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'sc1' }, data: { stampsEarned: { decrement: 1 }, completedAt: null } }),
    )
  })

  it('🔴 D3 (Codex D3-r2 #2): una abierta VIEJA con sello gana aunque haya cientos de llenas más nuevas (nada de listas con tope)', async () => {
    cartillas([
      { id: 'sc1', cycle: 1, stampsEarned: 1, llena: false },
      ...Array.from({ length: 300 }, (_, i) => ({
        id: `sc${i + 2}`,
        cycle: i + 2,
        stampsEarned: 2,
        llena: true,
        premio: 'PENDING' as const,
      })),
    ])
    await reverseStampForOrder('v1', 'o1')
    expect(prismaMock.stampCard.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'sc1' } }))
    expect(prismaMock.stampReward.updateMany).not.toHaveBeenCalled()
  })

  it('🔴 D3: ninguna cartilla tiene el sello (datos viejos): queda el asiento pero no resta nada, nunca negativos', async () => {
    cartillas([{ id: 'sc1', cycle: 1, stampsEarned: 0, llena: false }]) // la de la venta, ya sin el sello
    expect(await reverseStampForOrder('v1', 'o1')).toMatchObject({ reversed: true })
    expect(prismaMock.stampEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: 'REVERSAL' }) }),
    )
    expect(prismaMock.stampCard.update).not.toHaveBeenCalled()
  })

  it('🔴 un reembolso parcial y otro total no revierten DOS veces', async () => {
    // Un mismo cobro puede reembolsarse en partes, y cada parte pasa por aquí. Sin
    // este guard, el cliente perdería dos sellos por una sola compra devuelta.
    prismaMock.stampEvent.count.mockResolvedValue(1)

    const r = await reverseStampForOrder('v1', 'o1')

    expect(r.reversed).toBe(false)
    expect(prismaMock.stampEvent.create).not.toHaveBeenCalled()
  })

  it('una venta que nunca dio sello no hace nada', async () => {
    // La mayoría de los reembolsos son de ventas sin cartilla. Corre en CADA
    // reembolso: tiene que ser un no-op barato y silencioso.
    prismaMock.stampEvent.findFirst.mockResolvedValue(null)

    const r = await reverseStampForOrder('v1', 'o1')

    expect(r.reversed).toBe(false)
    expect(prismaMock.stampCard.update).not.toHaveBeenCalled()
  })

  // ── H3 (auditoría de Codex del código, 15-oct-2026) ─────────────────────────────────────────────────────────────────────
  // Sin candado, la reversión leía la cartilla en 2/3; otra venta la completaba (premio + cartilla nueva) y la reversión
  // restaba con su lectura vieja: «2 de 3 y un premio pendiente». Ahora toma el MISMO candado que `grantStamp`.
  it('🔴 H3: el candado (negocio, cliente DEL SELLO ORIGINAL) es la PRIMERA sentencia de la transacción; la cartilla se lee detrás', async () => {
    const orden: string[] = []
    // D3 (24-oct): antes va la lectura del sello bajo el candado de la VENTA, en su propia transacción corta.
    prismaMock.$transaction.mockImplementationOnce(((cb: any) => cb(prismaMock)) as never)
    prismaMock.$executeRaw.mockImplementationOnce((async () => 0) as never)
    prismaMock.$transaction.mockImplementationOnce((async (cb: any) => {
      orden.push('BEGIN')
      return cb(prismaMock)
    }) as never)
    prismaMock.$executeRaw.mockImplementationOnce((async () => {
      orden.push('candado')
      return 0
    }) as never)
    prismaMock.stampEvent.count.mockImplementation((async () => {
      if (orden.includes('BEGIN')) orden.push('reversas')
      return 0
    }) as never)
    prismaMock.stampCard.findUnique.mockImplementation((async () => {
      if (orden.includes('BEGIN')) orden.push('cartilla')
      return { id: 'sc1', venueId: 'v1', customerId: 'c1', cycle: 1, stampsEarned: 6, stampsRequired: 7, completedAt: null }
    }) as never)
    prismaMock.stampEvent.create.mockImplementationOnce((async () => {
      orden.push('reversa')
      return { id: 'se2' }
    }) as never)

    const r = await reverseStampForOrder('v1', 'o1')

    expect(r.reversed).toBe(true)
    expect(orden.slice(0, 4)).toEqual(['BEGIN', 'candado', 'reversas', 'cartilla'])
    expect(orden).toContain('reversa')
    const [plantilla, ...valores] = prismaMock.$executeRaw.mock.calls[1] as unknown as [TemplateStringsArray, ...unknown[]]
    expect(plantilla.join('?')).toContain('pg_advisory_xact_lock(hashtext(?), hashtext(?))')
    // El MISMO candado que `grantStamp`: (negocio, cliente), con el cliente de la cartilla donde cayó el sello original.
    expect(valores).toEqual(['v1', 'c1'])
    // Y el de la lectura del sello (D3): (negocio, venta), el que `grantStamp` sostiene hasta su commit.
    expect((prismaMock.$executeRaw.mock.calls[0] as unknown[]).slice(1)).toEqual(['v1', 'o1'])
  })

  it('🔴 H3: otra reversión de la MISMA venta hizo commit mientras ésta esperaba el candado: no revierte dos veces', async () => {
    // Afuera no había reversa; dentro del candado, ya está.
    let conteos = 0
    prismaMock.stampEvent.count.mockImplementation((async () => (++conteos === 1 ? 0 : 1)) as never)

    const r = await reverseStampForOrder('v1', 'o1')

    expect(r).toEqual({ reversed: false, stampCardId: 'sc1' })
    expect(prismaMock.stampEvent.create).not.toHaveBeenCalled()
    expect(prismaMock.stampCard.update).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })

  // ── Quinta ola (recheck 4 de Codex, 15-oct-2026): el MISMO presupuesto que el otorgamiento ───────────────────────────────
  it('🔴 la reversión espera el candado del cliente con el MISMO presupuesto que el otorgamiento (maxWait 10 s, timeout 15 s)', async () => {
    await reverseStampForOrder('v1', 'o1')
    expect(prismaMock.$transaction).toHaveBeenCalledWith(expect.any(Function), { maxWait: 10_000, timeout: 15_000 })
  })

  it('🔴 un P2028 (se venció esperando el candado) se reintenta: UNA sola reversa', async () => {
    const p2028 = new Prisma.PrismaClientKnownRequestError('Transaction already closed', { code: 'P2028', clientVersion: 'test' })
    // La primera transacción es la lectura del sello (D3); se vence la del candado del cliente.
    prismaMock.$transaction.mockImplementationOnce(((cb: any) => cb(prismaMock)) as never).mockRejectedValueOnce(p2028)
    const r = await reverseStampForOrder('v1', 'o1')
    expect(r.reversed).toBe(true)
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(3)
    expect(prismaMock.stampEvent.create).toHaveBeenCalledTimes(1)
  })

  it('🔴 si se vence la LECTURA del sello bajo el candado de la venta (P2028), también se reintenta y se revierte (Codex D3-r1 #1)', async () => {
    const p2028 = new Prisma.PrismaClientKnownRequestError('Transaction already closed', { code: 'P2028', clientVersion: 'test' })
    prismaMock.$transaction.mockRejectedValueOnce(p2028)
    const r = await reverseStampForOrder('v1', 'o1')
    expect(r.reversed).toBe(true)
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(3)
    expect(prismaMock.stampEvent.create).toHaveBeenCalledTimes(1)
  })

  it('otro error de la transacción NO se reintenta', async () => {
    prismaMock.$transaction
      .mockImplementationOnce(((cb: any) => cb(prismaMock)) as never)
      .mockRejectedValueOnce(new Error('connection reset'))
    await expect(reverseStampForOrder('v1', 'o1')).rejects.toThrow('connection reset')
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(2)
  })

  it('🔴 deja rastro en la bitácora, porque quitar un sello es una ANOMALÍA', async () => {
    // Otorgar un sello NO se registra: pasa en cada cobro de cada negocio e inflaría
    // la bitácora hasta volverla inútil (regla del repo: registrar las anomalías que
    // un dueño de verdad audita, no el ruido de todos los días). Quitarlo sí: es
    // exactamente lo que alguien va a mirar cuando un cliente reclame que perdió un
    // sello.
    await reverseStampForOrder('v1', 'o1')

    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'STAMP_REVERSED', venueId: 'v1' }))
  })
})
