jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }))

/**
 * 🔴 DINERO. Si la venta que otorgó un sello se reembolsa, el sello sobra: el cliente
 * avanza en su cartilla por algo que devolvió, y termina cobrando un premio que no se
 * ganó. Con un café son centavos; con siete clientes haciéndolo, es una cartilla
 * completa regalada cada semana.
 */
import { reverseStampForOrder } from '../../../../src/services/wallet/stampLedger.service'
import { prismaMock } from '../../../__helpers__/setup'
import { logAction } from '@/services/dashboard/activity-log.service'

describe('reverseStampForOrder', () => {
  beforeEach(() => {
    jest.clearAllMocks()
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
    prismaMock.stampCard.findFirst.mockResolvedValue(null)
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
    prismaMock.stampCard.findFirst.mockResolvedValue({ id: 'sc2', stampsEarned: 0, completedAt: null } as any)
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
    const [plantilla, ...valores] = prismaMock.$executeRaw.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]]
    expect(plantilla.join('?')).toContain('pg_advisory_xact_lock(hashtext(?), hashtext(?))')
    // El MISMO candado que `grantStamp`: (negocio, cliente), con el cliente de la cartilla donde cayó el sello original.
    expect(valores).toEqual(['v1', 'c1'])
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
