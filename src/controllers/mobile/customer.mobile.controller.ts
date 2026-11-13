import { NextFunction, Request, Response } from 'express'
import * as customerService from '@/services/dashboard/customer.dashboard.service'
import { descuentosDeLosClientes } from '@/services/shared/descuentoDelCliente.service'
import logger from '@/config/logger'

/**
 * GET /api/v1/mobile/venues/:venueId/customers — misma lista que el DASHBOARD (mismo servicio), más `descuentoDelCliente`
 * en cada cliente (objeto o null) con UNA consulta por página. El DASHBOARD no cambia. Si la consulta falla se degrada a
 * null (la cajera aplica el descuento a mano) y se avisa en el log.
 */
export async function getCustomers(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId } = req.params
    const { page, pageSize, limit, search, customerGroupId, noGroup, tags, sortBy, sortOrder, hasPendingBalance } = req.query
    const tamanoPedido = pageSize ?? limit // `limit` = alias de `pageSize` (las apps mandan ?limit=50); el servicio topa en 100

    const result = await customerService.getCustomers(
      venueId,
      page ? Number(page) : undefined,
      tamanoPedido ? Number(tamanoPedido) : undefined,
      search as string | undefined,
      customerGroupId as string | undefined,
      noGroup as boolean | undefined,
      tags as string | undefined,
      sortBy as 'createdAt' | 'totalSpent' | 'visitCount' | 'lastVisit' | undefined,
      sortOrder as 'asc' | 'desc' | undefined,
      hasPendingBalance as boolean | undefined,
    )

    let descuentos = new Map<string, unknown>()
    try {
      descuentos = await descuentosDeLosClientes(
        venueId,
        result.data.map(c => c.id),
      )
    } catch (err) {
      logger.warn('[mobile-customers] no se pudo consultar el descuento de los clientes', {
        venueId,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    res.status(200).json({ ...result, data: result.data.map(c => ({ ...c, descuentoDelCliente: descuentos.get(c.id) ?? null })) })
  } catch (error) {
    next(error)
  }
}

/**
 * PUT /api/v1/mobile/venues/:venueId/customers/:customerId — editar cliente desde el POS (26-oct-2026).
 *
 * Mismo servicio que el dashboard, pero responde SÓLO datos de contacto: el registro completo trae la contraseña cifrada
 * del portal del cliente y montos `Decimal` que viajan como texto (Codex r1 #3 y #4). Las apps fusionan esto sobre la
 * ficha que ya tienen.
 */
export async function updateCustomerContact(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId, customerId } = req.params
    const { userId } = (req as any).authContext

    const customer = await customerService.updateCustomer(venueId, customerId, req.body, userId)

    res.status(200).json({
      message: 'Cliente actualizado',
      customer: {
        id: customer.id,
        firstName: customer.firstName,
        lastName: customer.lastName,
        phone: customer.phone,
        email: customer.email,
      },
    })
  } catch (error) {
    next(error)
  }
}
