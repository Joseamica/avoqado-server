/**
 * «Mis ventas» de la app de campo se agrupa por mes (Codex 26-nov r3 #8): cada SIM trae `saleAt`, la hora REAL de la venta
 * (la de su verificación, que guarda la del celular aunque suba después sin red), además de `soldAt` (la de subida).
 */
import { SimCustodyService } from '@/services/serialized-inventory/custody.service'

jest.mock('@/services/serialized-inventory/custody.notifications', () => ({ notifySimCustody: jest.fn() }))

const ACTOR = { staffId: 'staff_promotor', organizationId: 'org_1', role: 'WAITER' as const }

it('cada SIM trae saleAt = la hora de su verificación; sin verificación, null; soldAt sigue igual', async () => {
  const vendidaSinRed = {
    id: 'i1',
    serialNumber: 'SIM-1',
    soldAt: new Date('2026-12-01T06:10:00Z'), // subió el 1-dic
    category: null,
    orderItem: {
      order: {
        payments: [
          {
            id: 'p1',
            saleVerification: {
              id: 'v1',
              status: 'COMPLETED',
              rejectionReasons: [],
              reviewNotes: null,
              reviewedAt: null,
              createdAt: new Date('2026-12-01T05:58:00Z'),
            },
          },
        ],
      },
    },
  }
  const enCustodia = { id: 'i2', serialNumber: 'SIM-2', soldAt: null, category: null, orderItem: null }
  const findMany = jest.fn().mockResolvedValue([vendidaSinRed, enCustodia])
  const service = new SimCustodyService({ serializedItem: { findMany } } as any)

  const r = await service.listMySims(ACTOR)

  expect(r[0]).toMatchObject({ soldAt: new Date('2026-12-01T06:10:00Z'), saleAt: new Date('2026-12-01T05:58:00Z'), verificationId: 'v1' })
  expect(r[1]).toMatchObject({ saleAt: null, verificationId: null })
  const select = findMany.mock.calls[0][0].include.orderItem.select.order.select.payments.select.saleVerification.select
  expect(select).toMatchObject({ createdAt: true })
})
