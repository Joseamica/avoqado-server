// src/middlewares/validation.ts
import { Request, Response, NextFunction } from 'express'
import { AnyZodObject, ZodError } from 'zod'
import AppError from '../errors/AppError' // Assuming AppError is in src/errors

export const validateRequest = (schema: AnyZodObject) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    await schema.parseAsync({
      body: req.body,
      query: req.query,
      params: req.params,
    })
    return next()
  } catch (error) {
    if (error instanceof ZodError) {
      // Construct a more readable error message from Zod issues
      const errorMessages = error.errors.map(err => `${err.path.join('.')}: ${err.message}`).join(', ')
      return next(new AppError(`Validation failed: ${errorMessages}`, 400))
    }
    // For other unexpected errors
    return next(new AppError('An unexpected error occurred during validation.', 500))
  }
}
