/**
 * B2 · las reglas puras de «Cancelar venta» (R2): el mismo día en la zona del venue, la llave por sobre, el bloqueo VIGENTE de cada
 * sobre (lo lee el detalle de C4) y el freno de r1 F6 (liberar sin confirmar que la devolución no se hizo ⇒ 400 antes de candados).
 */
import { Prisma } from '@prisma/client'
import { bloqueosVigentes, claveDeSobre, liberarCancelacionDeVenta, mismoDiaDelVenue } from '@/services/giftCards/giftCardCancel.service'
import { prismaMock } from '@tests/__helpers__/setup'

describe('mismoDiaDelVenue — «en tienda, sólo el mismo día del cobro», en la zona del venue', () => {
  it('🔴 23:30 y 00:30 de la CDMX son días distintos aunque en UTC sea el mismo día', () => {
    // 2026-10-14T05:30Z = 13-oct 23:30 en CDMX; 06:30Z = 14-oct 00:30 (México ya no cambia de horario: UTC-6).
    expect(mismoDiaDelVenue(new Date('2026-10-14T05:30:00Z'), new Date('2026-10-14T06:30:00Z'), 'America/Mexico_City')).toBe(false)
  })

  it('mañana y noche del mismo día local son el mismo día', () => {
    expect(mismoDiaDelVenue(new Date('2026-10-14T15:00:00Z'), new Date('2026-10-15T04:59:00Z'), 'America/Mexico_City')).toBe(true)
  })

  it('Cancún (UTC-5) corta el día una hora antes que la CDMX', () => {
    expect(mismoDiaDelVenue(new Date('2026-10-14T04:30:00Z'), new Date('2026-10-14T05:30:00Z'), 'America/Cancun')).toBe(false)
  })
})

describe('claveDeSobre — una operationKey del gerente, un renglón de libreta por sobre', () => {
  it('deriva una llave estable por sobre', () => {
    expect(claveDeSobre('cancelar-0001', 'cgc1')).toBe('cancelar-0001:cgc1')
    expect(claveDeSobre('cancelar-0001', 'cgc1')).toBe(claveDeSobre('cancelar-0001', 'cgc1'))
    expect(claveDeSobre('cancelar-0001', 'cgc2')).not.toBe(claveDeSobre('cancelar-0001', 'cgc1'))
  })

  it('una llave larga (la ruta deja hasta 128) se resume para que la del sobre quepa en las 128 de la libreta, siempre igual', () => {
    const larga = 'k'.repeat(128)
    const sobre = 'ckq3v0f2b0000abcdefghijkl' // cuid de 25
    const clave = claveDeSobre(larga, sobre)
    expect(clave.length).toBeLessThanOrEqual(128)
    expect(clave).toMatch(/^[0-9a-f]{64}:ckq3v0f2b0000abcdefghijkl$/)
    expect(claveDeSobre(larga, sobre)).toBe(clave)
  })
})

describe('bloqueosVigentes — el bloqueo VIGENTE de cada sobre (r1 D-2: lo lee el detalle de C4, no la historia paginada)', () => {
  const db = (filas: unknown[]) => ({ $queryRaw: jest.fn().mockResolvedValue(filas) }) as unknown as Prisma.TransactionClient

  it('🔴 último movimiento BLOCK ⇒ entrada con motivo, nota y fecha; último UNBLOCK ⇒ sin entrada', async () => {
    const at = new Date('2026-10-14T18:00:00.000Z')
    const tx = db([
      { giftCardId: 'gc1', type: 'BLOCK', reason: 'SUSPICIOUS_ACTIVITY', note: 'Contracargo en revisión', createdAt: at },
      { giftCardId: 'gc2', type: 'UNBLOCK', reason: 'CASHIER_ERROR', note: null, createdAt: at },
    ])
    const m = await bloqueosVigentes(tx, ['gc1', 'gc2'])
    expect(m.get('gc1')).toEqual({ reason: 'SUSPICIOUS_ACTIVITY', note: 'Contracargo en revisión', at })
    expect(m.has('gc2')).toBe(false)
    // UNA consulta indexada (`[giftCardId, createdAt]`): el último BLOCK/UNBLOCK de cada sobre, con su nota y su fecha.
    const sql = ((tx.$queryRaw as unknown as jest.Mock).mock.calls[0][0] as Prisma.Sql).sql
    expect(sql).toContain('DISTINCT ON (a."giftCardId")')
    expect(sql).toContain('a.note AS note')
    expect(sql).toContain(`a.type IN ('BLOCK', 'UNBLOCK')`)
  })

  it('sin sobres no consulta', async () => {
    const tx = db([])
    expect((await bloqueosVigentes(tx, [])).size).toBe(0)
    expect(tx.$queryRaw).not.toHaveBeenCalled()
  })
})

describe('liberarCancelacionDeVenta — r1 F6: un timeout no prueba que el dinero no salió', () => {
  it('🔴 sin `confirmacionNoDevuelto: true` ⇒ 400 y ni siquiera abre la transacción (lo incierto se queda bloqueado)', async () => {
    ;(prismaMock.$transaction as jest.Mock).mockClear()
    await expect(
      liberarCancelacionDeVenta('v1', 'o1', { staffId: 's1', operationKey: 'liberar-0001' } as unknown as Parameters<
        typeof liberarCancelacionDeVenta
      >[2]),
    ).rejects.toMatchObject({ statusCode: 400 })
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('un valor «verdadoso» que no es `true` exacto (p. ej. "true" de un formulario) tampoco libera', async () => {
    ;(prismaMock.$transaction as jest.Mock).mockClear()
    await expect(
      liberarCancelacionDeVenta('v1', 'o1', {
        staffId: 's1',
        operationKey: 'liberar-0002',
        confirmacionNoDevuelto: 'true',
      } as unknown as Parameters<typeof liberarCancelacionDeVenta>[2]),
    ).rejects.toMatchObject({ statusCode: 400 })
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })
})
