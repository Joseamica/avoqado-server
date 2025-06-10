---
trigger: always_on
---

### **5. Middlewares y Seguridad**

Se utiliza un conjunto de middlewares para estandarizar la seguridad, validación y logging.

- **Autenticación (`authenticateToken.middleware.ts`):** Valida el `Bearer Token` JWT. Si es válido, decodifica el payload y adjunta un
  objeto `authContext` al objeto `req`, que contiene `userId`, `orgId`, `venueId`, y `role`.
- **Autorización (`authorizeRole.middleware.ts`):** Es un middleware factory que recibe un array de `StaffRole` permitidos. Verifica el rol
  del usuario en `req.authContext.role` y devuelve un error 403 si el rol no está permitido.
- **Validación (`validation.ts`):** Es un middleware factory que recibe un schema de Zod. Valida `req.body`, `req.query`, y/o `req.params`
  contra el schema. Si la validación falla, pasa un `AppError` con código 400 al manejador de errores. Los schemas se definen en
  `/src/schemas`.
- **Logging de Peticiones (`requestLogger.ts`):** Registra el inicio y fin de cada solicitud HTTP, incluyendo un ID de correlación
  (`X-Correlation-ID`), el método, la URL, el estado de la respuesta y la duración.
