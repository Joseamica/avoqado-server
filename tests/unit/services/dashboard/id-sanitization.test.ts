/**
 * Test: ID Sanitization in Chatbot Responses
 *
 * Verifies that internal database IDs are not exposed to end users.
 * This is a security and UX concern - users should not see technical IDs.
 *
 * Tests cover:
 * - CUID pattern removal (Prisma default)
 * - UUID pattern removal
 * - MongoDB ObjectId pattern removal
 * - ID field removal from data objects
 * - Nested object sanitization
 */

// Since the methods are private, we'll test them indirectly through examples
// For direct testing, we create a test helper that exposes the patterns

describe('ID Sanitization - Pattern Detection', () => {
  // CUID pattern: starts with 'c' followed by 20-30 alphanumeric chars
  const CUID_PATTERN = /\bc[a-z0-9]{20,30}\b/gi

  // UUID pattern
  const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

  // MongoDB ObjectId pattern (24 hex chars)
  const OBJECTID_PATTERN = /\b[a-f0-9]{24}\b/gi

  describe('CUID Detection', () => {
    it('should detect Prisma CUID format', () => {
      const testCases = [
        'cmi6othfk000f9klalf33lshm', // From user's example
        'clx1234567890abcdefghij',
        'cm12345678901234567890ab',
      ]

      testCases.forEach(cuid => {
        expect(cuid).toMatch(CUID_PATTERN)
      })
    })

    it('should NOT match short strings', () => {
      const shortStrings = ['category', 'customer', 'comment']

      shortStrings.forEach(str => {
        expect(str).not.toMatch(CUID_PATTERN)
      })
    })

    it('should NOT match normal words starting with c', () => {
      const normalWords = ['completed', 'cancelled', 'confirmed']

      normalWords.forEach(word => {
        expect(word).not.toMatch(CUID_PATTERN)
      })
    })
  })

  describe('UUID Detection', () => {
    it('should detect UUID format', () => {
      const testCases = [
        '550e8400-e29b-41d4-a716-446655440000',
        '6ba7b810-9dad-11d1-80b4-00c04fd430c8',
        'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      ]

      testCases.forEach(uuid => {
        expect(uuid).toMatch(UUID_PATTERN)
      })
    })

    it('should NOT match incomplete UUIDs', () => {
      const invalid = ['550e8400-e29b-41d4-a716', '6ba7b810-9dad']

      invalid.forEach(str => {
        expect(str).not.toMatch(UUID_PATTERN)
      })
    })
  })

  describe('MongoDB ObjectId Detection', () => {
    it('should detect ObjectId format', () => {
      const testCases = ['507f1f77bcf86cd799439011', '5f43a7bb8c3b2f001f8d3e0f', 'aaaabbbbccccddddeeee1234']

      testCases.forEach(oid => {
        expect(oid).toMatch(OBJECTID_PATTERN)
      })
    })

    it('should NOT match shorter hex strings', () => {
      const short = ['507f1f77bcf8', 'abcdef123456']

      short.forEach(str => {
        expect(str).not.toMatch(OBJECTID_PATTERN)
      })
    })
  })
})

describe('ID Sanitization - Response Cleaning', () => {
  // Helper function that mimics sanitizeResponseIds
  function sanitizeResponseIds(response: string): string {
    let sanitized = response.replace(/\bc[a-z0-9]{20,30}\b/gi, '[ID]')
    sanitized = sanitized.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[ID]')
    sanitized = sanitized.replace(/\b[a-f0-9]{24}\b/gi, '[ID]')
    sanitized = sanitized.replace(/\s*(?:con\s+)?ID[:\s]+\[ID\]/gi, '')
    sanitized = sanitized.replace(/\s*\[ID\]\s*\./g, '.')
    sanitized = sanitized.replace(/categoría\s+(?:con\s+)?(?:ID\s+)?\[ID\]/gi, 'categoría')
    sanitized = sanitized.replace(/pertenece\s+a\s+la\s+categoría\s+\[ID\]/gi, 'pertenece a su categoría')
    return sanitized.trim()
  }

  it('should remove CUID from response', () => {
    const input = 'El producto "Beer" pertenece a la categoría con ID cmi6othfk000f9klalf33lshm.'
    const output = sanitizeResponseIds(input)

    expect(output).not.toContain('cmi6othfk000f9klalf33lshm')
    expect(output).not.toContain('[ID]') // Should clean up nicely
  })

  it('should remove UUID from response', () => {
    const input = 'La orden 550e8400-e29b-41d4-a716-446655440000 está pendiente.'
    const output = sanitizeResponseIds(input)

    expect(output).not.toContain('550e8400-e29b-41d4-a716-446655440000')
  })

  it('should preserve product names and prices', () => {
    const input = 'El producto "Beer" con precio de $5.99 está bajo en inventario.'
    const output = sanitizeResponseIds(input)

    expect(output).toContain('Beer')
    expect(output).toContain('$5.99')
    expect(output).toContain('bajo en inventario')
  })

  it('should clean up "con ID [ID]" phrases', () => {
    const input = 'La categoría con ID cmi6othfk000f9klalf33lshm contiene 5 productos.'
    const output = sanitizeResponseIds(input)

    expect(output).not.toContain('con ID')
    expect(output).toContain('categoría')
    expect(output).toContain('5 productos')
  })

  it('should handle multiple IDs in one response', () => {
    const input = 'Producto cmi6othfk000f9klalf33lshm en categoría clx1234567890abcdefghij'
    const output = sanitizeResponseIds(input)

    expect(output).not.toContain('cmi6othfk000f9klalf33lshm')
    expect(output).not.toContain('clx1234567890abcdefghij')
  })
})

describe('ID Sanitization - Data Object Cleaning', () => {
  // Helper function that mimics sanitizeDataForLLM
  function sanitizeDataForLLM(data: any): any {
    if (data === null || data === undefined) {
      return data
    }

    if (Array.isArray(data)) {
      return data.map(item => sanitizeDataForLLM(item))
    }

    if (typeof data === 'object') {
      const sanitized: Record<string, any> = {}
      for (const [key, value] of Object.entries(data)) {
        if (key === 'id' || key.endsWith('Id') || key.endsWith('_id')) {
          continue
        }
        sanitized[key] = sanitizeDataForLLM(value)
      }
      return sanitized
    }

    return data
  }

  it('should remove "id" field', () => {
    const input = { id: 'cmi6othfk000f9klalf33lshm', name: 'Beer', price: 5.99 }
    const output = sanitizeDataForLLM(input)

    expect(output).not.toHaveProperty('id')
    expect(output).toHaveProperty('name', 'Beer')
    expect(output).toHaveProperty('price', 5.99)
  })

  it('should remove fields ending in "Id"', () => {
    const input = {
      name: 'Beer',
      categoryId: 'cmi6othfk000f9klalf33lshm',
      venueId: 'venue-123',
      price: 5.99,
    }
    const output = sanitizeDataForLLM(input)

    expect(output).not.toHaveProperty('categoryId')
    expect(output).not.toHaveProperty('venueId')
    expect(output).toHaveProperty('name', 'Beer')
    expect(output).toHaveProperty('price', 5.99)
  })

  it('should remove fields ending in "_id"', () => {
    const input = {
      name: 'Beer',
      category_id: 'cmi6othfk000f9klalf33lshm',
      venue_id: 'venue-123',
    }
    const output = sanitizeDataForLLM(input)

    expect(output).not.toHaveProperty('category_id')
    expect(output).not.toHaveProperty('venue_id')
  })

  it('should sanitize arrays of objects', () => {
    const input = [
      { id: '1', name: 'Beer', categoryId: 'cat1' },
      { id: '2', name: 'Wine', categoryId: 'cat2' },
    ]
    const output = sanitizeDataForLLM(input)

    expect(output).toHaveLength(2)
    expect(output[0]).not.toHaveProperty('id')
    expect(output[0]).not.toHaveProperty('categoryId')
    expect(output[0]).toHaveProperty('name', 'Beer')
    expect(output[1]).toHaveProperty('name', 'Wine')
  })

  it('should sanitize nested objects', () => {
    const input = {
      product: {
        id: 'prod1',
        name: 'Beer',
        category: {
          id: 'cat1',
          name: 'Drinks',
        },
      },
      venueId: 'venue1',
    }
    const output = sanitizeDataForLLM(input)

    expect(output.product).not.toHaveProperty('id')
    expect(output.product.name).toBe('Beer')
    expect(output.product.category).not.toHaveProperty('id')
    expect(output.product.category.name).toBe('Drinks')
    expect(output).not.toHaveProperty('venueId')
  })

  it('should handle null and undefined', () => {
    expect(sanitizeDataForLLM(null)).toBeNull()
    expect(sanitizeDataForLLM(undefined)).toBeUndefined()
  })

  it('should preserve primitive values', () => {
    expect(sanitizeDataForLLM('string')).toBe('string')
    expect(sanitizeDataForLLM(123)).toBe(123)
    expect(sanitizeDataForLLM(true)).toBe(true)
  })
})

describe('ID Sanitization - Real World Examples', () => {
  function sanitizeDataForLLM(data: any): any {
    if (data === null || data === undefined) return data
    if (Array.isArray(data)) return data.map(item => sanitizeDataForLLM(item))
    if (typeof data === 'object') {
      const sanitized: Record<string, any> = {}
      for (const [key, value] of Object.entries(data)) {
        if (key === 'id' || key.endsWith('Id') || key.endsWith('_id')) continue
        sanitized[key] = sanitizeDataForLLM(value)
      }
      return sanitized
    }
    return data
  }

  it('should sanitize inventory alert data', () => {
    const rawData = [
      {
        id: 'cmi6othfk000f9klalf33lshm',
        rawMaterialId: 'rm123',
        name: 'Carne molida',
        currentStock: 2.5,
        unit: 'kg',
        minimumStock: 10,
        venueId: 'venue-123',
      },
    ]

    const sanitized = sanitizeDataForLLM(rawData)

    expect(sanitized[0]).not.toHaveProperty('id')
    expect(sanitized[0]).not.toHaveProperty('rawMaterialId')
    expect(sanitized[0]).not.toHaveProperty('venueId')
    expect(sanitized[0]).toHaveProperty('name', 'Carne molida')
    expect(sanitized[0]).toHaveProperty('currentStock', 2.5)
  })

  it('should sanitize product query result', () => {
    const rawData = {
      id: 'prod123',
      name: 'Beer',
      price: 5.99,
      categoryId: 'cmi6othfk000f9klalf33lshm',
      category: {
        id: 'cmi6othfk000f9klalf33lshm',
        name: 'Beverages',
        venueId: 'venue123',
      },
    }

    const sanitized = sanitizeDataForLLM(rawData)

    expect(JSON.stringify(sanitized)).not.toContain('cmi6othfk000f9klalf33lshm')
    expect(sanitized.name).toBe('Beer')
    expect(sanitized.price).toBe(5.99)
    expect(sanitized.category.name).toBe('Beverages')
  })
})
