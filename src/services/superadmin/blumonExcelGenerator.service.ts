/**
 * Blumon Excel Generator Service
 *
 * Extracts KYC data from documents using Claude Vision and generates
 * the Blumon merchant onboarding Excel file.
 *
 * Cost: ~$0.015 USD (~$0.30 MXN) per merchant
 *
 * Documents processed:
 * - Constancia de Situación Fiscal (CSF) → RFC, Razón Social, Dirección, Giro
 * - INE/IFE → Representante Legal name
 *
 * Optimizations applied:
 * - Reduced image resolution (1.5x vs 2x) → 40% less tokens
 * - Max 2 pages per PDF → 33% less tokens
 * - Haiku for MCC suggestion → 80% cheaper
 * - Pre-filtered MCCs → 90% less tokens
 */

import Anthropic from '@anthropic-ai/sdk'
import type { ImageBlockParam } from '@anthropic-ai/sdk/resources/messages'
import { pdf } from 'pdf-to-img'
import * as XLSX from 'xlsx'
import logger from '@/config/logger'
import { getStorage } from 'firebase-admin/storage'
import { buildStoragePath } from '@/services/storage.service'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeFileSync, unlinkSync } from 'fs'
import { randomUUID } from 'crypto'

type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

// Initialize Anthropic client
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) : null

// MCC codes for merchant classification
const MCC_DATA: Array<{ code: number; description: string }> = [
  // Restaurants & Food
  { code: 5812, description: 'Eating Places and Restaurants' },
  { code: 5813, description: 'Drinking Places (Bars, Taverns, Nightclubs)' },
  { code: 5814, description: 'Fast Food Restaurants' },
  // Telecom
  { code: 4812, description: 'Telecommunications Equipment' },
  { code: 4813, description: 'Key-entry Telecom Merchant' },
  { code: 4814, description: 'Telecommunication Services' },
  { code: 4816, description: 'Computer Network Services' },
  // Retail
  { code: 5311, description: 'Department Stores' },
  { code: 5411, description: 'Grocery Stores and Supermarkets' },
  { code: 5541, description: 'Service Stations' },
  { code: 5651, description: 'Family Clothing Stores' },
  { code: 5691, description: 'Mens and Womens Clothing Stores' },
  { code: 5732, description: 'Electronics Stores' },
  { code: 5912, description: 'Drug Stores and Pharmacies' },
  { code: 5999, description: 'Miscellaneous and Specialty Retail' },
  // Services
  { code: 7011, description: 'Lodging - Hotels, Motels, Resorts' },
  { code: 7230, description: 'Beauty and Barber Shops' },
  { code: 7298, description: 'Health and Beauty Spas' },
  { code: 7311, description: 'Advertising Services' },
  { code: 7392, description: 'Consulting Services' },
  { code: 7399, description: 'Business Services' },
  { code: 7512, description: 'Automobile Rental Agency' },
  { code: 7841, description: 'Video Entertainment Rental' },
  { code: 7911, description: 'Dance Halls, Studios, Schools' },
  { code: 7941, description: 'Athletic Fields, Sports' },
  { code: 7991, description: 'Tourist Attractions and Exhibits' },
  { code: 7997, description: 'Recreation Services' },
  { code: 8011, description: 'Doctors' },
  { code: 8021, description: 'Dentists, Orthodontists' },
  { code: 8031, description: 'Osteopaths' },
  { code: 8041, description: 'Chiropractors' },
  { code: 8042, description: 'Optometrists, Ophthalmologists' },
  { code: 8049, description: 'Podiatrists, Chiropodists' },
  { code: 8050, description: 'Nursing/Personal Care' },
  { code: 8062, description: 'Hospitals' },
  { code: 8099, description: 'Medical Services, Health' },
  { code: 8111, description: 'Legal Services, Attorneys' },
  { code: 8211, description: 'Elementary, Secondary Schools' },
  { code: 8220, description: 'Colleges, Universities' },
  { code: 8299, description: 'Schools and Educational Services' },
  { code: 8351, description: 'Child Care Services' },
  { code: 8398, description: 'Charitable Organizations' },
  { code: 8641, description: 'Civic, Social, Fraternal Associations' },
  { code: 8675, description: 'Automobile Associations' },
  { code: 8699, description: 'Membership Organizations' },
  { code: 8734, description: 'Testing Laboratories' },
  { code: 8911, description: 'Architectural, Engineering Services' },
  { code: 8931, description: 'Accounting, Auditing, Bookkeeping' },
  { code: 8999, description: 'Professional Services' },
]

interface BlumonData {
  movimiento: string
  activaAfiliacion: string
  klu: string
  nombreComercial: string
  tipoPersona: string
  razonSocial: string
  rfc: string
  representanteLegal: string
  direccion: string
  cp: string
  colonia: string
  poblacionAlcaldia: string
  estado: string
  lada: string
  telefono: string
  correoElectronico: string
  mcc: string
  descripcionGiro: string
  operativa: string
  latitud: string
  longitud: string
  paginaWeb: string
  riesgo: string
  estatus: string
  comentarios: string
  altaTPV: string
}

interface _VenueData {
  telefono?: string
  correoElectronico?: string
  lada?: string
  representanteLegal?: string
  paginaWeb?: string
}

const EXTRACTION_PROMPT = `Extrae datos de este documento mexicano (CSF, Acta, INE) en JSON.
Campos vacíos = "". RFC completo. Tipo: "FISICA" o "MORAL".

{
  "nombreComercial": "",
  "tipoPersona": "",
  "razonSocial": "",
  "rfc": "",
  "representanteLegal": "",
  "direccion": "",
  "cp": "",
  "colonia": "",
  "poblacionAlcaldia": "",
  "estado": "",
  "telefono": "",
  "correoElectronico": "",
  "descripcionGiro": ""
}

Solo JSON, sin explicaciones.`

const INE_EXTRACTION_PROMPT = `Extrae el nombre completo de la persona en esta identificación oficial mexicana (INE/IFE).

Responde SOLO con JSON:
{
  "nombreCompleto": "nombre completo como aparece en la identificación"
}

Solo JSON, sin explicaciones.`

/**
 * Download file from Firebase Storage URL to temp file
 */
async function downloadFromFirebase(url: string): Promise<string | null> {
  try {
    const response = await fetch(url)
    if (!response.ok) {
      logger.warn(`Failed to download from Firebase: ${response.status}`)
      return null
    }

    const buffer = Buffer.from(await response.arrayBuffer())
    const tempPath = join(tmpdir(), `kyc-${randomUUID()}.pdf`)
    writeFileSync(tempPath, buffer)
    return tempPath
  } catch (error) {
    logger.error('Error downloading from Firebase:', error)
    return null
  }
}

/**
 * Convert PDF to images for Claude Vision
 */
async function convertPdfToImages(pdfPath: string, maxPages = 2): Promise<ImageBlockParam[]> {
  const images: ImageBlockParam[] = []

  try {
    const document = await pdf(pdfPath, { scale: 1.5 })

    let pageNum = 0
    for await (const image of document) {
      images.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png' as const,
          data: image.toString('base64'),
        },
      })
      pageNum++
      if (pageNum >= maxPages) break
    }
  } catch (error) {
    logger.error('Error converting PDF to images:', error)
  }

  return images
}

/**
 * Convert image file to base64 for Claude Vision
 */
async function convertImageToBase64(imagePath: string): Promise<ImageBlockParam[]> {
  try {
    const response = await fetch(imagePath)
    const buffer = Buffer.from(await response.arrayBuffer())

    // Detect media type from URL or default to jpeg
    let mediaType: ImageMediaType = 'image/jpeg'
    if (imagePath.includes('.png')) mediaType = 'image/png'
    else if (imagePath.includes('.webp')) mediaType = 'image/webp'

    return [
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: mediaType,
          data: buffer.toString('base64'),
        },
      },
    ]
  } catch (error) {
    logger.error('Error converting image to base64:', error)
    return []
  }
}

/**
 * Check if URL is an image (not PDF)
 */
function isImageUrl(url: string): boolean {
  const lower = url.toLowerCase()
  return lower.includes('.png') || lower.includes('.jpg') || lower.includes('.jpeg') || lower.includes('.webp')
}

/**
 * Extract data from CSF document using Claude Vision
 */
async function extractFromCSF(csfUrl: string): Promise<Partial<BlumonData>> {
  if (!anthropic) {
    logger.warn('Anthropic not configured, skipping CSF extraction')
    return {}
  }

  logger.info('📄 Extracting data from CSF...')

  let images: ImageBlockParam[]

  // Check if it's an image or PDF
  if (isImageUrl(csfUrl)) {
    logger.info('   CSF is an image, processing directly...')
    images = await convertImageToBase64(csfUrl)
  } else {
    // It's a PDF, download and convert
    const tempPath = await downloadFromFirebase(csfUrl)
    if (!tempPath) return {}

    try {
      images = await convertPdfToImages(tempPath, 2)
    } finally {
      // Cleanup temp file
      try {
        unlinkSync(tempPath)
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  if (images.length === 0) {
    logger.warn('No images extracted from CSF')
    return {}
  }

  logger.info(`   Sending ${images.length} page(s) to Claude...`)

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1000,
    messages: [
      {
        role: 'user',
        content: [...images, { type: 'text', text: EXTRACTION_PROMPT }],
      },
    ],
  })

  const inputTokens = response.usage?.input_tokens || 0
  const outputTokens = response.usage?.output_tokens || 0
  logger.info(`   Tokens: ${inputTokens} in + ${outputTokens} out = ${inputTokens + outputTokens} total`)

  const content = response.content[0]
  if (content.type !== 'text') return {}

  let jsonStr = content.text.trim()
  jsonStr = jsonStr.replace(/```json\n?/g, '').replace(/```\n?/g, '')

  try {
    const data = JSON.parse(jsonStr)
    logger.info('   ✅ CSF data extracted successfully')
    return data
  } catch {
    logger.warn('   ⚠️ Failed to parse CSF JSON')
    return {}
  }
}

/**
 * Extract representative name from INE using Claude Vision
 */
async function extractFromINE(ineUrl: string): Promise<string> {
  if (!anthropic) {
    logger.warn('Anthropic not configured, skipping INE extraction')
    return ''
  }

  logger.info('📄 Extracting name from INE...')

  try {
    const images = await convertImageToBase64(ineUrl)
    if (images.length === 0) {
      logger.warn('Failed to load INE image')
      return ''
    }

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      messages: [
        {
          role: 'user',
          content: [...images, { type: 'text', text: INE_EXTRACTION_PROMPT }],
        },
      ],
    })

    const inputTokens = response.usage?.input_tokens || 0
    const outputTokens = response.usage?.output_tokens || 0
    logger.info(`   Tokens INE: ${inputTokens} in + ${outputTokens} out`)

    const content = response.content[0]
    if (content.type !== 'text') return ''

    let jsonStr = content.text.trim()
    jsonStr = jsonStr.replace(/```json\n?/g, '').replace(/```\n?/g, '')

    try {
      const data = JSON.parse(jsonStr)
      logger.info(`   ✅ INE name: ${data.nombreCompleto}`)
      return data.nombreCompleto || ''
    } catch {
      return ''
    }
  } catch (error) {
    logger.error('Error extracting from INE:', error)
    return ''
  }
}

/**
 * Suggest MCC code based on business description using Haiku
 */
async function suggestMCC(giroDescription: string): Promise<{ mcc: string; descripcion: string }> {
  if (!anthropic || !giroDescription) {
    return { mcc: '', descripcion: '' }
  }

  logger.info('🔍 Suggesting MCC...')

  // Pre-filter relevant MCCs
  const keywords = giroDescription.toLowerCase().split(/\s+/)
  let relevantMccs = MCC_DATA.filter(m => {
    const desc = m.description.toLowerCase()
    return keywords.some(kw => kw.length > 3 && desc.includes(kw))
  })

  // If no matches, use common MCCs
  if (relevantMccs.length === 0) {
    relevantMccs = MCC_DATA.slice(0, 20)
  }

  const mccList = relevantMccs.map(m => `${m.code}: ${m.description}`).join('\n')

  try {
    const response = await anthropic.messages.create({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 200,
      messages: [
        {
          role: 'user',
          content: `Giro: "${giroDescription}"

MCCs:
${mccList}

Responde JSON: {"mcc": "código", "descripcion": "descripción corta español"}`,
        },
      ],
    })

    const inputTokens = response.usage?.input_tokens || 0
    const outputTokens = response.usage?.output_tokens || 0
    logger.info(`   Tokens MCC: ${inputTokens} in + ${outputTokens} out`)

    const content = response.content[0]
    if (content.type !== 'text') return { mcc: '', descripcion: '' }

    let jsonStr = content.text.trim()
    jsonStr = jsonStr.replace(/```json\n?/g, '').replace(/```\n?/g, '')

    try {
      const result = JSON.parse(jsonStr)
      const mcc = result.mcc || result.mcc_principal || ''
      const descripcion = result.descripcion || result.description || ''
      logger.info(`   ✅ MCC: ${mcc} - ${descripcion}`)
      return { mcc: String(mcc), descripcion }
    } catch {
      // Fallback: extract MCC with regex
      const mccMatch = jsonStr.match(/\d{4}/)
      if (mccMatch) {
        logger.info(`   ✅ MCC (regex): ${mccMatch[0]}`)
        return { mcc: mccMatch[0], descripcion: '' }
      }
      return { mcc: '', descripcion: '' }
    }
  } catch (error) {
    logger.error('Error suggesting MCC:', error)
    return { mcc: '', descripcion: '' }
  }
}

/**
 * Geocode address to get lat/lng
 */
async function geocodeAddress(direccion: string, colonia: string, cp: string, estado: string): Promise<{ lat: string; lng: string }> {
  if (!direccion || !estado) return { lat: '', lng: '' }

  const normalize = (str: string) =>
    str
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/PISO \d+/gi, '')
      .replace(/\s+/g, ' ')
      .trim()

  const searches = [
    [direccion, colonia, cp, estado, 'Mexico'],
    [direccion, colonia, 'Mexico'],
    [direccion, cp, estado, 'Mexico'],
  ]

  for (const parts of searches) {
    const cleanAddress = parts.filter(Boolean).map(normalize).join(', ')

    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(cleanAddress)}&limit=1&countrycodes=mx`
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Avoqado-KYC/1.0' },
      })
      const data = (await response.json()) as Array<{ lat: string; lon: string }>

      if (data?.length > 0) {
        logger.info(`   ✅ Geocoded: ${data[0].lat}, ${data[0].lon}`)
        return { lat: data[0].lat, lng: data[0].lon }
      }
      await new Promise(r => setTimeout(r, 300))
    } catch {
      // Ignore geocoding errors, will retry
    }
  }

  logger.warn('   ⚠️ Geocoding failed')
  return { lat: '', lng: '' }
}

/**
 * Generate Blumon Excel file
 */
function generateExcel(data: BlumonData): Buffer {
  const wb = XLSX.utils.book_new()

  const headers = [
    'MOVIMIENTO',
    'ACTIVA AFILIACIÓN',
    'KLU',
    'NOMBRE COMERCIAL',
    'TIPO DE PERSONA',
    'RAZON SOCIAL',
    'RFC',
    'REPRESENTANTE LEGAL',
    'DIRECCIÓN',
    'CP',
    'COLONIA',
    'POBLACION/ALCALDÍA',
    'ESTADO',
    'LADA',
    'TELEFONO',
    'CORREO ELECTRÓNICO',
    'MCC',
    'DESCRIPCION DE GIRO',
    'OPERATIVA',
    'LATITUD',
    'LONGITUD',
    'PÁGINA WEB',
    'RIESGO',
    'ESTATUS',
    'COMENTARIOS',
    'ALTA TPV',
  ]

  const row = [
    data.movimiento,
    data.activaAfiliacion,
    data.klu,
    data.nombreComercial,
    data.tipoPersona,
    data.razonSocial,
    data.rfc,
    data.representanteLegal,
    data.direccion,
    data.cp,
    data.colonia,
    data.poblacionAlcaldia,
    data.estado,
    data.lada,
    data.telefono,
    data.correoElectronico,
    data.mcc,
    data.descripcionGiro,
    data.operativa,
    data.latitud,
    data.longitud,
    data.paginaWeb,
    data.riesgo,
    data.estatus,
    data.comentarios,
    data.altaTPV,
  ]

  const ws = XLSX.utils.aoa_to_sheet([headers, row])
  ws['!cols'] = headers.map(() => ({ wch: 20 }))

  XLSX.utils.book_append_sheet(wb, ws, 'Comercios')

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}

/**
 * Upload Excel to Firebase Storage
 */
async function uploadToFirebase(buffer: Buffer, venueName: string, venueSlug: string): Promise<string | null> {
  try {
    const bucket = getStorage().bucket()
    const fileName = buildStoragePath(`venues/${venueSlug}/blumon/${Date.now()}_LayOut_Comercio_${venueName.replace(/\s+/g, '_')}.xlsx`)
    const file = bucket.file(fileName)

    await file.save(buffer, {
      metadata: {
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      },
    })

    // Make file publicly accessible
    await file.makePublic()

    const publicUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`
    logger.info(`✅ Excel uploaded to: ${publicUrl}`)
    return publicUrl
  } catch (error) {
    logger.error('Error uploading Excel to Firebase:', error)
    return null
  }
}

/**
 * Main function: Generate Blumon Excel from KYC documents
 */
export async function generateBlumonExcel(
  documents: {
    rfcDocumentUrl?: string | null
    idDocumentUrl?: string | null
  },
  venueData: {
    name: string
    slug: string
    phone?: string | null
    email?: string | null
    website?: string | null
  },
): Promise<{ success: boolean; excelUrl?: string; data?: BlumonData }> {
  if (!anthropic) {
    logger.warn('⚠️ ANTHROPIC_API_KEY not configured - cannot generate Blumon Excel')
    return { success: false }
  }

  logger.info(`\n📊 Generating Blumon Excel for: ${venueData.name}`)
  logger.info('═'.repeat(50))

  // Initialize data with defaults
  const blumonData: BlumonData = {
    movimiento: 'A',
    activaAfiliacion: '',
    klu: '',
    nombreComercial: '',
    tipoPersona: '',
    razonSocial: '',
    rfc: '',
    representanteLegal: '',
    direccion: '',
    cp: '',
    colonia: '',
    poblacionAlcaldia: '',
    estado: '',
    lada: '',
    telefono: venueData.phone || '',
    correoElectronico: venueData.email || '',
    mcc: '',
    descripcionGiro: '',
    operativa: '',
    latitud: '',
    longitud: '',
    paginaWeb: venueData.website || '',
    riesgo: 'BAJO',
    estatus: '',
    comentarios: '',
    altaTPV: '',
  }

  // 1. Extract from CSF (Constancia de Situación Fiscal)
  if (documents.rfcDocumentUrl) {
    const csfData = await extractFromCSF(documents.rfcDocumentUrl)
    Object.assign(blumonData, {
      nombreComercial: csfData.nombreComercial || blumonData.nombreComercial,
      tipoPersona: csfData.tipoPersona || blumonData.tipoPersona,
      razonSocial: csfData.razonSocial || blumonData.razonSocial,
      rfc: csfData.rfc || blumonData.rfc,
      direccion: csfData.direccion || blumonData.direccion,
      cp: csfData.cp || blumonData.cp,
      colonia: csfData.colonia || blumonData.colonia,
      poblacionAlcaldia: csfData.poblacionAlcaldia || blumonData.poblacionAlcaldia,
      estado: csfData.estado || blumonData.estado,
      descripcionGiro: csfData.descripcionGiro || blumonData.descripcionGiro,
    })
  }

  // 2. Extract representative name from INE
  if (documents.idDocumentUrl && !blumonData.representanteLegal) {
    const repName = await extractFromINE(documents.idDocumentUrl)
    if (repName) {
      blumonData.representanteLegal = repName
    }
  }

  // 3. Suggest MCC based on business description
  if (blumonData.descripcionGiro) {
    const mccResult = await suggestMCC(blumonData.descripcionGiro)
    blumonData.mcc = mccResult.mcc
    if (mccResult.descripcion) {
      blumonData.descripcionGiro = mccResult.descripcion
    }
  }

  // 4. Geocode address
  if (blumonData.direccion) {
    const coords = await geocodeAddress(blumonData.direccion, blumonData.colonia, blumonData.cp, blumonData.estado)
    blumonData.latitud = coords.lat
    blumonData.longitud = coords.lng
  }

  // 5. Generate placeholder website if needed
  if (!blumonData.paginaWeb && blumonData.nombreComercial) {
    const slug = blumonData.nombreComercial
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
    blumonData.paginaWeb = `https://${slug}.com`
  }

  // Log final data
  logger.info('\n📋 Blumon data:')
  Object.entries(blumonData).forEach(([k, v]) => {
    if (v) logger.info(`   ${k}: ${v}`)
  })

  // 6. Generate Excel
  const excelBuffer = generateExcel(blumonData)

  // 7. Upload to Firebase
  const excelUrl = await uploadToFirebase(excelBuffer, venueData.name, venueData.slug)

  if (excelUrl) {
    logger.info(`\n✅ Blumon Excel generated successfully!`)
    return { success: true, excelUrl, data: blumonData }
  }

  return { success: false, data: blumonData }
}
