/**
 * Candado "Revisar por promotor" en el camino de EDITAR (Asana 1217299209026114).
 *
 * Bug original: editOrgSaleVerification ponía reviewNotes=null y rejectionReasons=[]
 * al pasar una venta a FAILED, dejando al promotor sin saber qué corregir.
 */

import { Prisma } from '@prisma/client'
import { editOrgSaleVerification } from '@/services/dashboard/sale-verification.org.dashboard.service'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => {
  const tx = {
    // Codex R13-3: la decisión económica va bajo el mutex del Payment (`$queryRaw`: candado y `cobrosDelProtocolo`, que aquí no
    // devuelve filas ⇒ cobro anterior al protocolo) y relee importe y método VIGENTES (`findUniqueOrThrow`).
    // Codex R16-1: el candado toma el PAR original → reembolso (`bloquearConSuOriginal`): lee la foto del Payment (`findFirst`: id, tipo,
    // puntero) antes y después de bloquear, entre savepoints (`$executeRaw`). Aquí el cobro NO es un reembolso.
    // D2: el candado de la cuenta (`lockExistingOrderForPayment`) contesta su fila; lo demás sigue vacío.
    $queryRaw: jest.fn(async (q: TemplateStringsArray) => (q.join('').includes('FROM "Order"') ? [{ id: 'ord-1' }] : [])),
    $executeRaw: jest.fn(async () => 0),
    payment: {
      update: jest.fn(),
      findUniqueOrThrow: jest.fn(async () => ({
        amount: 100,
        method: 'CASH',
        feeAmount: 0,
        orderId: 'ord-1',
        status: 'COMPLETED',
        type: 'REGULAR',
        tipAmount: 0,
      })),
      findFirst: jest.fn(async () => ({ id: 'pay-1', type: 'CASH', processorData: {} })),
      // D2: la corrección del importe mueve la cuenta; la venta es la de producción (1 artículo, ningún otro cobro).
      count: jest.fn(async () => 0),
    },
    order: {
      findFirst: jest.fn(async () => ({
        id: 'ord-1',
        version: 1,
        status: 'COMPLETED',
        paymentStatus: 'PAID',
        contratoDePrecio: null,
        subtotal: 100,
        discountAmount: 0,
        serviceChargeAmount: 0,
        deliveryFeeAmount: 0,
        taxAmount: 0,
        tipAmount: 0,
        total: 100,
        paidAmount: 100,
        remainingBalance: 0,
        items: [{ id: 'it-1', quantity: 1, weightQuantity: null, discountAmount: 0, taxAmount: 0, _count: { modifiers: 0 } }],
      })),
      update: jest.fn(),
    },
    orderItem: { update: jest.fn() },
    saleVerification: { update: jest.fn() },
    activityLog: { create: jest.fn() },
  }
  return {
    __esModule: true,
    default: {
      saleVerification: { findUnique: jest.fn() },
      $transaction: jest.fn(async (cb: any) => cb(tx)),
      __tx: tx,
    },
  }
})

jest.mock('@/middlewares/checkPermission.middleware', () => ({
  __esModule: true,
  staffHasPermissionInVenue: jest.fn().mockResolvedValue(true),
}))

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { broadcastToUser: jest.fn() },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), debug: jest.fn(), info: jest.fn(), error: jest.fn() },
}))

const ORG_ID = 'org-1'
const SV_ID = 'sv-1'
const EDITOR_ID = 'staff-owner-1'

const tx = (prisma as any).__tx
const mockedFindUnique = prisma.saleVerification.findUnique as jest.Mock

function existingSale(overrides: Record<string, any> = {}) {
  return {
    id: SV_ID,
    venueId: 'venue-1',
    staffId: 'staff-promoter-1',
    paymentId: 'pay-1',
    status: 'PENDING',
    isPortabilidad: false,
    reviewNotes: null,
    rejectionReasons: [],
    payment: { id: 'pay-1', amount: 100, method: 'CASH', orderId: 'ord-1' },
    venue: { organizationId: ORG_ID },
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  tx.saleVerification.update.mockResolvedValue({
    id: SV_ID,
    paymentId: 'pay-1',
    status: 'FAILED',
    reviewedAt: new Date(),
    reviewNotes: null,
    rejectionReasons: [],
    reviewedBy: null,
  })
})

describe('editOrgSaleVerification — candado "Revisar por promotor"', () => {
  it('rechaza pasar una venta a FAILED sin comentario', async () => {
    mockedFindUnique.mockResolvedValue(existingSale())

    await expect(
      editOrgSaleVerification(ORG_ID, {
        saleVerificationId: SV_ID,
        editedById: EDITOR_ID,
        status: 'FAILED',
        reason: 'Corrección de documentación',
      }),
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/mínimo 5 caracteres/i) })

    expect(tx.saleVerification.update).not.toHaveBeenCalled()
  })

  it('rechaza un comentario de menos de 5 caracteres', async () => {
    mockedFindUnique.mockResolvedValue(existingSale())

    await expect(
      editOrgSaleVerification(ORG_ID, {
        saleVerificationId: SV_ID,
        editedById: EDITOR_ID,
        status: 'FAILED',
        reviewNotes: 'mal',
        reason: 'Corrección de documentación',
      }),
    ).rejects.toMatchObject({ statusCode: 400 })

    expect(tx.saleVerification.update).not.toHaveBeenCalled()
  })

  it('PERSISTE reviewNotes y rejectionReasons al pasar a FAILED (regresión del bug)', async () => {
    mockedFindUnique.mockResolvedValue(existingSale())

    await editOrgSaleVerification(ORG_ID, {
      saleVerificationId: SV_ID,
      editedById: EDITOR_ID,
      status: 'FAILED',
      reviewNotes: '  Falta la imagen de vinculación, vuelve a subirla  ',
      rejectionReasons: ['REVIEW_MISSING_LINKING_IMAGE'],
      reason: 'Documentación incompleta',
    })

    expect(tx.saleVerification.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'FAILED',
          reviewNotes: 'Falta la imagen de vinculación, vuelve a subirla',
          rejectionReasons: ['REVIEW_MISSING_LINKING_IMAGE'],
        }),
      }),
    )
  })

  it('conserva el comentario existente al editar sólo el monto de una venta ya FAILED', async () => {
    mockedFindUnique.mockResolvedValue(
      existingSale({ status: 'FAILED', reviewNotes: 'Imagen ilegible', rejectionReasons: ['REVIEW_ILLEGIBLE_IMAGES'] }),
    )

    await editOrgSaleVerification(ORG_ID, {
      saleVerificationId: SV_ID,
      editedById: EDITOR_ID,
      status: 'FAILED',
      amount: 250,
      reason: 'Ajuste de monto',
    })

    expect(tx.saleVerification.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          reviewNotes: 'Imagen ilegible',
          rejectionReasons: ['REVIEW_ILLEGIBLE_IMAGES'],
        }),
      }),
    )
  })

  it('NO toca REJECTED: sigue aceptando motivo vacío (fuera de alcance)', async () => {
    mockedFindUnique.mockResolvedValue(existingSale())

    await expect(
      editOrgSaleVerification(ORG_ID, {
        saleVerificationId: SV_ID,
        editedById: EDITOR_ID,
        status: 'REJECTED',
        reason: 'Cliente desistió de la portabilidad',
      }),
    ).resolves.toBeDefined()
  })

  // Asana 1218872033233773 (Isaac): al rechazar por «Editar», el motivo se iba SÓLO a la bitácora y la
  // columna «Razón» del dashboard quedaba en «—». El motivo se guarda como comentario de la venta.
  it('al pasar a REJECTED guarda el motivo de la edición como comentario de la venta', async () => {
    mockedFindUnique.mockResolvedValue(existingSale({ status: 'COMPLETED' }))

    await editOrgSaleVerification(ORG_ID, {
      saleVerificationId: SV_ID,
      editedById: EDITOR_ID,
      status: 'REJECTED',
      reason: '  Vinculación duplicada con otra venta  ',
    })

    expect(tx.saleVerification.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'REJECTED',
          reviewNotes: 'Vinculación duplicada con otra venta',
          rejectionReasons: [],
        }),
      }),
    )
  })

  it('al pasar a REJECTED prefiere el comentario explícito sobre el motivo de la edición', async () => {
    mockedFindUnique.mockResolvedValue(existingSale({ status: 'FAILED', reviewNotes: 'Falta imagen' }))

    await editOrgSaleVerification(ORG_ID, {
      saleVerificationId: SV_ID,
      editedById: EDITOR_ID,
      status: 'REJECTED',
      reviewNotes: 'El cliente no quiso vincular la línea',
      reason: 'Cierre de la venta',
    })

    expect(tx.saleVerification.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'REJECTED', reviewNotes: 'El cliente no quiso vincular la línea' }),
      }),
    )
  })

  it('editar sólo el monto de una venta ya REJECTED no reescribe su comentario', async () => {
    mockedFindUnique.mockResolvedValue(existingSale({ status: 'REJECTED', reviewNotes: 'Vinculación duplicada' }))

    await editOrgSaleVerification(ORG_ID, {
      saleVerificationId: SV_ID,
      editedById: EDITOR_ID,
      status: 'REJECTED',
      amount: 0,
      reason: 'Ajuste de monto a cero',
    })

    const data = tx.saleVerification.update.mock.calls[0][0].data
    expect(data).not.toHaveProperty('reviewNotes')
  })

  it('NO exige comentario al pasar a COMPLETED', async () => {
    mockedFindUnique.mockResolvedValue(existingSale())

    await expect(
      editOrgSaleVerification(ORG_ID, {
        saleVerificationId: SV_ID,
        editedById: EDITOR_ID,
        status: 'COMPLETED',
        reason: 'Documentación correcta tras revisión',
      }),
    ).resolves.toBeDefined()
  })
})

// Codex r1 C1 (A11b punto 1): la edición leía el estado ANTES de la transacción y lo volvía a escribir. Una edición de monto
// cruzada con una reapertura dejaba la venta otra vez COMPLETED sin pasar por `approve`, y la bitácora decía COMPLETED → COMPLETED.
describe('editOrgSaleVerification — carrera con una reapertura (Codex r1 C1)', () => {
  /** La fila que hay en la base cuando llega el UPDATE: otro proceso ya la reabrió. */
  let enLaBase: Record<string, any>
  beforeEach(() => {
    enLaBase = {
      id: SV_ID,
      paymentId: 'pay-1',
      status: 'PENDING',
      reviewedAt: null,
      reviewNotes: null,
      rejectionReasons: [],
      reviewedBy: null,
    }
    // Como Postgres: el UPDATE sólo encuentra la fila si cumple todo el `where` (P2025 si no).
    tx.saleVerification.update.mockImplementation(async ({ where, data }: any) => {
      if (where.status !== undefined && where.status !== enLaBase.status) {
        throw new Prisma.PrismaClientKnownRequestError('Record to update not found.', { code: 'P2025', clientVersion: 'test' })
      }
      return (enLaBase = { ...enLaBase, ...data })
    })
  })

  it('leyó COMPLETED, la reabrieron a PENDING y termina la edición de monto ⇒ queda PENDING (no se aprueba sola)', async () => {
    mockedFindUnique.mockResolvedValue(existingSale({ status: 'COMPLETED' }))

    const r = await editOrgSaleVerification(ORG_ID, {
      saleVerificationId: SV_ID,
      editedById: EDITOR_ID,
      amount: 250,
      reason: 'Ajuste de monto',
    })

    expect(r.status).toBe('PENDING')
    const { where, data } = tx.saleVerification.update.mock.calls[0][0]
    expect(data).not.toHaveProperty('status')
    expect(data).not.toHaveProperty('reviewedById')
    expect(data).not.toHaveProperty('reviewedAt')
    expect(where).toEqual({ id: SV_ID })
    // La bitácora no inventa una transición: la edición no movió el estado.
    const log = tx.activityLog.create.mock.calls[0][0].data.data
    expect(log.before.status).toBe('PENDING')
    expect(log.after.status).toBe('PENDING')
  })

  it('con estado pedido y la venta cambiada entretanto ⇒ 409 SALE_VERIFICATION_CHANGED y la bitácora no se escribe', async () => {
    mockedFindUnique.mockResolvedValue(existingSale({ status: 'COMPLETED' }))

    await expect(
      editOrgSaleVerification(ORG_ID, {
        saleVerificationId: SV_ID,
        editedById: EDITOR_ID,
        status: 'COMPLETED', // el diálogo manda el estado que leyó
        amount: 250,
        reason: 'Ajuste de monto',
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'SALE_VERIFICATION_CHANGED' })

    expect(tx.saleVerification.update.mock.calls[0][0].where).toEqual({ id: SV_ID, status: 'COMPLETED' })
    expect(enLaBase.status).toBe('PENDING')
    expect(tx.activityLog.create).not.toHaveBeenCalled()
  })

  it('con estado pedido y la venta sin cambios ⇒ se escribe, condicionado al estado leído', async () => {
    enLaBase.status = 'PENDING'
    mockedFindUnique.mockResolvedValue(existingSale({ status: 'PENDING' }))

    const r = await editOrgSaleVerification(ORG_ID, {
      saleVerificationId: SV_ID,
      editedById: EDITOR_ID,
      status: 'COMPLETED',
      reason: 'Documentación correcta',
    })

    expect(r.status).toBe('COMPLETED')
    expect(tx.saleVerification.update.mock.calls[0][0].where).toEqual({ id: SV_ID, status: 'PENDING' })
    const log = tx.activityLog.create.mock.calls[0][0].data.data
    expect([log.before.status, log.after.status]).toEqual(['PENDING', 'COMPLETED'])
  })
})

// A11b punto 4a: portabilidad → línea nueva. El portado viejo se quedaba en la venta y nadie lo podía borrar (la corrección del
// número no acepta portado en una venta que no es de portabilidad), así que seguía saliendo repetido o «9 dígitos».
describe('editOrgSaleVerification — portabilidad a línea nueva borra el portado', () => {
  it('pone en null el portado, su fuente y su hora en el mismo update, y la bitácora lleva el antes/después', async () => {
    mockedFindUnique.mockResolvedValue(existingSale({ isPortabilidad: true, portedNumber: '557777777' }))

    await editOrgSaleVerification(ORG_ID, {
      saleVerificationId: SV_ID,
      editedById: EDITOR_ID,
      isPortabilidad: false,
      reason: 'Era línea nueva',
    })

    expect(tx.saleVerification.update.mock.calls[0][0].data).toMatchObject({
      isPortabilidad: false,
      portedNumber: null,
      portedNumberSource: null,
      portedNumberSetAt: null,
    })
    const log = tx.activityLog.create.mock.calls[0][0].data.data
    expect(log.before).toMatchObject({ isPortabilidad: true, portedNumber: '557777777' })
    expect(log.after).toMatchObject({ isPortabilidad: false, portedNumber: null })
  })

  it('si sigue siendo portabilidad (o ya no lo era), el portado no se toca', async () => {
    mockedFindUnique.mockResolvedValue(existingSale({ isPortabilidad: true, portedNumber: '5577777777' }))
    await editOrgSaleVerification(ORG_ID, {
      saleVerificationId: SV_ID,
      editedById: EDITOR_ID,
      isPortabilidad: true,
      amount: 120,
      reason: 'Ajuste de monto',
    })
    expect(tx.saleVerification.update.mock.calls[0][0].data).not.toHaveProperty('portedNumber')
    expect(tx.activityLog.create.mock.calls[0][0].data.data.before).not.toHaveProperty('portedNumber')
  })
})
