import type { NextFunction, Request, RequestHandler, Response } from 'express'
import { getContext, runWithContext } from './executionContext'

/**
 * Wraps a middleware that would otherwise lose the execution context.
 *
 *   ❌ documentUpload.single('file')
 *   ✅ preserveContext(documentUpload.single('file'))
 *
 * Multer resumes the request from the body stream, and that stream's async resource was
 * created by the HTTP server BEFORE the request logger opened the context — so control comes
 * back outside it. Everything downstream then logs without a venue: measured in production,
 * the two KYC uploads in a 15-minute window were the only 2 of 139 requests whose logs
 * carried no tenant at all, which is exactly when an error message needs one.
 *
 * The fix is to capture the context on the way in and re-enter it when the wrapped
 * middleware calls `next()`. That covers the success path and the error path alike — an
 * upload that fails is the case that actually gets read in an alert.
 *
 * Deliberately transparent, same contract as `runWithContext`: the error is passed straight
 * through to `next(err)`, never swallowed and never reinterpreted. A wrapper that ate an
 * exception would turn observability into the cause of the next invisible bug.
 *
 * A no-op when no context is active (a script, a test, a route mounted before the logger):
 * restoring nothing is correct, inventing a context would be a lie.
 */
export function preserveContext(middleware: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const context = getContext()
    if (!context) return middleware(req, res, next)

    return middleware(req, res, (error?: unknown) => runWithContext(context, () => next(error)))
  }
}
