/**
 * D4 · «Sí llegó» por HTTP (panel y POS): vista previa, corregir y «Marcar resuelto».
 *
 * Se prueba por la ruta REAL (permiso → validación → controlador). Sólo se simulan el permiso (para ver cuál pide cada
 * ruta) y los servicios de Task 1 / Task 4, que tienen sus propias suites.
 */
import express from 'express'
import request from 'supertest'
import { prismaMock } from '@tests/__helpers__/setup'
import { ConflictError } from '@/errors/AppError'

const mockPerms: string[] = []
const mockUndo = jest.fn()
const mockPreview = jest.fn()
const mockResolve = jest.fn()
const mockAfter = jest.fn()

jest.mock('@/middlewares/checkPermission.middleware', () => ({
  checkPermission: (p: string) => (_req: unknown, _res: unknown, next: () => void) => {
    mockPerms.push(p)
    next()
  },
}))
jest.mock('@/services/reservation/undoNoShow.service', () => ({
  ...jest.requireActual('@/services/reservation/undoNoShow.service'),
  undoNoShow: (...a: unknown[]) => mockUndo(...a),
  previewUndoNoShow: (...a: unknown[]) => mockPreview(...a),
  resolveNoShowCorrection: (...a: unknown[]) => mockResolve(...a),
}))
jest.mock('@/services/reservation/noShowNotices.service', () => ({
  afterNoShowCorrection: (...a: unknown[]) => mockAfter(...a),
}))

import reservationRoutes from '@/routes/dashboard/reservation.routes'
import { NO_SHOW_UNDO_NOT_APPLICABLE, NO_SHOW_UNDO_PASS_BOOKING } from '@/services/reservation/undoNoShow.service'

function app() {
  const a = express()
  a.use(express.json())
  a.use((req, _res, next) => {
    ;(req as any).authContext = { userId: 'staff-1', role: 'MANAGER', venueId: 'v1' }
    next()
  })
  a.use('/venues/:venueId/reservations', reservationRoutes)
  a.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode ?? 500).json({ message: err.message, code: err.code }))
  return a
}

const plan = { creditToReconsume: 1, clearFee: false, restoreDeposit: false, pending: [] }
const resultado = (outcome: 'UNDONE' | 'ALREADY_UNDONE') => ({
  outcome,
  reservation: { id: 'r1', status: 'CHECKED_IN' },
  plan,
  correction: { id: 'corr-1', pending: [], resolvedAt: null },
})

let orden: string[]
beforeEach(() => {
  mockPerms.length = 0
  orden = []
  prismaMock.$transaction.mockImplementation(async (cb: any) => {
    const r = await cb(prismaMock)
    orden.push('commit')
    return r
  })
})

describe('GET …/:id/no-show/undo (vista previa)', () => {
  it('devuelve { plan } sin escribir, con reservations:update', async () => {
    mockPreview.mockResolvedValue(plan)

    const res = await request(app()).get('/venues/v1/reservations/r1/no-show/undo')

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ plan })
    expect(mockPreview).toHaveBeenCalledWith(prismaMock, 'v1', 'r1', expect.any(Date))
    expect(mockPerms).toEqual(['reservations:update'])
    expect(mockUndo).not.toHaveBeenCalled()
  })

  it.each([NO_SHOW_UNDO_PASS_BOOKING, NO_SHOW_UNDO_NOT_APPLICABLE])('responde 409 con su code (%s)', async code => {
    mockPreview.mockRejectedValue(new ConflictError('no aplica', code))

    const res = await request(app()).get('/venues/v1/reservations/r1/no-show/undo')

    expect(res.status).toBe(409)
    expect(res.body.code).toBe(code)
  })
})

describe('POST …/:id/no-show/undo («Sí llegó»)', () => {
  it('corrige en prisma.$transaction con la persona y el aparato, y avisa DESPUÉS del commit sin esperarlo', async () => {
    mockUndo.mockResolvedValue(resultado('UNDONE'))
    // El aviso nunca termina (Resend colgado): la respuesta no lo espera.
    mockAfter.mockImplementation(() => {
      orden.push('aviso')
      return new Promise(() => {})
    })

    const res = await request(app())
      .post('/venues/v1/reservations/r1/no-show/undo')
      .set('x-device-platform', 'ANDROID')
      .send({ reason: '  sí vino, se marcó tarde  ' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual(JSON.parse(JSON.stringify(resultado('UNDONE'))))
    expect(mockUndo).toHaveBeenCalledWith(prismaMock, {
      reservationId: 'r1',
      venueId: 'v1',
      actor: { type: 'HUMAN', staffId: 'staff-1' },
      source: 'POS_ANDROID',
      now: expect.any(Date),
      reason: 'sí vino, se marcó tarde',
    })
    expect(mockAfter).toHaveBeenCalledWith('corr-1')
    expect(orden).toEqual(['commit', 'aviso'])
    expect(mockPerms).toEqual(['reservations:update'])
  })

  it('sin header es el panel, y sin motivo no manda motivo', async () => {
    mockUndo.mockResolvedValue(resultado('UNDONE'))

    await request(app()).post('/venues/v1/reservations/r1/no-show/undo').send({})

    expect(mockUndo.mock.calls[0][1]).toEqual(expect.objectContaining({ source: 'DASHBOARD', reason: undefined }))
  })

  it('repetirlo (ALREADY_UNDONE) no vuelve a avisar', async () => {
    mockUndo.mockResolvedValue(resultado('ALREADY_UNDONE'))

    const res = await request(app()).post('/venues/v1/reservations/r1/no-show/undo').send({})

    expect(res.status).toBe(200)
    expect(res.body.outcome).toBe('ALREADY_UNDONE')
    expect(mockAfter).not.toHaveBeenCalled()
  })

  it.each([NO_SHOW_UNDO_PASS_BOOKING, NO_SHOW_UNDO_NOT_APPLICABLE])('409 con su code (%s) y sin aviso', async code => {
    mockUndo.mockRejectedValue(new ConflictError('no aplica', code))

    const res = await request(app()).post('/venues/v1/reservations/r1/no-show/undo').send({})

    expect(res.status).toBe(409)
    expect(res.body.code).toBe(code)
    expect(mockAfter).not.toHaveBeenCalled()
  })

  it('un motivo de más de 280 se rechaza en español antes de tocar nada', async () => {
    const res = await request(app())
      .post('/venues/v1/reservations/r1/no-show/undo')
      .send({ reason: 'x'.repeat(281) })

    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/280 caracteres/)
    expect(mockUndo).not.toHaveBeenCalled()
  })
})

describe('POST …/:id/no-show/undo/resolve («Marcar resuelto»)', () => {
  it('cierra el pendiente con quién y la nota', async () => {
    const resolvedAt = new Date('2026-10-28T16:00:00Z')
    mockResolve.mockResolvedValue({ resolvedAt })

    const res = await request(app())
      .post('/venues/v1/reservations/r1/no-show/undo/resolve')
      .set('x-device-platform', 'IOS')
      .send({ note: ' se cobró en caja ' })

    expect(res.status).toBe(200)
    expect(res.body).toEqual({ resolvedAt: resolvedAt.toISOString() })
    expect(mockResolve).toHaveBeenCalledWith('v1', 'r1', 'staff-1', 'se cobró en caja', 'POS_IOS')
    expect(mockPerms).toEqual(['reservations:update'])
  })

  it('una nota de más de 280 se rechaza', async () => {
    const res = await request(app())
      .post('/venues/v1/reservations/r1/no-show/undo/resolve')
      .send({ note: 'x'.repeat(281) })

    expect(res.status).toBe(400)
    expect(mockResolve).not.toHaveBeenCalled()
  })
})
