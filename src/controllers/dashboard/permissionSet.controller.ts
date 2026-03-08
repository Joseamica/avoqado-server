import { NextFunction, Request, Response } from 'express'
import * as permissionSetService from '../../services/dashboard/permissionSet.service'
import { AuthenticationError } from '../../errors/AppError'

export async function getAll(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId } = req.params
    const data = await permissionSetService.getAll(venueId)

    res.status(200).json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

export async function getById(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId, id } = req.params
    const data = await permissionSetService.getById(venueId, id)

    res.status(200).json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

export async function create(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId } = req.params
    const { userId } = (req as any).authContext

    if (!userId) {
      throw new AuthenticationError('Authentication context missing')
    }

    const data = await permissionSetService.create(venueId, req.body, userId)

    res.status(201).json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

export async function update(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId, id } = req.params
    const data = await permissionSetService.update(venueId, id, req.body)

    res.status(200).json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

export async function remove(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId, id } = req.params
    const data = await permissionSetService.remove(venueId, id)

    res.status(200).json({ success: true, data })
  } catch (error) {
    next(error)
  }
}

export async function duplicate(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId, id } = req.params
    const { userId } = (req as any).authContext

    if (!userId) {
      throw new AuthenticationError('Authentication context missing')
    }

    const { name } = req.body
    const data = await permissionSetService.duplicate(venueId, id, name, userId)

    res.status(201).json({ success: true, data })
  } catch (error) {
    next(error)
  }
}
