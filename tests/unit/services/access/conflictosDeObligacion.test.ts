/**
 * V5-A paso 2 (Codex, v5 punto 2): una obligación que la entrega no pudo representar se guarda DURABLE y por
 * `subscriptionId` (pendiente/resuelta), no sólo en un log. Estas pruebas fijan el contrato del registro.
 */
import {
  cerrarConflictoTerminado,
  conflictosPendientes,
  registrarConflictoDeObligacion,
} from '@/services/access/conflictosDeObligacion.service'

const modelo = { createMany: jest.fn(), update: jest.fn(), updateMany: jest.fn(), findMany: jest.fn() }
const db = { billingObligationConflict: modelo } as never

const entrada = {
  venueId: 'cven1',
  subscriptionId: 'sub_2',
  customerId: 'cus_1',
  kind: 'DUPLICATE_PLAN' as const,
  conflictsWith: ['sub_1'],
  featureCode: 'PLAN_PRO',
  detectedBy: 'checkout.session.completed',
}

beforeEach(() => {
  for (const f of Object.values(modelo)) f.mockReset()
  // Por defecto no hay nada que reabrir (R12): el camino de siempre sólo refresca.
  modelo.updateMany.mockResolvedValue({ count: 0 })
})

describe('registrarConflictoDeObligacion', () => {
  it('la primera vez lo CREA pendiente con ON CONFLICT (createMany + skipDuplicates) y lo dice', async () => {
    modelo.createMany.mockResolvedValue({ count: 1 })

    await expect(registrarConflictoDeObligacion(db, entrada)).resolves.toBe('CREADO')
    expect(modelo.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({ ...entrada, status: 'PENDING' })],
      skipDuplicates: true,
    })
    expect(modelo.update).not.toHaveBeenCalled()
  })

  it('🔴 si ya existe, sólo refresca cuándo se vio y con quién choca — NUNCA reabre ni pisa una resolución', async () => {
    modelo.createMany.mockResolvedValue({ count: 0 })

    await expect(registrarConflictoDeObligacion(db, entrada)).resolves.toBe('ACTUALIZADO')
    const data = modelo.update.mock.calls[0][0].data
    expect(data).toEqual({ lastSeenAt: expect.any(Date), conflictsWith: ['sub_1'] })
    expect(data).not.toHaveProperty('status')
  })

  it('🔴 Codex (pasos 2-5, P2-6): nunca depende de atrapar un P2002 — dentro de una transacción de Postgres eso la aborta', async () => {
    modelo.createMany.mockResolvedValue({ count: 0 })

    await registrarConflictoDeObligacion(db, entrada)
    expect(modelo.createMany.mock.calls[0][0].skipDuplicates).toBe(true)
  })

  it('cualquier error se propaga (no se traga una falla de base)', async () => {
    modelo.createMany.mockRejectedValue(new Error('connection reset'))

    await expect(registrarConflictoDeObligacion(db, entrada)).rejects.toThrow('connection reset')
  })
})

describe('conflictosPendientes', () => {
  it('lee sólo los PENDIENTES del negocio, acotado y en orden estable', async () => {
    modelo.findMany.mockResolvedValue([{ subscriptionId: 'sub_2' }])

    await expect(conflictosPendientes(db, 'cven1')).resolves.toEqual([{ subscriptionId: 'sub_2' }])
    expect(modelo.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { venueId: 'cven1', status: 'PENDING' },
        orderBy: { createdAt: 'asc' },
        take: expect.any(Number),
      }),
    )
  })
})

/**
 * 🔴 Codex R12 (ronda 2): al conflicto le faltaban los dos extremos de su ciclo de vida.
 *  - Si operaciones CANCELA el duplicado, el conflicto se quedaba `PENDING` para siempre: sólo se resolvía concediendo
 *    acceso. Y los pendientes cuentan para el tope que la regla revisa ANTES de consultar Stripe, así que 201 muertos
 *    bloqueaban compras nuevas aunque ninguno cobrara un peso.
 *  - Al revés: uno que la entrega cerró sola (`ENTREGADA`) no volvía a pendiente si la misma suscripción presentaba
 *    otro problema, y entonces tampoco volvía a avisar. Una resolución HUMANA sí se respeta: no se reabre sola.
 */
describe('🔴 R12: el conflicto se cierra por terminación y se reabre en un episodio nuevo', () => {
  it('una suscripción que TERMINÓ cierra su conflicto pendiente (deja de bloquear compras)', async () => {
    await cerrarConflictoTerminado(db, 'sub_muerta')

    expect(modelo.updateMany).toHaveBeenCalledWith({
      where: { subscriptionId: 'sub_muerta', status: 'PENDING' },
      data: expect.objectContaining({ status: 'RESOLVED', resolution: 'TERMINADA' }),
    })
  })

  it('🔴 un episodio NUEVO sobre uno que la entrega cerró sola lo reabre, y vuelve a avisar UNA vez', async () => {
    modelo.createMany.mockResolvedValue({ count: 0 })
    modelo.updateMany.mockResolvedValue({ count: 1 })

    await expect(registrarConflictoDeObligacion(db, entrada)).resolves.toBe('CREADO')
    expect(modelo.updateMany).toHaveBeenCalledWith({
      where: { subscriptionId: 'sub_2', status: 'RESOLVED', resolution: 'ENTREGADA' },
      data: expect.objectContaining({ status: 'PENDING', resolvedAt: null, resolution: null }),
    })
    // Reabrir NO vuelve a pasar por el refresco de siempre.
    expect(modelo.update).not.toHaveBeenCalled()
  })

  it('🔴 una resolución HUMANA no se reabre sola: sólo se refresca cuándo se vio', async () => {
    modelo.createMany.mockResolvedValue({ count: 0 })
    modelo.updateMany.mockResolvedValue({ count: 0 })

    await expect(registrarConflictoDeObligacion(db, entrada)).resolves.toBe('ACTUALIZADO')
    expect(modelo.update).toHaveBeenCalledWith(expect.objectContaining({ where: { subscriptionId: 'sub_2' } }))
  })
})
