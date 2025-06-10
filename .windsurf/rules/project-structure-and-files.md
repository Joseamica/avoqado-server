---
trigger: always_on
---

### **1. Estructura de Proyecto y Archivos**

La organización del código se basa en una arquitectura por capas, agrupada por contexto de negocio.

- **Organización por Capas:** Todo el código fuente reside en `/src`. Las capas principales son:
  - `/src/routes`: Definición de endpoints y enrutadores.
  - `/src/controllers`: Orquestación de peticiones y respuestas HTTP.
  - `/src/services`: Lógica de negocio pura.
  - `/src/schemas`: Definiciones de validación y tipos de datos (DTOs) con Zod.
  - `/src/middlewares`: Middlewares de Express reutilizables.
  - `/src/config`: Configuración de la aplicación (base de datos, logger, CORS, etc.).
  - `/src/errors`: Clases de error personalizadas.
  - `/src/utils`: Instancia de Prisma Client y otras utilidades.
- **Agrupación por Contexto:** Dentro de las capas, los archivos se agrupan por el contexto de la API (ej. `dashboard`, `public`).
- **Convención de Nombres:**
  - Controladores: `{recurso}.{contexto}.controller.ts` (ej. `venue.dashboard.controller.ts`).
  - Servicios: `{recurso}.{contexto}.service.ts` (ej. `venue.dashboard.service.ts`).
  - Rutas: `{contexto}.routes.ts` (ej. `dashboard.routes.ts`).
  - Schemas de Zod: `{recurso}.schema.ts` (ej. `venue.schema.ts`).
