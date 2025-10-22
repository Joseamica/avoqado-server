/**
 * Menu CSV Parser & Validator
 *
 * Parses CSV files containing menu data (categories and products) for onboarding.
 * Validates data integrity and returns structured results with errors.
 *
 * Expected CSV Format:
 * categoria,nombre,descripcion,precio,tipo,sku
 * Bebidas,Café Americano,Café negro tradicional,35.00,FOOD,CAFE-001
 * Bebidas,Cappuccino,Café con leche espumada,45.00,BEVERAGE,CAFE-002
 */

import Papa from 'papaparse'
import { ProductType } from '@prisma/client'
import { generateSlug as slugify } from './slugify'

// Types
export interface MenuCSVRow {
  categoria: string
  nombre: string
  descripcion?: string
  precio: string | number
  tipo?: string
  sku?: string
}

export interface ParsedCategory {
  name: string
  slug: string
  description?: string
}

export interface ParsedProduct {
  name: string
  sku: string
  description?: string
  price: number
  type: ProductType
  categorySlug: string
}

export interface MenuCSVParseResult {
  categories: ParsedCategory[]
  products: ParsedProduct[]
  errors: string[]
  warnings: string[]
  totalRows: number
  validRows: number
}

/**
 * Valid product types (from Prisma schema)
 */
const VALID_PRODUCT_TYPES: ProductType[] = ['FOOD', 'BEVERAGE', 'ALCOHOL', 'RETAIL', 'SERVICE', 'OTHER']

/**
 * Parses a menu CSV file and validates the data
 *
 * @param fileContent - CSV file content as string or Buffer
 * @returns Parsed and validated menu data with errors
 *
 * @example
 * const result = await parseMenuCSV(csvFileBuffer)
 * if (result.errors.length === 0) {
 *   // All rows valid, proceed with creation
 *   await createCategories(result.categories)
 *   await createProducts(result.products)
 * }
 */
export async function parseMenuCSV(fileContent: string | Buffer): Promise<MenuCSVParseResult> {
  const content = typeof fileContent === 'string' ? fileContent : fileContent.toString('utf-8')

  const result: MenuCSVParseResult = {
    categories: [],
    products: [],
    errors: [],
    warnings: [],
    totalRows: 0,
    validRows: 0,
  }

  // Parse CSV with papaparse
  const parseResult = Papa.parse<MenuCSVRow>(content, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header: string) => header.trim().toLowerCase(),
  })

  result.totalRows = parseResult.data.length

  // Check for parsing errors
  if (parseResult.errors.length > 0) {
    parseResult.errors.forEach(error => {
      result.errors.push(`CSV parse error at row ${error.row}: ${error.message}`)
    })
  }

  // Track categories to avoid duplicates
  const categoriesMap = new Map<string, ParsedCategory>()

  // Process each row
  parseResult.data.forEach((row, index) => {
    const rowNumber = index + 2 // +2 because: +1 for 0-index, +1 for header row

    try {
      // Validate required fields
      const validationErrors = validateRow(row, rowNumber)
      if (validationErrors.length > 0) {
        result.errors.push(...validationErrors)
        return // Skip this row
      }

      // Parse and normalize data
      const categoryName = row.categoria.trim()
      const productName = row.nombre.trim()
      const description = row.descripcion?.trim()
      const price = parseFloat(String(row.precio).replace(/[^0-9.]/g, ''))
      const type = (row.tipo?.toUpperCase() || 'FOOD') as ProductType
      const sku = row.sku?.trim() || generateSKU(productName)

      // Validate product type
      if (!VALID_PRODUCT_TYPES.includes(type)) {
        result.warnings.push(`Fila ${rowNumber}: Tipo "${row.tipo}" no válido, usando FOOD por defecto`)
      }

      // Create/get category
      const categorySlug = slugify(categoryName)
      if (!categoriesMap.has(categorySlug)) {
        categoriesMap.set(categorySlug, {
          name: categoryName,
          slug: categorySlug,
          description: undefined, // Can be added later
        })
      }

      // Add product
      result.products.push({
        name: productName,
        sku,
        description,
        price,
        type: VALID_PRODUCT_TYPES.includes(type) ? type : 'FOOD',
        categorySlug,
      })

      result.validRows++
    } catch (error) {
      result.errors.push(`Fila ${rowNumber}: Error inesperado - ${error instanceof Error ? error.message : 'Error desconocido'}`)
    }
  })

  // Convert categories map to array
  result.categories = Array.from(categoriesMap.values())

  // Add summary warnings
  if (result.validRows === 0 && result.totalRows > 0) {
    result.errors.push('No se pudo procesar ninguna fila válida del CSV')
  } else if (result.validRows < result.totalRows) {
    result.warnings.push(
      `Se procesaron ${result.validRows} de ${result.totalRows} filas. ${result.totalRows - result.validRows} filas tuvieron errores.`,
    )
  }

  return result
}

/**
 * Validates a single CSV row
 *
 * @param row - CSV row data
 * @param rowNumber - Row number for error messages
 * @returns Array of error messages (empty if valid)
 */
function validateRow(row: MenuCSVRow, rowNumber: number): string[] {
  const errors: string[] = []

  // Required: categoria
  if (!row.categoria || row.categoria.trim() === '') {
    errors.push(`Fila ${rowNumber}: Falta el campo "categoria"`)
  }

  // Required: nombre
  if (!row.nombre || row.nombre.trim() === '') {
    errors.push(`Fila ${rowNumber}: Falta el campo "nombre"`)
  }

  // Required: precio
  if (!row.precio || row.precio === '') {
    errors.push(`Fila ${rowNumber}: Falta el campo "precio"`)
  } else {
    const price = parseFloat(String(row.precio).replace(/[^0-9.]/g, ''))
    if (isNaN(price) || price <= 0) {
      errors.push(`Fila ${rowNumber}: Precio inválido "${row.precio}". Debe ser un número mayor a 0`)
    }
  }

  return errors
}

/**
 * Generates a SKU from product name if not provided
 *
 * @param productName - Product name
 * @returns Generated SKU (uppercase, alphanumeric, max 20 chars)
 *
 * @example
 * generateSKU('Café Americano') // 'CAFE-AMERICANO-12AB'
 */
function generateSKU(productName: string): string {
  // Remove accents and special characters
  const normalized = productName
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .substring(0, 16)

  // Add random suffix for uniqueness
  const suffix = Math.random().toString(36).substring(2, 6).toUpperCase()

  return `${normalized}-${suffix}`
}

/**
 * Generates a downloadable CSV template for menu import
 *
 * @returns CSV template as string
 */
export function generateMenuCSVTemplate(): string {
  const headers = ['categoria', 'nombre', 'descripcion', 'precio', 'tipo', 'sku']
  const examples = [
    ['Bebidas Calientes', 'Café Americano', 'Café negro tradicional', '35.00', 'BEVERAGE', 'CAFE-001'],
    ['Bebidas Calientes', 'Cappuccino', 'Café con leche espumada', '45.00', 'BEVERAGE', 'CAFE-002'],
    ['Bebidas Calientes', 'Té Chai', 'Té especiado con leche', '40.00', 'BEVERAGE', ''],
    ['Alimentos', 'Croissant', 'Croissant de mantequilla', '30.00', 'FOOD', 'FOOD-001'],
    ['Alimentos', 'Sandwich Club', 'Sandwich de pollo, tocino y aguacate', '85.00', 'FOOD', ''],
  ]

  // Build CSV
  const rows = [headers, ...examples]
  return Papa.unparse(rows, {
    header: false,
    quotes: true,
  })
}

/**
 * Validates menu CSV structure without parsing full content
 * Useful for quick validation before upload
 *
 * @param fileContent - CSV file content
 * @returns Validation result with basic checks
 */
export function validateMenuCSVStructure(fileContent: string | Buffer): {
  valid: boolean
  errors: string[]
} {
  const content = typeof fileContent === 'string' ? fileContent : fileContent.toString('utf-8')

  const errors: string[] = []

  // Parse only first row to check headers
  const parseResult = Papa.parse<MenuCSVRow>(content, {
    header: true,
    preview: 1,
    transformHeader: (header: string) => header.trim().toLowerCase(),
  })

  // Check for required headers
  const requiredHeaders = ['categoria', 'nombre', 'precio']
  const headers = parseResult.meta.fields || []

  requiredHeaders.forEach(required => {
    if (!headers.includes(required)) {
      errors.push(`Falta el encabezado requerido: "${required}"`)
    }
  })

  // Check if file is empty
  if (content.trim().length === 0) {
    errors.push('El archivo CSV está vacío')
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}
