import { NextFunction, Request, Response } from 'express'
import * as customerService from '@/services/dashboard/customer.dashboard.service'

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
