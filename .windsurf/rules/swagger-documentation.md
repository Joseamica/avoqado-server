# Swagger Documentation Rule

## Rule ID
swagger-documentation-required

## Description
This rule ensures that all API routes are properly documented with OpenAPI/Swagger specifications.

## Files
- `src/routes/**/*.ts`

## Requirements
1. Every route definition must be preceded by an OpenAPI/Swagger documentation block
2. The documentation block must include:
   - `@openapi` tag
   - HTTP method and path
   - `tags` array
   - `summary`
   - `description`
   - `parameters` (if applicable)
   - `requestBody` (for POST/PUT/PATCH)
   - `responses` with at least 200 and error status codes
3. All request/response schemas must be defined in the `components/schemas` section

## Example

```typescript
/**
 * @openapi
 * /api/example:
 *   get:
 *     tags: [Example]
 *     summary: Get example data
 *     description: Returns example data from the server
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *         description: Number of items to return
 *     responses:
 *       200:
 *         description: Successful response
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ExampleResponse'
 *       400:
 *         $ref: '#/components/responses/BadRequest'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
router.get('/api/example', exampleController.handler);
```

## Error Messages
- `Missing Swagger documentation for route [%s]` - When a route is missing its Swagger documentation
- `Missing required field [%s] in Swagger documentation for [%s]` - When a required field is missing from the documentation
- `Invalid HTTP method in Swagger documentation for [%s]` - When an unsupported HTTP method is used

## Configuration
This rule can be configured in `.windsurfrules.json`:

```json
{
  "swagger-documentation-required": {
    "level": "error",
    "options": {
      "requireAuth": true,
      "requiredResponseCodes": [200, 400, 401, 403, 404, 500]
    }
  }
}
```

## Why This Matters
- Ensures API consistency and discoverability
- Improves developer experience with auto-generated documentation
- Helps maintain up-to-date API specifications
- Enables automated testing and client generation
- Reduces documentation drift
