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
    payment: { update: jest.fn() },
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
