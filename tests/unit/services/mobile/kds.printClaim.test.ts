/**
 * Quién imprime la comanda de un pedido que llegó SOLO.
 *
 * Un pedido de marketplace no lo manda nadie desde una tablet: aparece a la vez en todas las
 * pantallas de cocina. Sin árbitro, las tres tablets de un local imprimen el mismo pedido
 * tres veces — el problema #1 de soporte de Toast con pedidos en línea.
 */
import prisma from '../../../../src/utils/prismaClient'
import {
  claimKdsPrint,
  comandaPendienteDeImprimir,
  confirmKdsPrinted,
  releaseKdsPrint,
  PRINT_CLAIM_TTL_MS,
} from '../../../../src/services/mobile/kds.mobile.service'

describe('reclamación de impresión del KDS', () => {
  beforeEach(() => jest.clearAllMocks())

  // ── Lo único que de verdad importa ────────────────────────────────────────────────
  it('🔴 UNA sola tablet gana: la reclamación es un updateMany ATÓMICO, no leer-luego-escribir', async () => {
    ;(prisma.kdsOrder.updateMany as jest.Mock).mockResolvedValue({ count: 1 })

    const r = await claimKdsPrint('venue1', 'kds1', 'tablet-A')

    expect(r.claimed).toBe(true)
    // Leer el estado y después escribir dejaría una ventana entre las dos operaciones, y es
    // exactamente donde dos tablets que consultan al mismo tiempo ganan las dos.
    expect(prisma.kdsOrder.findFirst).not.toHaveBeenCalled()
    expect(prisma.kdsOrder.findUnique).not.toHaveBeenCalled()
  })

  it('la segunda tablet PIERDE (count 0) y no imprime', async () => {
    ;(prisma.kdsOrder.updateMany as jest.Mock).mockResolvedValue({ count: 0 })

    const r = await claimKdsPrint('venue1', 'kds1', 'tablet-B')

    expect(r.claimed).toBe(false)
  })

  // ── La caducidad, que es lo que evita la comanda enterrada ────────────────────────
  it('🔴 una reclamación VIEJA se puede retomar — si no, un aparato muerto se lleva la comanda', async () => {
    ;(prisma.kdsOrder.updateMany as jest.Mock).mockResolvedValue({ count: 1 })

    await claimKdsPrint('venue1', 'kds1', 'tablet-C')

    const where = (prisma.kdsOrder.updateMany as jest.Mock).mock.calls[0][0].where
    // Se puede reclamar si: nadie la tiene, o la tiene alguien desde hace demasiado.
    const opciones = where.OR
    expect(opciones).toEqual(expect.arrayContaining([{ printClaimedAt: null }, { printClaimedAt: { lt: expect.any(Date) } }]))
    const limite = opciones.find((o: { printClaimedAt?: { lt?: Date } }) => o.printClaimedAt?.lt)!.printClaimedAt.lt
    const antiguedad = Date.now() - limite.getTime()
    expect(antiguedad).toBeGreaterThan(PRINT_CLAIM_TTL_MS - 5_000)
    expect(antiguedad).toBeLessThan(PRINT_CLAIM_TTL_MS + 5_000)
  })

  it('🔴 lo YA IMPRESO nunca se vuelve a reclamar — el papel no se des-imprime', async () => {
    ;(prisma.kdsOrder.updateMany as jest.Mock).mockResolvedValue({ count: 1 })

    await claimKdsPrint('venue1', 'kds1', 'tablet-A')

    const where = (prisma.kdsOrder.updateMany as jest.Mock).mock.calls[0][0].where
    expect(where.printedAt).toBeNull()
  })

  it('siempre filtra por venueId (tenant isolation en la mutación misma)', async () => {
    ;(prisma.kdsOrder.updateMany as jest.Mock).mockResolvedValue({ count: 0 })

    await claimKdsPrint('venue-otro', 'kds1', 'tablet-A')

    const where = (prisma.kdsOrder.updateMany as jest.Mock).mock.calls[0][0].where
    expect(where.venueId).toBe('venue-otro')
    expect(where.id).toBe('kds1')
  })

  // ── Confirmar y soltar ────────────────────────────────────────────────────────────
  it('confirmar sella printedAt y sólo lo puede hacer QUIEN reclamó', async () => {
    ;(prisma.kdsOrder.updateMany as jest.Mock).mockResolvedValue({ count: 1 })

    await confirmKdsPrinted('venue1', 'kds1', 'tablet-A')

    const call = (prisma.kdsOrder.updateMany as jest.Mock).mock.calls[0][0]
    expect(call.where.printClaimedBy).toBe('tablet-A')
    expect(call.data.printedAt).toBeInstanceOf(Date)
  })

  it('🔴 si la impresión FALLA, soltar la deja libre de inmediato — no hay que esperar la caducidad', async () => {
    // Sin esto, una tablet sin papel bloquearía la comanda el tiempo completo del TTL
    // mientras la cocina no se entera del pedido.
    ;(prisma.kdsOrder.updateMany as jest.Mock).mockResolvedValue({ count: 1 })

    await releaseKdsPrint('venue1', 'kds1', 'tablet-A')

    const call = (prisma.kdsOrder.updateMany as jest.Mock).mock.calls[0][0]
    expect(call.where.printClaimedBy).toBe('tablet-A')
    expect(call.data.printClaimedAt).toBeNull()
    expect(call.data.printClaimedBy).toBeNull()
  })

  it('soltar NO puede borrar una impresión ya confirmada', async () => {
    ;(prisma.kdsOrder.updateMany as jest.Mock).mockResolvedValue({ count: 0 })

    await releaseKdsPrint('venue1', 'kds1', 'tablet-A')

    expect((prisma.kdsOrder.updateMany as jest.Mock).mock.calls[0][0].where.printedAt).toBeNull()
  })
})

describe('comandaPendienteDeImprimir — lo que el POS ve como "falta imprimir"', () => {
  it('ya impresa → no', () => {
    expect(comandaPendienteDeImprimir({ printedAt: new Date(), printClaimedAt: null })).toBe(false)
  })

  it('sin reclamar → sí', () => {
    expect(comandaPendienteDeImprimir({ printedAt: null, printClaimedAt: null })).toBe(true)
  })

  it('reclamación FRESCA → no (otra tablet no debe pelearla mientras el ganador imprime)', () => {
    expect(comandaPendienteDeImprimir({ printedAt: null, printClaimedAt: new Date() })).toBe(false)
  })

  // ── El hueco que hacía inalcanzable la caducidad ─────────────────────────────────
  // El server permite RETOMAR una reclamación vencida (test de arriba), pero los clientes
  // sólo reclaman lo que ven pendiente. Si esta función apagara `needsPrint` para siempre
  // en cuanto alguien reclama, la tablet que reclamó y MURIÓ enterraría la comanda: nadie
  // volvería a llamar claim-print jamás, y el TTL del server sería letra muerta.
  it('🔴 reclamación VENCIDA → sí — si no, un aparato muerto entierra la comanda para siempre', () => {
    const vencida = new Date(Date.now() - PRINT_CLAIM_TTL_MS - 1_000)
    expect(comandaPendienteDeImprimir({ printedAt: null, printClaimedAt: vencida })).toBe(true)
  })

  it('vencida pero YA impresa → no (el papel no se des-imprime)', () => {
    const vencida = new Date(Date.now() - PRINT_CLAIM_TTL_MS - 1_000)
    expect(comandaPendienteDeImprimir({ printedAt: new Date(), printClaimedAt: vencida })).toBe(false)
  })
})
