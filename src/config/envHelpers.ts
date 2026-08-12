/**
 * Pure helpers for environment parsing.
 *
 * Kept in their own module on purpose: `env.ts` validates and calls `process.exit(1)` at
 * import time, so anything that imports it boots the whole configuration. A pure function
 * should be testable without that.
 */

/**
 * Drops env vars that are present but empty, so they are treated as "not set".
 *
 * An empty env var is not a value — it means somebody created the key and left it blank.
 * Zod disagrees: `""` is a present string, so `z.string().url().optional()` runs `.url()`
 * on it and REJECTS it. Validation in `env.ts` is fail-fast, so one blank variable takes
 * the whole API down.
 *
 * The scenario this prevents is not hypothetical: you open the Render dashboard to set up
 * an integration, create the variable, and save it before you have the value in hand. On
 * the next restart the API refuses to boot — for every venue — because of a variable that
 * nothing actually depends on.
 *
 * Treating empty as absent is the convention in env libraries, and it makes `.optional()`
 * and `.default()` behave the way anyone reading the schema would expect: a blank value
 * falls back to the default instead of blowing up.
 */
export const dropEmptyValues = (source: Record<string, string | undefined>): Record<string, string | undefined> =>
  Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ''))
