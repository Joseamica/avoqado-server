/**
 * D4 fase 4d (REAL PostgreSQL · hz:47b359b5:D4, tras D93, D2, 4a, 4b y 4c): la actividad del mes por sucursal del SUPERADMIN viejo y el
 * «Cobrado este mes» y «Cobrado · 30 días» de la ficha del CRM cuentan un cobro hecho sin internet en el día en que se hizo (su hora real).
 *
 * El reloj (sólo `Date`) se fija al 1-dic 14:00 de CDMX. Cobros del negocio (MXN):
 *   P1 $10 sin red: 23:50 del 30-nov en CDMX (05:50Z del 1-dic), subido 00:10 del 1-dic (06:10Z).
 *   P2 $20 sin red: 30-nov 23:50Z, subido 1-dic 00:10Z (el mes del SUPERADMIN viejo empieza a la medianoche del proceso, UTC).
 *   P3 $100 con red: 1-dic 12:00 de CDMX.
 *   P4 $7 sin red: 2 h antes de «hace 30 días», subido 2 h después.
 *
 *   TEST_DATABASE_URL='postgresql://…/<base desechable>' npx jest --selectProjects integration --testPathPattern d4d-superadmin
 */
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: () => null } }))

import prisma from '@/utils/prismaClient'
import { getAllVenuesForSuperadmin } from '@/services/dashboard/superadmin.service'
import { cobradoEn30Dias, monthSales } from '@/services/crm/clients.service'
import { crearNegocio, NegocioDePrueba } from '../product-variants/fixtures'

const AHORA = new Date('2026-12-01T20:00:00.000Z') // 1-dic 14:00 en CDMX
const HACE_30_DIAS = AHORA.getTime() - 30 * 24 * 60 * 60 * 1000
const HORA = 60 * 60 * 1000

let n: NegocioDePrueba

async function cobro(monto: number, llegada: Date, delAparato?: Date) {
  await prisma.payment.create({
    data: {
      venueId: n.venueId,
      amount: monto,
      tipAmount: 0,
      method: 'CASH',
      status: 'COMPLETED',
      type: 'REGULAR',
      feePercentage: 0,
      feeAmount: 0,
      netAmount: monto,
      createdAt: llegada,
      clientCreatedAt: delAparato ?? null,
    },
  })
}

beforeAll(async () => {
  jest.useFakeTimers({
    now: AHORA,
    advanceTimers: true,
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
    ],
  })
  n = await crearNegocio('d4d-superadmin-crm')
  await prisma.venue.update({
    where: { id: n.venueId },
    data: { timezone: 'America/Mexico_City', status: 'ACTIVE', demoExpiresAt: null, currency: 'MXN' } as never,
  })
  await cobro(10, new Date('2026-12-01T06:10:00.000Z'), new Date('2026-12-01T05:50:00.000Z')) // P1
  await cobro(20, new Date('2026-12-01T00:10:00.000Z'), new Date('2026-11-30T23:50:00.000Z')) // P2
  await cobro(100, new Date('2026-12-01T18:00:00.000Z')) // P3
  await cobro(7, new Date(HACE_30_DIAS + 2 * HORA), new Date(HACE_30_DIAS - 2 * HORA)) // P4
})

afterAll(async () => {
  jest.useRealTimers()
  if (!n?.venueId) return await prisma.$disconnect() // sin negocio no se borra nada (un filtro vacío borraría toda la base)
  await prisma.payment.deleteMany({ where: { venueId: n.venueId } })
  await n.limpiar()
  await prisma.$disconnect()
})

describe('D4d · SUPERADMIN y CRM a la hora real', () => {
  it('SUPERADMIN viejo: la actividad de diciembre no trae a P2 (del 30-nov en el aparato) — con la llegada eran $130', async () => {
    const fila = (await getAllVenuesForSuperadmin()).find(v => v.id === n.venueId)
    expect(fila?.monthlyRevenue).toBe(110) // P1 + P3
  })

  it('CRM «Cobrado este mes»: P1 es del 30-nov en CDMX y ya no cuenta en diciembre — con la llegada eran $110', async () => {
    const r = await monthSales(n.organizationId, AHORA)
    expect(Number(r.total)).toBe(100) // sólo P3
    expect(r.otraMoneda).toBe(false)
  })

  it('CRM «Cobrado · 30 días»: P4 (de hace 30 días y 2 h) ya no entra — con la llegada eran $137', async () => {
    const r = await cobradoEn30Dias(n.organizationId, AHORA)
    expect(Number(r.total)).toBe(130) // P1 + P2 + P3
  })
})
