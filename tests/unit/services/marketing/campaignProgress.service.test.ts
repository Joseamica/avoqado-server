/**
 * D37 — «Entregados» se quedaba en 0 aunque los correos ya habían salido.
 *
 * La lista leía `CustomerCampaign.sentCount/failedCount/skippedCount`, que nacen en 0 y nadie
 * sube: cada envío se anota en SU fila (`CustomerCampaignDelivery`). Y la campaña se quedaba en
 * `ENQUEUED` para siempre. Ahora los números y el estado salen de contar esas filas, con UN
 * `groupBy` por página (nunca una consulta por campaña).
 */
import { CustomerCampaignDeliveryStatus as D, CustomerCampaignStatus as C } from '@prisma/client'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { customerCampaignDelivery: { groupBy: jest.fn() } },
}))

import prisma from '@/utils/prismaClient'
import { conAvanceReal } from '@/services/marketing/campaignProgress.service'

const groupBy = (prisma as any).customerCampaignDelivery.groupBy as jest.Mock
const VENUE = 'clv1000000000000000000000'

/** Renglones como los devuelve Prisma: uno por (campaña, estado del envío). */
const g = (campaignId: string, status: D, n: number) => ({ campaignId, status, _count: { _all: n } })

beforeEach(() => {
  jest.clearAllMocks()
  groupBy.mockResolvedValue([])
})

describe('conAvanceReal — los números salen de los envíos', () => {
  it('cuenta salieron, fallaron (agotados + rebotados) y omitidos', async () => {
    groupBy.mockResolvedValue([g('c1', D.SENT, 7), g('c1', D.DEAD, 1), g('c1', D.FAILED, 2), g('c1', D.SKIPPED, 3)])
    const [c] = await conAvanceReal(VENUE, [{ id: 'c1', status: C.ENQUEUED }])
    expect(c).toMatchObject({ sentCount: 7, failedCount: 3, skippedCount: 3 })
  })

  it('🔴 UNA consulta para toda la página, acotada al negocio y a esas campañas (sin N+1)', async () => {
    await conAvanceReal(VENUE, [
      { id: 'c1', status: C.SENT },
      { id: 'c2', status: C.ENQUEUED },
      { id: 'c3', status: C.DRAFT },
    ])
    expect(groupBy).toHaveBeenCalledTimes(1)
    const args = groupBy.mock.calls[0][0]
    expect(args.by).toEqual(['campaignId', 'status'])
    // El borrador no entra: no puede tener envíos (ver la prueba de la carrera abajo).
    expect(args.where).toEqual({ venueId: VENUE, campaignId: { in: ['c1', 'c2'] } })
  })

  it('🔴 un borrador leído justo antes de encolarse NO sale «Borrador · 1 enviado»', async () => {
    // La fila se leyó en DRAFT y, antes del conteo, se encoló y salió su primer correo.
    groupBy.mockResolvedValue([g('c1', D.SENT, 1)])
    const [c] = await conAvanceReal(VENUE, [{ id: 'c1', status: C.DRAFT }])
    expect(c).toMatchObject({ status: C.DRAFT, sentCount: 0, failedCount: 0, skippedCount: 0 })
  })

  it('una página sólo de borradores y programadas no consulta los envíos', async () => {
    await conAvanceReal(VENUE, [
      { id: 'c1', status: C.DRAFT },
      { id: 'c2', status: C.SCHEDULED },
    ])
    expect(groupBy).not.toHaveBeenCalled()
  })

  it('página vacía: no consulta nada', async () => {
    expect(await conAvanceReal(VENUE, [])).toEqual([])
    expect(groupBy).not.toHaveBeenCalled()
  })

  it('una campaña sin envíos (borrador) queda en ceros, no hereda los de otra', async () => {
    groupBy.mockResolvedValue([g('c1', D.SENT, 5)])
    const [, borrador] = await conAvanceReal(VENUE, [
      { id: 'c1', status: C.ENQUEUED },
      { id: 'c2', status: C.DRAFT },
    ])
    expect(borrador).toMatchObject({ status: C.DRAFT, sentCount: 0, failedCount: 0, skippedCount: 0 })
  })

  it('«sin confirmar» (UNKNOWN) no se cuenta como salido ni como fallido', async () => {
    groupBy.mockResolvedValue([g('c1', D.SENT, 4), g('c1', D.UNKNOWN, 1)])
    const [c] = await conAvanceReal(VENUE, [{ id: 'c1', status: C.ENQUEUED }])
    expect(c).toMatchObject({ sentCount: 4, failedCount: 0, status: C.SENT })
  })

  it('conserva los demás campos de la fila tal cual', async () => {
    const [c] = await conAvanceReal(VENUE, [{ id: 'c1', status: C.DRAFT, name: 'Navidad', totalRecipients: 0 }])
    expect(c).toMatchObject({ id: 'c1', name: 'Navidad', totalRecipients: 0 })
  })
})

describe('conAvanceReal — el estado avanza solo', () => {
  it('ninguno ha salido todavía → En cola', async () => {
    groupBy.mockResolvedValue([g('c1', D.PENDING, 10)])
    const [c] = await conAvanceReal(VENUE, [{ id: 'c1', status: C.ENQUEUED }])
    expect(c.status).toBe(C.ENQUEUED)
  })

  it('unos salieron y otros esperan o se reintentan → Enviando', async () => {
    groupBy.mockResolvedValue([g('c1', D.SENT, 3), g('c1', D.PENDING, 5), g('c1', D.RETRYING, 1)])
    const [c] = await conAvanceReal(VENUE, [{ id: 'c1', status: C.ENQUEUED }])
    expect(c.status).toBe(C.SENDING)
  })

  it('uno ya va en camino (SENDING) aunque ninguno haya terminado → Enviando', async () => {
    groupBy.mockResolvedValue([g('c1', D.SENDING, 1), g('c1', D.PENDING, 9)])
    const [c] = await conAvanceReal(VENUE, [{ id: 'c1', status: C.ENQUEUED }])
    expect(c.status).toBe(C.SENDING)
  })

  it('ya no queda ninguno por salir → Enviada (aunque algunos fallaran)', async () => {
    groupBy.mockResolvedValue([g('c1', D.SENT, 8), g('c1', D.DEAD, 1), g('c1', D.SKIPPED, 1)])
    const [c] = await conAvanceReal(VENUE, [{ id: 'c1', status: C.ENQUEUED }])
    expect(c.status).toBe(C.SENT)
  })

  it('🔴 cancelada, bloqueada o vencida NO se disfraza de «Enviada»; sus números sí se cuentan', async () => {
    groupBy.mockResolvedValue([g('c1', D.SENT, 2), g('c1', D.SKIPPED, 8), g('c2', D.SENT, 1), g('c3', D.SKIPPED, 4)])
    const filas = await conAvanceReal(VENUE, [
      { id: 'c1', status: C.CANCELLED },
      { id: 'c2', status: C.BLOCKED },
      { id: 'c3', status: C.EXPIRED },
    ])
    expect(filas.map(f => f.status)).toEqual([C.CANCELLED, C.BLOCKED, C.EXPIRED])
    expect(filas[0]).toMatchObject({ sentCount: 2, skippedCount: 8 })
  })

  it('reintentándose sin ningún resultado todavía → Enviando, no «En cola»', async () => {
    groupBy.mockResolvedValue([g('c1', D.RETRYING, 1)])
    const [c] = await conAvanceReal(VENUE, [{ id: 'c1', status: C.ENQUEUED }])
    expect(c.status).toBe(C.SENDING)
  })

  it('todos omitidos → Enviada con 0 salidos y los omitidos contados (no «En cola» para siempre)', async () => {
    groupBy.mockResolvedValue([g('c1', D.SKIPPED, 10)])
    const [c] = await conAvanceReal(VENUE, [{ id: 'c1', status: C.ENQUEUED }])
    expect(c).toMatchObject({ status: C.SENT, sentCount: 0, skippedCount: 10 })
  })

  it('en cola sin ninguna fila (sólo si alguien las borró) → Enviada: ya no queda nada por salir', async () => {
    const [c] = await conAvanceReal(VENUE, [{ id: 'c1', status: C.ENQUEUED }])
    expect(c.status).toBe(C.SENT)
  })
})
