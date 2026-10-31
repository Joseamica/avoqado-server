/**
 * Zod schemas for `/api/v1/crm/*` (spec 2026-10-30). Messages ALWAYS in Spanish; shape and format only — the business
 * rules (keys, scope, who owns what) live in the services. Empty on purpose: `GET /me` takes no input, and the tasks that
 * add CRM endpoints (equipo de ventas, negocios, importación, reportes) add their schemas here.
 */
export {}
