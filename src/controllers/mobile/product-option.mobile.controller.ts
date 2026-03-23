/**
 * Mobile Product Option Controller
 *
 * Handles product option (variant) management for POS mobile apps.
 */

import { NextFunction, Request, Response } from 'express'
import * as productOptionService from '../../services/mobile/product-option.mobile.service'

/**
 * List product options
 * @route GET /api/v1/mobile/venues/:venueId/product-options
 */
export const listProductOptions = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params

    const options = await productOptionService.listProductOptions(venueId)

    return res.json({ success: true, data: options })
  } catch (error) {
    next(error)
  }
}

/**
 * Create product option with values
 * @route POST /api/v1/mobile/venues/:venueId/product-options
 */
export const createProductOption = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId } = req.params
    const staffId = req.authContext?.userId || ''
    const { name, values } = req.body

    if (!name) {
      return res.status(400).json({ success: false, message: 'name es requerido' })
    }

    if (!values || !Array.isArray(values) || values.length === 0) {
      return res.status(400).json({ success: false, message: 'Se requiere al menos un valor (values)' })
    }

    const result = await productOptionService.createProductOption({
      venueId,
      staffId,
      name,
      values,
    })

    return res.status(201).json({ success: true, data: result })
  } catch (error) {
    next(error)
  }
}

/**
 * Update product option
 * @route PUT /api/v1/mobile/venues/:venueId/product-options/:optionId
 */
export const updateProductOption = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, optionId } = req.params
    const staffId = req.authContext?.userId || ''
    const { name, values } = req.body

    if (!name && (!values || !Array.isArray(values) || values.length === 0)) {
      return res.status(400).json({ success: false, message: 'Se requiere name o values para actualizar' })
    }

    const result = await productOptionService.updateProductOption({
      venueId,
      staffId,
      optionId,
      name,
      values,
    })

    return res.json({ success: true, data: result })
  } catch (error) {
    next(error)
  }
}

/**
 * Delete product option
 * @route DELETE /api/v1/mobile/venues/:venueId/product-options/:optionId
 */
export const deleteProductOption = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { venueId, optionId } = req.params
    const staffId = req.authContext?.userId || ''

    const result = await productOptionService.deleteProductOption(optionId, venueId, staffId)

    return res.json({ success: true, data: result })
  } catch (error) {
    next(error)
  }
}
