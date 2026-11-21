// tests/unit/services/online-ordering/printClaim.service.test.ts
import { prismaMock } from '@tests/__helpers__/setup'
import { PRINT_CLAIM_TTL_MS } from '@/services/online-ordering/constants'
import {
  NO_LO_RECOGIO_PAPEL_MS,
  claimOnlineOrderPrint,
  comandaAdmitida,
  confirmOnlineOrderPrinted,
  onlineOrderNeedsPrint,
} from '@/services/online-ordering/printClaim.service'

const NOW = new Date('2026-10-14T18:30:00.000Z')
const LIMITE = new Date(NOW.getTime() - PRINT_CLAIM_TTL_MS)
/** Un pedido con tarjeta de «Nadie» (D661): `CARD_ONLINE` sin aceptación. */
const D661 = { paymentMode: 'CARD_ONLINE', requiresAcceptance: false }

describe('onlineOrderNeedsPrint', () => {
  it('sólo pedidos aceptados que nadie imprimió', () => {
    expect(onlineOrderNeedsPrint({ status: 'PENDING_ACCEPTANCE', printedAt: null, printClaimedAt: null } as any, NOW)).toBe(false)
    expect(onlineOrderNeedsPrint({ status: 'ACCEPTED', printedAt: null, printClaimedAt: null } as any, NOW)).toBe(true)
    expect(onlineOrderNeedsPrint({ status: 'READY', printedAt: NOW, printClaimedAt: NOW } as any, NOW)).toBe(false)
  })

  it('un reclamo vencido cuenta como libre (se imprime de más antes que de menos)', () => {
    const fresh = new Date(NOW.getTime() - 10_000)
    const stale = new Date(NOW.getTime() - PRINT_CLAIM_TTL_MS - 1_000)
    expect(onlineOrderNeedsPrint({ status: 'ACCEPTED', printedAt: null, printClaimedAt: fresh } as any, NOW)).toBe(false)
    expect(onlineOrderNeedsPrint({ status: 'ACCEPTED', printedAt: null, printClaimedAt: stale } as any, NOW)).toBe(true)
  })

  it('D661 (Ruling 2): un pedido con tarjeta de «Nadie» que el cierre del día pasó a COMPLETED sigue pidiendo su comanda; otros COMPLETED no', () => {
    const cerrado = { status: 'COMPLETED', printedAt: null, printClaimedAt: null, notPickedUpAt: NOW }
    expect(onlineOrderNeedsPrint({ ...cerrado, ...D661 } as any, NOW)).toBe(true)
    expect(onlineOrderNeedsPrint({ ...cerrado, paymentMode: 'CARD_ONLINE', requiresAcceptance: true } as any, NOW)).toBe(false) // «Mi equipo»
    expect(onlineOrderNeedsPrint({ ...cerrado, paymentMode: 'PAY_AT_PICKUP', requiresAcceptance: false } as any, NOW)).toBe(false) // folio de caja
    expect(onlineOrderNeedsPrint({ ...cerrado } as any, NOW)).toBe(false)
  })

  it('D661 (Task 4): COMPLETED pide comanda sólo si lo cerró el corte (notPickedUpAt); si una PERSONA lo entregó sin papel, ya no', () => {
    const cerrado = { status: 'COMPLETED', printedAt: null, printClaimedAt: null, ...D661 }
    expect(onlineOrderNeedsPrint({ ...cerrado, notPickedUpAt: NOW } as any, NOW)).toBe(true) // lo cerró el corte
    expect(onlineOrderNeedsPrint({ ...cerrado, notPickedUpAt: null } as any, NOW)).toBe(false) // «Entregado» de una persona
    // Aceptado o listo no cambia: pide comanda con o sin marca (regresión).
    expect(onlineOrderNeedsPrint({ ...cerrado, status: 'ACCEPTED', notPickedUpAt: null } as any, NOW)).toBe(true)
  })

  it('D661 · B2 (Ruling 31): un «No lo recogió» pide comanda sólo durante 2 h tras el corte; la mañana siguiente ya no sale', () => {
    const cerrado = { status: 'COMPLETED', printedAt: null, printClaimedAt: null, ...D661 }
    const hace = (ms: number) => new Date(NOW.getTime() - ms)
    expect(NO_LO_RECOGIO_PAPEL_MS).toBe(2 * 3_600_000)
    expect(onlineOrderNeedsPrint({ ...cerrado, notPickedUpAt: hace(5 * 60_000) } as any, NOW)).toBe(true) // abierto minutos antes del corte
    expect(onlineOrderNeedsPrint({ ...cerrado, notPickedUpAt: hace(NO_LO_RECOGIO_PAPEL_MS) } as any, NOW)).toBe(true) // el borde, incluido
    expect(onlineOrderNeedsPrint({ ...cerrado, notPickedUpAt: hace(NO_LO_RECOGIO_PAPEL_MS + 1) } as any, NOW)).toBe(false)
    expect(onlineOrderNeedsPrint({ ...cerrado, notPickedUpAt: hace(8 * 3_600_000) } as any, NOW)).toBe(false) // a la mañana siguiente
    // Lo aceptado o listo no tiene ventana (regresión).
    expect(onlineOrderNeedsPrint({ ...cerrado, status: 'ACCEPTED', notPickedUpAt: null } as any, NOW)).toBe(true)
  })

  it('D661 · B3: comandaAdmitida es la misma regla sin el reclamo: con un reclamo vigente la comanda sigue admitida (se está imprimiendo) aunque nadie más la pueda reclamar', () => {
    const vigente = new Date(NOW.getTime() - 10_000)
    const cerrado = { status: 'COMPLETED', printedAt: null, ...D661, notPickedUpAt: new Date(NOW.getTime() - 60_000) }
    expect(comandaAdmitida({ ...cerrado, printClaimedAt: vigente } as any, NOW)).toBe(true)
    expect(onlineOrderNeedsPrint({ ...cerrado, printClaimedAt: vigente } as any, NOW)).toBe(false)
    expect(comandaAdmitida({ ...cerrado, printClaimedAt: null, refundRequestedAt: NOW } as any, NOW)).toBe(false)
    expect(comandaAdmitida({ ...cerrado, printClaimedAt: null, printedAt: NOW } as any, NOW)).toBe(false)
  })

  it('D661 (Ruling 2): con la devolución reservada o hecha ya no se pide comanda', () => {
    for (const status of ['ACCEPTED', 'READY', 'COMPLETED']) {
      const base = { status, printedAt: null, printClaimedAt: null, ...D661 }
      expect(onlineOrderNeedsPrint({ ...base, refundRequestedAt: NOW } as any, NOW)).toBe(false)
      expect(onlineOrderNeedsPrint({ ...base, refundRequestedAt: NOW, refundedAt: NOW } as any, NOW)).toBe(false)
    }
  })
})

describe('claimOnlineOrderPrint', () => {
  beforeEach(() => {
    prismaMock.onlineOrder.findFirst.mockReset()
    prismaMock.onlineOrder.findFirst.mockResolvedValue({ printClaimedAt: null } as any)
    prismaMock.onlineOrder.updateMany.mockResolvedValue({ count: 1 })
  })

  it('lee el reclamo vigente y gana con un CAS sobre ESE valor: pedidos aceptados, sin imprimir, sin devolución, libres o con reclamo vencido', async () => {
    await expect(claimOnlineOrderPrint('v1', 'ord1', 'dev1', NOW)).resolves.toEqual({ claimed: true })
    const lectura = (prismaMock.onlineOrder.findFirst.mock.calls[0][0] as any).where
    const call = prismaMock.onlineOrder.updateMany.mock.calls[0][0] as any
    for (const where of [lectura, call.where]) {
      expect(where).toMatchObject({ orderId: 'ord1', venueId: 'v1', printedAt: null, refundRequestedAt: null, refundedAt: null })
      expect(where.AND).toEqual(
        expect.arrayContaining([
          // D661 (Task 4): de lo COMPLETED, sólo lo que cerró el corte del día («No lo recogió»).
          // B2 (Ruling 31): y sólo durante las 2 h que siguen al corte.
          {
            OR: [
              { status: { in: ['ACCEPTED', 'READY'] } },
              { status: { in: ['COMPLETED'] }, ...D661, notPickedUpAt: { gte: new Date(NOW.getTime() - 2 * 3_600_000) } },
            ],
          },
          { OR: [{ printClaimedAt: null }, { printClaimedAt: { lt: LIMITE } }] },
        ]),
      )
    }
    // El CAS repite el reclamo que se leyó: si otro aparato lo tomó entre la lectura y la escritura, pierde.
    expect(call.where.printClaimedAt).toBeNull()
    expect(call.data).toEqual({ printClaimedAt: NOW, printClaimedBy: 'dev1' })
  })

  it('el perdedor recibe claimed:false (otro aparato lo tomó entre la lectura y la escritura, o ya no hay nada que imprimir)', async () => {
    prismaMock.onlineOrder.updateMany.mockResolvedValue({ count: 0 })
    await expect(claimOnlineOrderPrint('v1', 'ord1', 'dev2', NOW)).resolves.toEqual({ claimed: false })
    prismaMock.onlineOrder.findFirst.mockResolvedValue(null)
    prismaMock.onlineOrder.updateMany.mockClear()
    await expect(claimOnlineOrderPrint('v1', 'ord1', 'dev2', NOW)).resolves.toEqual({ claimed: false })
    expect(prismaMock.onlineOrder.updateMany).not.toHaveBeenCalled()
  })

  it('Ruling 9: un reclamo concedido sobre uno anterior que venció sin confirmarse trae posibleRepetida:true (y el CAS repite esa hora)', async () => {
    const vencido = new Date(LIMITE.getTime() - 1_000)
    prismaMock.onlineOrder.findFirst.mockResolvedValue({ printClaimedAt: vencido } as any)
    await expect(claimOnlineOrderPrint('v1', 'ord1', 'dev2', NOW)).resolves.toEqual({ claimed: true, posibleRepetida: true })
    expect((prismaMock.onlineOrder.updateMany.mock.calls[0][0] as any).where.printClaimedAt).toEqual(vencido)
    // Perder ese CAS no promete nada: sin posibleRepetida.
    prismaMock.onlineOrder.updateMany.mockResolvedValue({ count: 0 })
    await expect(claimOnlineOrderPrint('v1', 'ord1', 'dev3', NOW)).resolves.toEqual({ claimed: false })
  })
})

describe('confirmOnlineOrderPrinted', () => {
  it('sólo confirma quien reclamó', async () => {
    prismaMock.onlineOrder.updateMany.mockResolvedValue({ count: 1 })
    await expect(confirmOnlineOrderPrinted('v1', 'ord1', 'dev1', NOW)).resolves.toEqual({ ok: true })
    const call = prismaMock.onlineOrder.updateMany.mock.calls[0][0] as any
    expect(call.where).toMatchObject({ orderId: 'ord1', venueId: 'v1', printClaimedBy: 'dev1', printedAt: null })
    expect(call.data).toEqual({ printedAt: NOW })
  })
})
