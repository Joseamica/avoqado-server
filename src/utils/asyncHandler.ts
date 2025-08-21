import { Request, Response, NextFunction } from 'express'

/**
 * Async handler wrapper to catch async function errors
 * and pass them to Express error handler
 */
export const asyncHandler = (fn: (req: Request, res: Response, next: NextFunction) => Promise<any>) => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next)
  }
}

export default asyncHandler
