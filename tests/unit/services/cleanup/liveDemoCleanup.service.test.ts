/**
 * Live Demo Cleanup — cleanupExpiredLiveDemos / cleanupAllLiveDemos
 *
 * LiveDemoSession has onDelete: Cascade on venueId, so deleting the demo venue
 * (deleteVenueData) already removes the session row at the DB level. The
 * explicit session delete that follows must therefore be idempotent —
 * otherwise every cleanup throws P2025 ("No record was found for a delete"),
 * cleanedCount never increments and the cron logs a false error per session
 * (prod, 2026-07-03 03:00 UTC).
 */

import * as fs from 'fs'
import * as path from 'path'
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { cleanupExpiredLiveDemos, cleanupAllLiveDemos } from '@/services/cleanup/liveDemoCleanup.service'
import { deleteOrRetainStaffWithH1ProvenanceTx } from '@/services/superadmin/staffDeletion.service'

jest.mock('@/services/superadmin/staffDeletion.service', () => ({
  deleteOrRetainStaffWithH1ProvenanceTx: jest.fn(),
  isH1ProvenanceConstraint: jest.fn().mockReturnValue(false),
}))

const prismaMock = prisma as any

function p2025(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('No record was found for a delete.', {
    code: 'P2025',
    clientVersion: '6.14.0',
  })
}

function makeSession(n = 1) {
  return {
    id: `lds-${n}`,
    sessionId: `session-uuid-${n}`,
    venueId: `venue-${n}`,
    staffId: `staff-${n}`,
    venue: { id: `venue-${n}`, name: `Live Demo ${n}`, status: 'LIVE_DEMO' },
    staff: { id: `staff-${n}`, email: `demo${n}@avoqado.io` },
  }
}

/**
 * Mocks the DB exactly as prod behaves after deleteVenueData ran:
 * the venue cascade already removed the LiveDemoSession row, so an exact
 * .delete() throws P2025 while .deleteMany() resolves with count 0.
 */
function mockCascadeAlreadyDeletedSession(status = 'LIVE_DEMO') {
  prismaMock.$transaction.mockImplementation(async (callback: (tx: typeof prismaMock) => Promise<unknown>) => callback(prismaMock))
  prismaMock.$queryRaw.mockResolvedValue([{ id: 'venue-1', status, name: 'Live Demo 1' }])
  prismaMock.venue.findUnique.mockResolvedValue({ status, name: 'Live Demo 1' })
  prismaMock.venue.delete.mockResolvedValue({})
  prismaMock.staff.delete.mockResolvedValue({})
  ;(deleteOrRetainStaffWithH1ProvenanceTx as jest.Mock).mockResolvedValue({ staff: { email: 'demo@avoqado.io' }, retainedForAudit: false })
  prismaMock.liveDemoSession.delete.mockRejectedValue(p2025())
  // Prisma's deleteMany ALWAYS resolves `{ count }`. The double must too: the cleanup adds
  // those counts up to report how much it erased, and a double that resolves `undefined`
  // would make the production code look broken for a reason that only exists in tests.
  for (const model of Object.values(prismaMock)) {
    const deleteMany = (model as { deleteMany?: jest.Mock })?.deleteMany
    if (typeof deleteMany?.mockResolvedValue === 'function') deleteMany.mockResolvedValue({ count: 0 })
  }
  prismaMock.liveDemoSession.deleteMany.mockResolvedValue({ count: 0 })
}

describe('cleanupExpiredLiveDemos — cascade-tolerant session delete', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('counts a session as cleaned even though the venue cascade already deleted the session row', async () => {
    prismaMock.liveDemoSession.findMany.mockResolvedValue([makeSession(1)])
    mockCascadeAlreadyDeletedSession()

    const cleaned = await cleanupExpiredLiveDemos()

    expect(cleaned).toBe(1)
    expect(prismaMock.venue.delete).toHaveBeenCalledWith({ where: { id: 'venue-1' } })
    expect(deleteOrRetainStaffWithH1ProvenanceTx).toHaveBeenCalledWith(prismaMock, 'staff-1')
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    // Idempotent delete: tolerates the row being gone (cascade), never throws P2025
    expect(prismaMock.liveDemoSession.deleteMany).toHaveBeenCalledWith({ where: { id: 'lds-1' } })
  })

  it('cleans the remaining sessions when one of them fails', async () => {
    prismaMock.liveDemoSession.findMany.mockResolvedValue([makeSession(1), makeSession(2)])
    mockCascadeAlreadyDeletedSession()
    ;(deleteOrRetainStaffWithH1ProvenanceTx as jest.Mock)
      .mockRejectedValueOnce(new Error('transient DB error'))
      .mockResolvedValueOnce({ staff: { email: 'demo@avoqado.io' }, retainedForAudit: false })

    const cleaned = await cleanupExpiredLiveDemos()

    expect(cleaned).toBe(1)
    expect(prismaMock.venue.delete).toHaveBeenCalledTimes(1)
  })

  // REGRESSION: pre-existing behavior that must not change
  it('still returns 0 and deletes nothing when there are no expired sessions', async () => {
    prismaMock.liveDemoSession.findMany.mockResolvedValue([])

    const cleaned = await cleanupExpiredLiveDemos()

    expect(cleaned).toBe(0)
    expect(prismaMock.venue.delete).not.toHaveBeenCalled()
    expect(prismaMock.staff.delete).not.toHaveBeenCalled()
  })

  it('still refuses to delete a non-LIVE_DEMO venue and does not count the session', async () => {
    prismaMock.liveDemoSession.findMany.mockResolvedValue([makeSession(1)])
    mockCascadeAlreadyDeletedSession('ACTIVE')

    const cleaned = await cleanupExpiredLiveDemos()

    expect(cleaned).toBe(0)
    expect(prismaMock.venue.delete).not.toHaveBeenCalled()
    expect(prismaMock.staff.delete).not.toHaveBeenCalled()
  })

  it('fails closed before venue deletion when demo Staff has immutable H1 provenance', async () => {
    prismaMock.liveDemoSession.findMany.mockResolvedValue([makeSession(1)])
    mockCascadeAlreadyDeletedSession()
    ;(deleteOrRetainStaffWithH1ProvenanceTx as jest.Mock).mockResolvedValue({
      staff: { email: 'demo@avoqado.io' },
      retainedForAudit: true,
    })

    await expect(cleanupExpiredLiveDemos()).resolves.toBe(0)

    expect(prismaMock.venue.delete).not.toHaveBeenCalled()
    expect(prismaMock.liveDemoSession.deleteMany).not.toHaveBeenCalled()
  })
})

describe('cleanupExpiredLiveDemos — merchant account cleanup (no orphaned demo accounts)', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('deletes the Stripe + Blumon demo MerchantAccounts referenced by the venue payment config', async () => {
    prismaMock.liveDemoSession.findMany.mockResolvedValue([makeSession(1)])
    mockCascadeAlreadyDeletedSession()
    prismaMock.venuePaymentConfig.findUnique.mockResolvedValue({
      venueId: 'venue-1',
      primaryAccountId: 'merchant-blumon-1',
      secondaryAccountId: 'merchant-stripe-1',
      tertiaryAccountId: null,
    })
    prismaMock.merchantAccount.deleteMany.mockResolvedValue({ count: 2 })

    const cleaned = await cleanupExpiredLiveDemos()

    expect(cleaned).toBe(1)
    expect(prismaMock.venuePaymentConfig.findUnique).toHaveBeenCalledWith({ where: { venueId: 'venue-1' } })
    expect(prismaMock.merchantAccount.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['merchant-blumon-1', 'merchant-stripe-1'] } },
    })
  })

  it('does not call merchantAccount.deleteMany when the venue has no payment config', async () => {
    prismaMock.liveDemoSession.findMany.mockResolvedValue([makeSession(1)])
    mockCascadeAlreadyDeletedSession()
    prismaMock.venuePaymentConfig.findUnique.mockResolvedValue(null)

    const cleaned = await cleanupExpiredLiveDemos()

    expect(cleaned).toBe(1)
    expect(prismaMock.merchantAccount.deleteMany).not.toHaveBeenCalled()
  })
})

describe('cleanupAllLiveDemos — cascade-tolerant session delete', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('counts a session as cleaned even though the venue cascade already deleted the session row', async () => {
    prismaMock.liveDemoSession.findMany.mockResolvedValue([makeSession(1)])
    mockCascadeAlreadyDeletedSession()

    const cleaned = await cleanupAllLiveDemos()

    expect(cleaned).toBe(1)
    expect(prismaMock.liveDemoSession.deleteMany).toHaveBeenCalledWith({ where: { id: 'lds-1' } })
  })
})

/**
 * 🔴 Los productos se borran AL FINAL, después de todo lo que los referencia.
 *
 * Siete claves foráneas con RESTRICT / NO ACTION cuelgan de `Product`
 * (CreditPackItem, CreditItemBalance, PromotionOption, PurchaseOrderItem y las tres de
 * catálogo), y basta UNA para tumbar la transacción entera. Pasó en vivo: el job falló cada
 * hora durante días con `CreditPackItem_productId_fkey` y **ninguna demo se limpió** — cada
 * pasada reportaba «Cleaned 0 sessions» junto a un error que nadie leía.
 *
 * Esta prueba fija el ORDEN, no la existencia de las llamadas: quitar cualquiera de los
 * borradores previos, o moverlo después de los productos, la hace fallar.
 */
describe('deleteVenueData — nada que apunte a un producto sobrevive a su borrado', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  /** Los modelos que BLOQUEAN `product.deleteMany` si quedan filas. */
  const BLOQUEADORES = [
    'creditTransaction',
    'creditItemBalance',
    'creditPackPurchase',
    'creditPack',
    'orderPromotion',
    'promotion',
    'purchaseOrder',
    'catalogPublicationFieldDecision',
    'catalogPublicationLine',
    'catalogVenueOverride',
    'catalogVenueBinding',
    'catalogBindingLine',
  ] as const

  it.each(BLOQUEADORES)('borra %s ANTES que los productos', async modelo => {
    prismaMock.liveDemoSession.findMany.mockResolvedValue([makeSession(1)])
    mockCascadeAlreadyDeletedSession()

    await cleanupExpiredLiveDemos()

    const bloqueador = prismaMock[modelo].deleteMany
    expect(bloqueador).toHaveBeenCalled()
    // `invocationCallOrder` es un contador global de jest: comparar los dos primeros ticks
    // demuestra el orden real, no que ambas llamadas existan.
    expect(bloqueador.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.product.deleteMany.mock.invocationCallOrder[0])
  })

  it('🔴 el saldo de crédito se busca por las DOS vías: su producto y su paquete', () => {
    // Alcanzarlo sólo por una deja filas vivas que vuelven a bloquear el borrado.
    // (Se comprueba sobre el argumento, porque el mock no evalúa el `where`.)
    prismaMock.liveDemoSession.findMany.mockResolvedValue([makeSession(1)])
    mockCascadeAlreadyDeletedSession()

    return cleanupExpiredLiveDemos().then(() => {
      const where = prismaMock.creditItemBalance.deleteMany.mock.calls[0][0].where
      expect(where.OR).toHaveLength(2)
      expect(JSON.stringify(where.OR)).toContain('venueId')
    })
  })
})

/**
 * 🔴 Lo que rompió la limpieza en PRODUCCIÓN el 2026-09-05, y es de la MISMA familia que la
 * llave foránea de `CreditPackItem` de arriba: no basta con que el schema cascadee una tabla
 * desde el venue.
 *
 * `PrivacyNoticeVersion` y `EcommerceMerchant` CASCADEAN desde `Venue`, y sus hijos
 * (`ConsentEvent.noticeVersionId`, `PaymentLink.ecommerceMerchantId`) son RESTRICT. Postgres NO
 * garantiza en qué orden recorre las ramas hermanas de un cascade, así que borrar el venue puede
 * intentar quitar el aviso de privacidad ANTES que el consentimiento que lo cita — y la
 * transacción entera revienta con P2003. Reproducido contra la base local el 2026-09-06:
 * `Foreign key constraint violated on the constraint: ConsentEvent_noticeVersionId_fkey`.
 *
 * Las dos filas las produce el propio demo: el ledger de consentimiento (campañas, Fase 0) y
 * `simulatePaymentLink`, que crea el `EcommerceMerchant` y su liga.
 */
describe('deleteVenueData — lo que bloquea el borrado del VENUE se quita antes', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  /** Hijo RESTRICT cuyo padre muere con el venue: hay que borrarlo ANTES de `venue.delete`. */
  const BLOQUEADORES_DEL_VENUE = [
    'consentEvent',
    'paymentLink',
    'commissionClawback',
    'commissionCalculation',
    'commissionPayout',
    'referralRewardGrant',
    'upsellAcceptance',
    'serializedItem',
  ] as const

  it.each(BLOQUEADORES_DEL_VENUE)('borra %s ANTES que el venue', async modelo => {
    prismaMock.liveDemoSession.findMany.mockResolvedValue([makeSession(1)])
    mockCascadeAlreadyDeletedSession()

    await cleanupExpiredLiveDemos()

    const bloqueador = prismaMock[modelo].deleteMany
    expect(bloqueador).toHaveBeenCalled()
    expect(bloqueador.mock.invocationCallOrder[0]).toBeLessThan(prismaMock.venue.delete.mock.invocationCallOrder[0])
  })
})

/**
 * 🔴 La otra mitad del fallo de producción, y la que explica por qué el modelo del error CAMBIABA
 * en cada pasada (`order`, `menu`, `webhookEvent`, `venueFeature`, `venue.delete`):
 *
 *   Transaction API error: Transaction already closed … timeout for this transaction was 5000 ms
 *
 * No era una tabla concreta: era el PRESUPUESTO. Todo el borrado vive en UNA transacción
 * interactiva, y Prisma le da 5 s por default; agotado el reloj, el que truena es simplemente el
 * enunciado que tocaba en ese instante. El borrado final del venue arrastra en cascada ~193
 * modelos —varios sobre tablas de decenas de miles de filas y con columnas `venueId` SIN índice
 * en producción—, así que 5 s no alcanzan con la base ocupada.
 *
 * La transacción NO se parte: el `FOR UPDATE` sobre el venue es lo que impide que una transición
 * LIVE_DEMO → negocio real ocurra a media limpieza (hay prueba de integración de esa carrera).
 * Lo que se sube es el presupuesto.
 */
describe('deleteVenueData — presupuesto de la transacción', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('🔴 no corre con los 5 s de default de Prisma', async () => {
    prismaMock.liveDemoSession.findMany.mockResolvedValue([makeSession(1)])
    mockCascadeAlreadyDeletedSession()

    await cleanupExpiredLiveDemos()

    const [, opciones] = prismaMock.$transaction.mock.calls[0]
    expect(opciones?.timeout).toBeGreaterThanOrEqual(30_000)
    // `maxWait` es la espera por un lugar en el pool: en el minuto :00 compite con ~40 crones.
    expect(opciones?.maxWait).toBeGreaterThan(2_000)
  })
})

/**
 * Una limpieza que reporta «Cleaned 1 sessions» no dice si borró 3 filas o 3 000. Al investigar el
 * fallo de producción esa cifra era justo lo que faltaba para saber si la transacción hacía
 * demasiado trabajo.
 */
describe('cleanupExpiredLiveDemos — reporta cuántas filas borró', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('suma las filas de cada deleteMany y las deja en el log', async () => {
    prismaMock.liveDemoSession.findMany.mockResolvedValue([makeSession(1)])
    mockCascadeAlreadyDeletedSession()
    prismaMock.order.deleteMany.mockResolvedValue({ count: 50 })
    prismaMock.orderItem.deleteMany.mockResolvedValue({ count: 97 })

    await cleanupExpiredLiveDemos()

    const lineas = (logger.info as jest.Mock).mock.calls.map(args => String(args[0]))
    // 50 + 97 + el propio venue.
    expect(lineas.some(linea => linea.includes('148'))).toBe(true)
  })
})

/**
 * 🔴 GUARDIA ESTRUCTURAL — es el tercer defecto de la MISMA familia en tres meses
 * (`CreditPackItem_productId_fkey`, después `ConsentEvent_noticeVersionId_fkey`), y siempre se
 * descubre igual: el cron falla cada hora en producción y nadie lee el error.
 *
 * Enumera contra el DMMF de Prisma cada llave foránea BLOQUEANTE (Restrict / NoAction) cuyo hijo Y
 * cuyo padre mueren los dos con el cascade del venue — el caso en que el orden lo decide Postgres
 * y no nosotros — y exige que el hijo se borre explícitamente ANTES que el padre.
 *
 * Si alguien agrega una relación así, esta prueba falla en su propio cambio y no seis semanas
 * después en el log de un cron.
 */
describe('🔴 ninguna llave foránea bloqueante queda sin atender', () => {
  type Arista = { hijo: string; campo: string; padre: string; accion: string }

  const modelos = Prisma.dmmf.datamodel.models
  const hijosEnCascada: Record<string, string[]> = {}
  const bloqueantes: Arista[] = []
  for (const modelo of modelos) {
    for (const campo of modelo.fields) {
      if (campo.kind !== 'object' || !campo.relationFromFields?.length) continue
      const accion = campo.relationOnDelete ?? (campo.isRequired ? 'Restrict' : 'SetNull')
      if (accion === 'Cascade') (hijosEnCascada[campo.type] ??= []).push(modelo.name)
      if (accion === 'Restrict' || accion === 'NoAction')
        bloqueantes.push({ hijo: modelo.name, campo: campo.relationFromFields.join(','), padre: campo.type, accion })
    }
  }

  /** Todo lo que Postgres borra al borrar un venue. */
  const cierre = new Set<string>(['Venue'])
  const pendientes = ['Venue']
  while (pendientes.length) {
    const padre = pendientes.shift() as string
    for (const hijo of hijosEnCascada[padre] ?? []) {
      if (cierre.has(hijo)) continue
      cierre.add(hijo)
      pendientes.push(hijo)
    }
  }

  const fuente = fs.readFileSync(path.resolve(__dirname, '../../../../src/services/cleanup/liveDemoCleanup.service.ts'), 'utf8')
  const cuerpo = fuente.slice(fuente.indexOf('async function deleteVenueDataTx'))
  const borradosEnOrden = [...cuerpo.matchAll(/tx\.(\w+)\.delete(?:Many)?\(/g)].map(m => m[1][0].toUpperCase() + m[1].slice(1))

  const cierreDe = (raiz: string): Set<string> => {
    const acumulado = new Set<string>([raiz])
    const cola = [raiz]
    while (cola.length) {
      const padre = cola.shift() as string
      for (const hijo of hijosEnCascada[padre] ?? []) {
        if (acumulado.has(hijo)) continue
        acumulado.add(hijo)
        cola.push(hijo)
      }
    }
    return acumulado
  }

  it('encuentra el grafo (si esto falla, el DMMF cambió de forma)', () => {
    expect(cierre.size).toBeGreaterThan(100)
    expect(borradosEnOrden).toContain('Venue')
  })

  it('🔴 todo hijo bloqueante muere antes que su padre', () => {
    const yaBorrado = new Set<string>()
    const problemas: string[] = []
    for (const paso of borradosEnOrden) {
      const seVan = cierreDe(paso)
      for (const padre of seVan) {
        for (const arista of bloqueantes) {
          // Una autorreferencia dentro de la MISMA tabla no es un problema: Postgres verifica
          // NO ACTION al terminar el enunciado, y el DELETE se lleva las dos filas a la vez.
          if (arista.padre !== padre || arista.hijo === arista.padre) continue
          // Sólo el caso que Postgres decide por su cuenta: hijo y padre mueren con el venue.
          if (!cierre.has(arista.hijo) || !cierre.has(arista.padre)) continue
          if (yaBorrado.has(arista.hijo)) continue
          problemas.push(`${paso} borra ${padre}, pero ${arista.hijo}.${arista.campo} lo referencia con ${arista.accion}`)
        }
      }
      for (const modelo of seVan) yaBorrado.add(modelo)
    }

    expect(problemas).toEqual([])
  })
})
