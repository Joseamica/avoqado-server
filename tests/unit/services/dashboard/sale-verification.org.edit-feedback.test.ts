/**
 * Candado "Revisar por promotor" en el camino de EDITAR (Asana 1217299209026114).
 *
 * Bug original: editOrgSaleVerification ponía reviewNotes=null y rejectionReasons=[]
 * al pasar una venta a FAILED, dejando al promotor sin saber qué corregir.
 */

import { editOrgSaleVerification } from '@/services/dashboard/sale-verification.org.dashboard.service'
import prisma from '@/utils/prismaClient'

jest.mock('@/utils/prismaClient', () => {
  const tx = {
    // Codex R13-3: la decisión económica va bajo el mutex del Payment (`$queryRaw`: candado y `cobrosDelProtocolo`, que aquí no
    // devuelve filas ⇒ cobro anterior al protocolo) y relee importe y método VIGENTES (`findUniqueOrThrow`).
    // Codex R16-1: el candado toma el PAR original → reembolso (`bloquearConSuOriginal`): lee la foto del Payment (`findFirst`: id, tipo,
    // puntero) antes y después de bloquear, entre savepoints (`$executeRaw`). Aquí el cobro NO es un reembolso.
    $queryRaw: jest.fn(async () => []),
    $executeRaw: jest.fn(async () => 0),
    payment: {
      update: jest.fn(),
      findUniqueOrThrow: jest.fn(async () => ({ amount: 100, method: 'CASH' })),
      findFirst: jest.fn(async () => ({ id: 'pay-1', type: 'CASH', processorData: {} })),
    },
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
    payment: { id: 'pay-1', amount: 100, method: 'CASH' },
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
