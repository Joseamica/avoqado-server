/**
 * CLABE (Clave Bancaria Estandarizada) Validator for Mexico
 *
 * CLABE is Mexico's standardized 18-digit bank account number system.
 * Format: 18 digits with check digit validation (Luhn-like algorithm)
 *
 * Structure:
 * - Digits 1-3: Bank code (e.g., 002 = Banamex)
 * - Digits 4-6: Branch/plaza code
 * - Digits 7-17: Account number
 * - Digit 18: Check digit
 *
 * @see https://www.banxico.org.mx/sistemas-de-pago/d/%7B83D0C199-2D14-D194-5BD5-F71F4F22D52F%7D.pdf
 */

/**
 * Validates a CLABE interbancaria (Mexican bank account number)
 *
 * @param clabe - The 18-digit CLABE number to validate
 * @returns true if valid, false otherwise
 *
 * @example
 * validateCLABE('002010077777777771') // true (valid Banamex CLABE)
 * validateCLABE('12345678901234567')  // false (only 17 digits)
 * validateCLABE('002010077777777772') // false (invalid check digit)
 */
export function validateCLABE(clabe: string): boolean {
  // Remove any whitespace
  const cleanedCLABE = clabe.replace(/\s/g, '')

  // Must be exactly 18 digits
  if (!/^\d{18}$/.test(cleanedCLABE)) {
    return false
  }

  // Validate check digit using weighted modulus algorithm
  return validateCLABECheckDigit(cleanedCLABE)
}

/**
 * Validates the check digit (18th digit) of a CLABE using the Banco de México algorithm
 *
 * Algorithm:
 * 1. Multiply each of the first 17 digits by its weight (3, 7, 1, 3, 7, 1, ...)
 * 2. Sum all the products
 * 3. Calculate (10 - (sum % 10)) % 10
 * 4. Result must equal the 18th digit
 *
 * @param clabe - The 18-digit CLABE (must be pre-validated for format)
 * @returns true if check digit is valid, false otherwise
 */
function validateCLABECheckDigit(clabe: string): boolean {
  // Weights for CLABE check digit calculation (repeating pattern)
  const weights = [3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7]

  let sum = 0

  // Calculate weighted sum of first 17 digits
  for (let i = 0; i < 17; i++) {
    sum += parseInt(clabe[i]) * weights[i]
  }

  // Calculate expected check digit
  const expectedCheckDigit = (10 - (sum % 10)) % 10

  // Compare with actual 18th digit
  const actualCheckDigit = parseInt(clabe[17])

  return expectedCheckDigit === actualCheckDigit
}

/**
 * Extracts bank code from CLABE (first 3 digits)
 *
 * @param clabe - Valid 18-digit CLABE
 * @returns 3-digit bank code
 *
 * @example
 * getBankCodeFromCLABE('002010077777777771') // '002' (Banamex)
 */
export function getBankCodeFromCLABE(clabe: string): string {
  return clabe.substring(0, 3)
}

/**
 * Extracts branch/plaza code from CLABE (digits 4-6)
 *
 * @param clabe - Valid 18-digit CLABE
 * @returns 3-digit branch code
 */
export function getBranchCodeFromCLABE(clabe: string): string {
  return clabe.substring(3, 6)
}

/**
 * Extracts account number from CLABE (digits 7-17)
 *
 * @param clabe - Valid 18-digit CLABE
 * @returns 11-digit account number
 */
export function getAccountNumberFromCLABE(clabe: string): string {
  return clabe.substring(6, 17)
}

/**
 * Common Mexican bank codes (for reference/validation)
 * @see https://www.banxico.org.mx/SieInternet/consultarDirectorioInternetAction.do?accion=consultarCuadro&idCuadro=CP154
 */
export const MEXICAN_BANK_CODES: Record<string, string> = {
  '002': 'Banamex',
  '006': 'Bancomext',
  '009': 'Banobras',
  '012': 'BBVA México',
  '014': 'Santander',
  '019': 'Banjercito',
  '021': 'HSBC',
  '030': 'Banco del Bajío',
  '032': 'IXE',
  '036': 'Inbursa',
  '037': 'Interacciones',
  '042': 'Mifel',
  '044': 'Scotiabank',
  '058': 'Banregio',
  '059': 'Invex',
  '060': 'Bansi',
  '062': 'Afirme',
  '072': 'Banorte',
  '102': 'ABC Capital',
  '103': 'American Express',
  '106': 'Bank of America',
  '108': 'Bank of Tokyo-Mitsubishi UFJ',
  '110': 'JP Morgan',
  '112': 'Banco Monex',
  '113': 'Ve Por Mas',
  '116': 'ING',
  '124': 'Deutsche Bank',
  '126': 'Credit Suisse',
  '127': 'Azteca',
  '128': 'Autofin',
  '129': 'Barclays',
  '130': 'Compartamos',
  '131': 'Banco Famsa',
  '132': 'BMULTIVA',
  '133': 'Actinver',
  '135': 'Walmart',
  '136': 'Inter Banco',
  '137': 'BanCoppel',
  '138': 'ABC Afore',
  '139': 'UBS Bank',
  '140': 'Consubanco',
  '141': 'Volkswagen',
  '143': 'CIBanco',
  '145': 'Bbase',
  '147': 'Bankaool',
  '148': 'PagaTodo',
  '150': 'Inmobiliario',
  '151': 'Donde',
  '152': 'Bancrea',
  '154': 'Banco Finterra',
  '155': 'ICBC',
  '156': 'Sabadell',
  '157': 'Shinhan',
  '158': 'Mizuho Bank',
  '166': 'Banco del Bienestar',
  '600': 'GBM',
  '601': 'Monexcb',
  '602': 'Masari',
  '605': 'Value',
  '606': 'Estructuradores',
  '607': 'Tiber',
  '608': 'Vector',
  '610': 'B&B',
  '614': 'Accival',
  '615': 'Merrill Lynch',
  '616': 'Finamex',
  '617': 'Valmex',
  '618': 'Unica',
  '619': 'MAPFRE',
  '620': 'Profuturo',
  '621': 'CB Actinver',
  '622': 'Oactin',
  '623': 'Skandia',
  '626': 'Cbdeutsche',
  '627': 'Zurich',
  '628': 'Zurichvi',
  '629': 'SU Casabolsa',
  '630': 'CB Intercam',
  '631': 'CI Bolsa',
  '632': 'Bulltick CB',
  '633': 'Sterling',
  '634': 'Fincomun',
  '636': 'HDI Seguros',
  '637': 'Order',
  '638': 'Akala',
  '640': 'JP Morgan CB',
  '642': 'Reforma',
  '646': 'STP',
  '647': 'Telecomm',
  '648': 'Evercore',
  '649': 'Skandia',
  '651': 'Segmty',
  '652': 'Asea',
  '653': 'Kuspit',
  '655': 'Sofiexpress',
  '656': 'Unagra',
  '659': 'Opciones Empresariales del Noreste',
  '670': 'Libertad',
  '901': 'CLS',
  '902': 'INDEVAL',
}

/**
 * Gets the bank name for a CLABE's bank code
 *
 * @param clabe - Valid 18-digit CLABE
 * @returns Bank name or 'Unknown' if not found
 *
 * @example
 * getBankNameFromCLABE('002010077777777771') // 'Banamex'
 */
export function getBankNameFromCLABE(clabe: string): string {
  const bankCode = getBankCodeFromCLABE(clabe)
  return MEXICAN_BANK_CODES[bankCode] || 'Unknown'
}

/**
 * Formats a CLABE for display (adds spaces for readability)
 *
 * @param clabe - Valid 18-digit CLABE
 * @returns Formatted CLABE with spaces: "002 010 07777777777 1"
 *
 * @example
 * formatCLABE('002010077777777771') // '002 010 07777777777 1'
 */
export function formatCLABE(clabe: string): string {
  const cleaned = clabe.replace(/\s/g, '')

  if (cleaned.length !== 18) {
    return clabe // Return as-is if invalid length
  }

  // Format: XXX XXX XXXXXXXXXXX X
  return `${cleaned.substring(0, 3)} ${cleaned.substring(3, 6)} ${cleaned.substring(6, 17)} ${cleaned[17]}`
}
