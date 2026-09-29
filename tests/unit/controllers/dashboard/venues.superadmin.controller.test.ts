/**
 * IVA por producto, plan 4 · ola 2 (C): el traslado que pierde la carrera (409 IVA_NEGOCIO_CAMBIO_DE_ORGANIZACION de la
 * relectura) es un rechazo esperado: va a `next` tal cual y NO se registra como `error` (dispara alertas en Better Stack).
 * Lo inesperado sigue registrándose como `error`.
 */
import type { NextFunction, Request, Response } from 'express'

import logger from '@/config/logger'
import { transferVenue } from '@/controllers/dashboard/venues.superadmin.controller'
import { negocioCambioDeOrganizacionError } from '@/services/fiscal/exclusionContable'
import { prismaMock } from '@tests/__helpers__/setup'

const req = { params: { venueId: 'v1' }, body: { targetOrganizationId: 'org-b' }, authContext: { userId: 's1' } } as unknown as Request
const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() } as unknown as Response

beforeEach(() => {
  prismaMock.venue.findUnique.mockResolvedValue({ id: 'v1', name: 'Negocio', organizationId: 'org-a', organization: { name: 'A' } })
  prismaMock.organization.findUnique.mockResolvedValue({ id: 'org-b', name: 'B' })
})

describe('transferVenue — qué se registra cuando falla', () => {
  it('el 409 de la relectura (otro traslado ganó) va a next y no se registra como error', async () => {
    const perdio = negocioCambioDeOrganizacionError()
    prismaMock.$transaction.mockRejectedValueOnce(perdio)
    const next = jest.fn() as NextFunction

    await transferVenue(req, res, next)

    expect(next).toHaveBeenCalledWith(perdio)
    expect(logger.error).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(
      '[VENUES_SUPERADMIN] Transfer rejected',
      expect.objectContaining({ venueId: 'v1', code: 'IVA_NEGOCIO_CAMBIO_DE_ORGANIZACION' }),
    )
  })

  it('un error inesperado sí se registra como error y va a next tal cual', async () => {
    const caida = new Error('base caída')
    prismaMock.$transaction.mockRejectedValueOnce(caida)
    const next = jest.fn() as NextFunction

    await transferVenue(req, res, next)

    expect(next).toHaveBeenCalledWith(caida)
    expect(logger.error).toHaveBeenCalledWith('[VENUES_SUPERADMIN] Error transferring venue', { error: caida })
  })
})
