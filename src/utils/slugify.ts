// src/utils/slugify.ts

/**
 * Reserved slugs that cannot be used for venues or organizations.
 * These would cause routing conflicts with system routes.
 *
 * Pattern explanation:
 * - 'organizations', 'org' - Organization-level routes
 * - 'venues' - Venue-level routes
 * - 'admin', 'superadmin' - Admin routes
 * - 'auth', 'api', 'webhook' - System routes
 * - 'settings', 'account', 'profile' - User routes
 * - 'static', 'assets', 'public' - Asset routes
 */
export const RESERVED_SLUGS = [
  // Route prefixes
  'organizations',
  'org',
  'venues',
  'wl',

  // Admin routes
  'admin',
  'superadmin',
  'dashboard',

  // Auth routes
  'auth',
  'login',
  'logout',
  'signup',
  'register',
  'reset-password',
  'forgot-password',

  // System routes
  'api',
  'webhook',
  'webhooks',
  'health',
  'status',

  // User routes
  'settings',
  'account',
  'profile',
  'me',
  'user',
  'users',

  // Asset routes
  'static',
  'assets',
  'public',
  'images',
  'files',

  // Common reserved words
  'new',
  'create',
  'edit',
  'delete',
  'null',
  'undefined',
  'true',
  'false',
] as const

export type ReservedSlug = (typeof RESERVED_SLUGS)[number]

/**
 * Validates that a slug is not a reserved word.
 * @param slug The slug to validate
 * @returns Object with isValid boolean and error message if invalid
 */
export function validateSlug(slug: string): { isValid: boolean; error?: string } {
  if (!slug) {
    return { isValid: false, error: 'Slug cannot be empty' }
  }

  const normalizedSlug = slug.toLowerCase().trim()

  // Check against reserved slugs
  if (RESERVED_SLUGS.includes(normalizedSlug as ReservedSlug)) {
    return {
      isValid: false,
      error: `The slug "${slug}" is reserved and cannot be used. Please choose a different name.`,
    }
  }

  // Also check if slug starts with reserved prefixes
  const reservedPrefixes = ['api-', 'admin-', 'superadmin-', 'auth-', 'webhook-']
  for (const prefix of reservedPrefixes) {
    if (normalizedSlug.startsWith(prefix)) {
      return {
        isValid: false,
        error: `The slug "${slug}" starts with a reserved prefix "${prefix}". Please choose a different name.`,
      }
    }
  }

  return { isValid: true }
}

/**
 * Generates a URL-friendly slug from a string.
 * Converts to lowercase, replaces spaces with hyphens,
 * and removes characters that are not alphanumeric or hyphens.
 * @param text The string to convert to a slug.
 * @returns The generated slug.
 */
export function generateSlug(text: string): string {
  if (!text) return ''
  return text
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-') // Replace spaces with -
    .replace(/[&/\\#,+()$~%.'":*?<>{}]/g, '') // Remove special characters
    .replace(/--+/g, '-') // Replace multiple - with single -
    .replace(/^-+/, '') // Trim - from start of text
    .replace(/-+$/, '') // Trim - from end of text
}

/**
 * Generates a URL-friendly slug and validates it's not reserved.
 * @param text The string to convert to a slug.
 * @throws Error if the generated slug is a reserved word.
 * @returns The generated slug.
 */
export function generateValidatedSlug(text: string): string {
  const slug = generateSlug(text)
  const validation = validateSlug(slug)

  if (!validation.isValid) {
    throw new Error(validation.error)
  }

  return slug
}
