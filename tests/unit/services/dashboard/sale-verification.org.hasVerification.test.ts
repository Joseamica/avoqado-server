/**
 * `hasVerification` en el contrato de organización (Asana 1218158516825558)
 *
 * Bug reportado por PlayTelecom: en la pantalla "Ventas" de organización aparecen
 * renglones sin SIM ID, sin promotor y sin foto, y al intentar rechazarlos sale
 * "Sale verification not found". No son ventas fantasma: son cobros COMPLETED cuya
 * `SaleVerification` nunca se creó (se crea FUERA de la transacción del pago, en
 * `payment.tpv.controller.ts`, y su error se traga a propósito).
 *
 * Causa raíz del 404: la lista se arma desde `Payment` y cae a
 * `id: v?.id ?? p.id` + `status: v?.status ?? 'PENDING'`. Un pago huérfano viaja
 * entonces con el id del PAGO y con un 'PENDING' fabricado, y el dashboard manda ese
 * id a `reviewOrgSaleVerification`, que lo busca en la tabla `SaleVerification` →
 * 404 garantizado en Aprobar, Rechazar, Revisar y Editar.
 *
 * Lo que hace invisible el problema es que el DTO NO expone si la verificación
 * existe. El servicio hermano venue-scoped SÍ lo expone (`hasVerification`,
 * sale-verification.dashboard.service.ts:37/223/239) y su pantalla legacy lo usa para
 * NO pintar los botones (SalesReport.tsx:989). Al reescribir la pantalla como
 * organización se estrenó `OrgSaleListRow` sin ese campo, así que la guarda quedó en
 * `status === 'PENDING'` — que para un huérfano es precisamente el valor fabricado.
 * La condición que debía apagar el botón es la que lo enciende.
 *
 * Fix: emitir `hasVerification` también en el contrato de organización, con la MISMA
 * semántica que el venue-scoped (`v !== null`), para que el cliente pueda distinguir
 * un renglón revisable de uno que no lo es.
 */

import { listOrgSaleVerifications } from '@/services/dashboard/sale-verification.org.dashboard.service'
import { listSaleVerificationsWithDetails } from '@/services/dashboard/sale-verification.dashboard.service'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    payment: { findMany: jest.fn(), count: jest.fn() },
    saleVerification: { findMany: jest.fn() },
    staffVenue: { findMany: jest.fn() },
    terminal: { findMany: jest.fn() },
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

const mockPrisma = prisma as unknown as {
  payment: { findMany: jest.Mock; count: jest.Mock }
  terminal: { findMany: jest.Mock }
}

const ORG_ID = 'org_playtelecom'
const VENUE_ID = 'venue_bae_mezquital'
const VENUE = { id: VENUE_ID, name: 'BAE MEZQUITAL', city: 'San Luis Potosí', slug: 'bae-mezquital' }

/**
 * Un cobro huérfano tal como existe hoy en producción: COMPLETED, $0.00, con orden
 * pero sin `SerializedItem` en sus items y sin `SaleVerification`. Es la forma exacta
 * de los 5 renglones del 3-sep 18:18 en BAE MEZQUITAL.
 */
function pagoHuerfano(id: string) {
  return {
    id,
    amount: 0,
    method: 'OTHER',
    status: 'COMPLETED',
    createdAt: new Date(Date.UTC(2026, 8, 4, 0, 18, 0)),
    order: { id: `ord_${id}`, venue: VENUE, items: [] },
    saleVerification: null,
  }
}

/** Un cobro normal, con su verificación y su ICCID — el caso que NO debe cambiar. */
function pagoConVerificacion(id: string) {
  return {
    id,
    amount: 0,
    method: 'OTHER',
    status: 'COMPLETED',
    createdAt: new Date(Date.UTC(2026, 8, 4, 0, 18, 0)),
    order: {
      id: `ord_${id}`,
      venue: VENUE,
      items: [
        {
          serializedItem: {
            id: `si_${id}`,
            serialNumber: '8952140064247085252F',
            category: { id: 'cat_caja', name: 'SIM de Caja Vinculado' },
            registeredFromVenue: { id: 'venue_virtual', name: 'Virtual', slug: 'virtual' },
          },
        },
      ],
    },
    saleVerification: {
      id: `sv_${id}`,
      status: 'PENDING',
      isPortabilidad: false,
      photos: ['https://example.test/foto.jpg'],
      serialNumbers: ['8952140064247085252F'],
      reviewedById: null,
      reviewedAt: null,
      reviewNotes: null,
      rejectionReasons: [],
      createdAt: new Date(Date.UTC(2026, 8, 4, 0, 18, 0)),
      updatedAt: new Date(Date.UTC(2026, 8, 4, 0, 18, 0)),
      staffId: 'staff_josefina',
      deviceId: null,
      inventoryDeducted: false,
      notes: null,
      scannedProducts: [],
      staff: { id: 'staff_josefina', firstName: 'Josefina', lastName: 'Alvarado', email: null, photoUrl: null },
      reviewedBy: null,
    },
  }
}

function montarLista(pagos: unknown[]) {
  mockPrisma.payment.count.mockResolvedValue(pagos.length)
  mockPrisma.payment.findMany.mockResolvedValue(pagos)
  mockPrisma.terminal.findMany.mockResolvedValue([])
}

describe('hasVerification en el contrato de organización (Asana 1218158516825558)', () => {
  beforeEach(() => jest.clearAllMocks())

  // ── COMPORTAMIENTO NUEVO: el renglón dice si se puede revisar ──

  it('marca hasVerification=false en un cobro sin SaleVerification', async () => {
    montarLista([pagoHuerfano('cmtm7gpje075fi12a834qzlbf')])

    const { data } = await listOrgSaleVerifications(ORG_ID, { pageNumber: 1, pageSize: 20 })

    expect(data).toHaveLength(1)
    expect(data[0].hasVerification).toBe(false)
  })

  it('marca hasVerification=true en un cobro con SaleVerification', async () => {
    montarLista([pagoConVerificacion('pay_normal')])

    const { data } = await listOrgSaleVerifications(ORG_ID, { pageNumber: 1, pageSize: 20 })

    expect(data[0].hasVerification).toBe(true)
  })

  /**
   * 🔴 El corazón del bug: el renglón huérfano se pinta 'PENDING' aunque nadie lo mandó
   * a revisar, así que `status` NO sirve para decidir si mostrar los botones. Esta
   * prueba fija que las dos cosas se pueden distinguir — sin ella, el cliente vuelve a
   * quedarse sin forma de saberlo y la pantalla vuelve a ofrecer acciones muertas.
   */
  it('un huérfano y una verificación pendiente comparten status PENDING y sólo hasVerification los separa', async () => {
    montarLista([pagoHuerfano('pay_huerfano'), pagoConVerificacion('pay_normal')])

    const { data } = await listOrgSaleVerifications(ORG_ID, { pageNumber: 1, pageSize: 20 })

    const huerfano = data.find(r => r.paymentId === 'pay_huerfano')!
    const normal = data.find(r => r.paymentId === 'pay_normal')!

    expect(huerfano.status).toBe('PENDING')
    expect(normal.status).toBe('PENDING')
    expect(huerfano.hasVerification).toBe(false)
    expect(normal.hasVerification).toBe(true)
  })

  /**
   * El id del huérfano NO es un id de SaleVerification — es el del pago, y por eso los
   * endpoints de revisión devuelven 404. Se fija aquí para que quede escrito que el
   * `id` de este DTO es ambiguo y que `hasVerification` es lo único que lo desambigua.
   */
  it('el id del huérfano es el del PAGO, no el de una verificación', async () => {
    montarLista([pagoHuerfano('cmtm7gpje075fi12a834qzlbf')])

    const { data } = await listOrgSaleVerifications(ORG_ID, { pageNumber: 1, pageSize: 20 })

    expect(data[0].id).toBe('cmtm7gpje075fi12a834qzlbf')
    expect(data[0].id).toBe(data[0].paymentId)
    expect(data[0].hasVerification).toBe(false)
  })

  /**
   * Guarda contra la regresión que originó el bug: las dos pantallas del mismo dato
   * (venue-scoped y organización) deben coincidir en este campo. Si alguien vuelve a
   * estrenar un DTO sin él, esta prueba falla.
   */
  it('el contrato de organización coincide con el venue-scoped en hasVerification', async () => {
    montarLista([pagoHuerfano('pay_huerfano'), pagoConVerificacion('pay_normal')])
    const org = await listOrgSaleVerifications(ORG_ID, { pageNumber: 1, pageSize: 20 })

    montarLista([pagoHuerfano('pay_huerfano'), pagoConVerificacion('pay_normal')])
    const venue = await listSaleVerificationsWithDetails(VENUE_ID, { pageNumber: 1, pageSize: 20 })

    const porPago = (rows: Array<{ paymentId: string; hasVerification: boolean }>) =>
      Object.fromEntries(rows.map(r => [r.paymentId, r.hasVerification]))

    expect(porPago(org.data)).toEqual(porPago(venue.data))
  })

  // ── REGRESIÓN: lo que ya funcionaba sigue igual ──

  it('no cambia los demás campos del renglón huérfano', async () => {
    montarLista([pagoHuerfano('pay_huerfano')])

    const { data } = await listOrgSaleVerifications(ORG_ID, { pageNumber: 1, pageSize: 20 })

    expect(data[0].paymentId).toBe('pay_huerfano')
    expect(data[0].photos).toEqual([])
    expect(data[0].serialNumbers).toEqual([])
    expect(data[0].staff).toBeNull()
    expect(data[0].venue.name).toBe('BAE MEZQUITAL')
    expect(data[0].payment?.amount).toBe(0)
  })

  it('no cambia los demás campos del renglón con verificación', async () => {
    montarLista([pagoConVerificacion('pay_normal')])

    const { data } = await listOrgSaleVerifications(ORG_ID, { pageNumber: 1, pageSize: 20 })

    expect(data[0].id).toBe('sv_pay_normal')
    expect(data[0].serialNumbers).toEqual(['8952140064247085252F'])
    expect(data[0].staff?.firstName).toBe('Josefina')
    expect(data[0].category?.name).toBe('SIM de Caja Vinculado')
    expect(data[0].registeredFromVenue?.name).toBe('Virtual')
  })
})
