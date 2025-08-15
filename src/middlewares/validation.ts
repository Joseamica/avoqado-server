// src/middlewares/validation.ts
import { Request, Response, NextFunction } from 'express'
import { ZodError, z, AnyZodObject } from 'zod' // Import AnyZodObject
import AppError, { BadRequestError, InternalServerError } from '../errors/AppError'

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
      const errorMessages = parsedResult.error.errors.map(err => `${err.path.join('.')}: ${err.message}`).join(', ')
      return next(new BadRequestError(`Validation failed: ${errorMessages}`))
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
      const errorMessages = error.errors.map(err => `${err.path.join('.')}: ${err.message}`).join(', ')
      return next(new BadRequestError(`Validation failed during Zod processing: ${errorMessages}`))
    }
    return next(new InternalServerError('An unexpected error occurred during request validation.'))
  }
}
