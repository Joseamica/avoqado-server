---
trigger: always_on
---

### **7. Manejo de Errores**

Se utiliza un sistema centralizado y predecible para el manejo de errores.

- **Clases de Error Personalizadas:** Se debe usar la clase base `AppError` y sus subclases (`BadRequestError`, `NotFoundError`,
  `ConflictError`, etc.) definidas en `/src/errors/AppError.ts` para señalar errores operacionales que se pueden anticipar.
- **Manejador Global:** El último middleware en `app.ts` es el manejador global de errores. Este middleware:
  1.  Identifica si el error es una instancia de `AppError`.
  2.  Si lo es, utiliza su `statusCode` y `message` para generar una respuesta JSON limpia.
  3.  Si es un error inesperado, devuelve un error genérico 500 y loguea el error completo para depuración.
  4.  Enlaza cada error logueado con el `correlationId` de la solicitud.
