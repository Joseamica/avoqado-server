// src/utils/slugify.ts

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
