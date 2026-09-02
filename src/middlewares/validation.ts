// src/middlewares/validation.ts
import { NextFunction, Request, Response } from 'express'
import { AnyZodObject, ZodError, z } from 'zod' // Import AnyZodObject
import { BadRequestError, InternalServerError } from '../errors/AppError'

export const validateRequest = (schema: AnyZodObject) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Construct an object that mirrors the expected structure of the schema,
    // using the actual request parts.
    // For example, if schema is z.object({ query: querySchema, body: bodySchema }),
    // dataToParse will be { query: req.query, body: req.body }.
    const dataToParse: Record<string, any> = {}
    if (schema instanceof z.ZodObject) {
      if (schema.shape.body) {
        dataToParse.body = req.body
      }
      if (schema.shape.query) {
        dataToParse.query = req.query
      }
      if (schema.shape.params) {
        dataToParse.params = req.params
      }
      // Conditional-write APIs use HTTP validators such as If-Match. Keep
      // headers opt-in so existing schemas and request normalization remain
      // unchanged, while allowing Zod to reject stale/malformed validators
      // before authorization or mutation handlers run.
      if (schema.shape.headers) {
        dataToParse.headers = req.headers
      }
    } else {
      // If the schema is not a ZodObject (e.g., a direct schema for req.body without nesting),
      // this basic implementation might need adjustment or a more specific schema type.
      // For now, we assume the schema is an object containing keys like 'body', 'query', 'params'.
      // This case should ideally not be hit if schemas are structured as z.object({ query: ..., body: ...}).
      return next(
        new InternalServerError('Validation schema is not structured as expected (e.g., z.object containing body/query/params keys)).'),
      )
    }

    const parsedResult = await schema.safeParseAsync(dataToParse)

    if (!parsedResult.success) {
      // Fase 0.B: un schema puede marcar un issue con `params.code` para que el 400 salga
      // con ese código (hoy: CUSTOMER_ID_NOT_ALLOWED). El primero que aparezca gana.
      const codedIssue = parsedResult.error.errors.find(e => e.code === 'custom' && (e as any).params?.code)
      if (codedIssue) {
        return next(new BadRequestError(codedIssue.message, (codedIssue as any).params.code))
      }
      const errorMessages = parsedResult.error.errors
        .map(err => {
          // Strip internal path prefixes (body., query., params.) — users don't need to see these
          const path = err.path.filter(p => p !== 'body' && p !== 'query' && p !== 'params')
          const prefix = path.length > 0 ? `${path.join('.')}: ` : ''
          return `${prefix}${err.message}`
        })
        .join(', ')
      return next(new BadRequestError(`Error de validación: ${errorMessages}`))
    }

    // Assign the successfully parsed (and potentially transformed) data back to req.
    // parsedResult.data will be an object like: { query: { page: 1, ... }, body: { name: '...' } }
    // (only including keys that were part of the input schema and successfully parsed).
    if (parsedResult.data.body !== undefined) {
      req.body = parsedResult.data.body
    }
    if (parsedResult.data.query !== undefined) {
      req.query = parsedResult.data.query as any // Cast to allow assignment
    }
    if (parsedResult.data.params !== undefined) {
      req.params = parsedResult.data.params as any // Cast to allow assignment
    }

    return next()
  } catch (error) {
    if (error instanceof ZodError) {
      // This catch block might be redundant if safeParseAsync handles all ZodErrors from the parse call itself,
      // but good for other ZodErrors that might occur if schema manipulation was more complex.
      const errorMessages = error.errors
        .map(err => {
          const path = err.path.filter(p => p !== 'body' && p !== 'query' && p !== 'params')
          const prefix = path.length > 0 ? `${path.join('.')}: ` : ''
          return `${prefix}${err.message}`
        })
        .join(', ')
      return next(new BadRequestError(`Error de validación: ${errorMessages}`))
    }
    return next(new InternalServerError('An unexpected error occurred during request validation.'))
  }
}
