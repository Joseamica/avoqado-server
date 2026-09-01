/**
 * El overview LEGACY de stock-control ya no materializa la organización entera.
 *
 * Hallazgo del query-guard en producción (2026-09-01, primeras 4 horas de vida de la
 * guardia): `GET /organizations/:id/stock-control/overview` cargaba los 20,288 SIMs de
 * PlayTelecom con 6 relaciones — 92 veces en 6 horas, 4.5 s de promedio, 7.3 s la peor —
 * y disparó la alerta «Server congelado ≥3 s». El dashboard ya migró a los endpoints
 * paginados (`/summary`, `/items`, `/bulk-groups`); este endpoint sólo lo siguen llamando
 * las pestañas viejas que no han recargado. Mientras existan, no pueden tumbar el server.
 *
 * Reglas que fijan estas pruebas:
 * 1. Los `items` del overview están ACOTADOS (tope duro, los más recientes).
 * 2. Los totales y agregados salen de `getOrgSummary` (SQL sobre TODA la organización),
 *    no de los items acotados — un cliente viejo ve totales correctos aunque su tabla
 *    sea parcial.
 */
import { prismaMock } from '../../../__helpers__/setup'
import { orgStockControlService, LEGACY_OVERVIEW_ITEMS_CAP } from '@/services/organization-dashboard/orgStockControl.service'

const summaryFalso = {
  summary: { totalSims: 20288 } as any,
  aggregatesBySucursal: [{ venueId: 'v-1', venueName: 'BAE Papagayo' }] as any,
  aggregatesByCategoria: [{ categoryId: 'c-1', categoryName: 'SIM 5G' }] as any,
}

describe('OrgStockControlService.getOrgOverview — legacy acotado', () => {
  beforeEach(() => {
    prismaMock.serializedItem.findMany.mockResolvedValue([])
    prismaMock.staff.findMany.mockResolvedValue([])
  })

  it('pide los items con un tope duro, nunca la organización entera', async () => {
    jest.spyOn(orgStockControlService, 'getOrgSummary').mockResolvedValue(summaryFalso)

    await orgStockControlService.getOrgOverview('org-1', {})

    expect(prismaMock.serializedItem.findMany).toHaveBeenCalledTimes(1)
    const args = prismaMock.serializedItem.findMany.mock.calls[0][0]
    expect(args.take).toBe(LEGACY_OVERVIEW_ITEMS_CAP)
    expect(LEGACY_OVERVIEW_ITEMS_CAP).toBeLessThanOrEqual(500)
    expect(args.orderBy).toEqual({ createdAt: 'desc' })
  })

  it('los totales y agregados vienen del summary en SQL, no de los items acotados', async () => {
    const spy = jest.spyOn(orgStockControlService, 'getOrgSummary').mockResolvedValue(summaryFalso)

    const res = await orgStockControlService.getOrgOverview('org-1', { dateFrom: new Date('2026-08-01T00:00:00Z') })

    expect(spy).toHaveBeenCalledWith('org-1', expect.objectContaining({ dateFrom: new Date('2026-08-01T00:00:00Z') }))
    expect(res.summary).toBe(summaryFalso.summary)
    expect(res.aggregatesBySucursal).toBe(summaryFalso.aggregatesBySucursal)
    expect(res.aggregatesByCategoria).toBe(summaryFalso.aggregatesByCategoria)
  })

  it('conserva la forma de la respuesta para las pestañas viejas (items y bulkGroups siguen presentes)', async () => {
    jest.spyOn(orgStockControlService, 'getOrgSummary').mockResolvedValue(summaryFalso)

    const res = await orgStockControlService.getOrgOverview('org-1', {})

    expect(Array.isArray(res.items)).toBe(true)
    expect(Array.isArray(res.bulkGroups)).toBe(true)
  })
})
