/**
 * Lista de campañas — la CONSULTA no puede traer el cuerpo del correo.
 *
 * NEW FEATURE: `listCampaigns` acota su `select`. El defecto que cierra:
 * `findMany({ where, orderBy, skip, take })` sin `select` devuelve TODAS las columnas
 * de `CustomerCampaign`, incluidos `htmlBody` y `textBody` (`@db.Text`, el correo
 * renderizado completo). Con el `pageSize` por default de 20 eso son 20 cuerpos de
 * correo enteros viajando a una pantalla que sólo pinta nombre, asunto, estado y
 * contadores. Misma familia que el `include` sin tope de `getVenueById` que tumbó
 * producción el 2026-09-01, y contra `.claude/rules/bounded-queries-and-server-load.md`.
 *
 * 🔴 Se prueba la FORMA de la consulta, no la forma de la respuesta: un test que
 * comprobara el objeto devuelto pasaría igual con el defecto vivo, porque el mock
 * devuelve lo que uno le dice que devuelva — no lo que Prisma habría traído de la base.
 * La única evidencia real es qué `select` recibió Prisma.
 *
 * REGRESSION: sigue paginando igual y sigue devolviendo `{items,total,page,pageSize}`.
 */
import { Request, Response, NextFunction } from 'express'
import { listCampaigns } from '@/controllers/dashboard/marketingCampaign.dashboard.controller'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    customerCampaign: { findMany: jest.fn(), count: jest.fn() },
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

const findMany = prisma.customerCampaign.findMany as jest.Mock
const count = prisma.customerCampaign.count as jest.Mock

const VENUE = 'clv1000000000000000000000'

function armar(query: Record<string, unknown> = {}) {
  const req = { params: { venueId: VENUE }, query } as unknown as Request
  const res = { json: jest.fn(), status: jest.fn().mockReturnThis() } as unknown as Response
  const next = jest.fn() as unknown as NextFunction
  return { req, res, next }
}

describe('listCampaigns — consulta acotada', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    findMany.mockResolvedValue([])
    count.mockResolvedValue(0)
  })

  it('pide un select explícito (no trae la fila completa)', async () => {
    const { req, res, next } = armar()
    await listCampaigns(req, res, next)

    expect(next).not.toHaveBeenCalled()
    const args = findMany.mock.calls[0][0]
    expect(args.select).toBeDefined()
  })

  it('NUNCA trae htmlBody ni textBody: son el correo completo, y van ×pageSize', async () => {
    const { req, res, next } = armar()
    await listCampaigns(req, res, next)

    const args = findMany.mock.calls[0][0]
    // 🔴 Exigir el select ANTES de mirar dentro. Sin esta línea la prueba PASA con el
    // defecto vivo: sin `select`, `args.select ?? {}` es `{}`, la columna "no está", y
    // la ausencia se lee como cumplimiento — cuando en realidad Prisma trae TODO.
    expect(args.select).toBeDefined()
    expect(args.select.htmlBody ?? false).toBe(false)
    expect(args.select.textBody ?? false).toBe(false)
  })

  it('tampoco trae contentBlocks: el editor los pide en el DETALLE, la lista no los pinta', async () => {
    const { req, res, next } = armar()
    await listCampaigns(req, res, next)

    const args = findMany.mock.calls[0][0]
    expect(args.select).toBeDefined()
    expect(args.select.contentBlocks ?? false).toBe(false)
  })

  it('sí trae lo que la pantalla necesita para pintar un renglón', async () => {
    const { req, res, next } = armar()
    await listCampaigns(req, res, next)

    const args = findMany.mock.calls[0][0]
    expect(args.select).toBeDefined()
    const select = args.select
    for (const campo of [
      'id',
      'name',
      'subject',
      'status',
      'audience',
      'totalRecipients',
      'sentCount',
      'failedCount',
      'skippedCount',
      'scheduledFor',
      'createdAt',
      'updatedAt',
    ]) {
      expect(select[campo]).toBe(true)
    }
  })

  // ---- REGRESIÓN: lo que ya funcionaba sigue igual ----

  it('sigue acotada al venue del token, y ordena con un desempate ÚNICO', async () => {
    const { req, res, next } = armar()
    await listCampaigns(req, res, next)

    const args = findMany.mock.calls[0][0]
    expect(args.where).toEqual({ venueId: VENUE })
    // 🔴 Con `skip`/`take`, `createdAt` SOLO no basta: entre dos campañas creadas en el
    // mismo instante el orden no está definido, así que una puede salir dos veces o
    // desaparecer al pasar de página. El desempate por `id` lo vuelve total.
    // Lo vigila también `tests/unit/services/pagination-stability.guard.test.ts`.
    expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }])
    expect(count).toHaveBeenCalledWith({ where: { venueId: VENUE } })
  })

  it('pagina con los defaults 1/20 y devuelve la envoltura de siempre', async () => {
    findMany.mockResolvedValue([{ id: 'c1' }])
    count.mockResolvedValue(37)
    const { req, res, next } = armar()
    await listCampaigns(req, res, next)

    const args = findMany.mock.calls[0][0]
    expect(args.skip).toBe(0)
    expect(args.take).toBe(20)
    expect(res.json).toHaveBeenCalledWith({ items: [{ id: 'c1' }], total: 37, page: 1, pageSize: 20 })
  })

  it('respeta page y pageSize cuando vienen', async () => {
    const { req, res, next } = armar({ page: '3', pageSize: '5' })
    await listCampaigns(req, res, next)

    const args = findMany.mock.calls[0][0]
    expect(args.skip).toBe(10)
    expect(args.take).toBe(5)
  })

  it('un fallo de la base va a next(), nunca escapa', async () => {
    findMany.mockRejectedValue(new Error('db caída'))
    const { req, res, next } = armar()
    await listCampaigns(req, res, next)

    expect(next).toHaveBeenCalledWith(expect.any(Error))
    expect(res.json).not.toHaveBeenCalled()
  })
})
