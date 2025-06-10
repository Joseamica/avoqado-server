---
trigger: always_on
---

### **4. Capa de Servicios (`/src/services`)**

El núcleo de la aplicación reside en los servicios.

- **Lógica de Negocio:** Toda la lógica de negocio, reglas de validación complejas y algoritmos deben implementarse aquí.
- **Interacción con la Base de Datos:** Los servicios son la única capa que debe interactuar con la base de datos a través del
  `prismaClient`.
- **Agnóstico a HTTP:** Un servicio no debe conocer los objetos `req` o `res`. Recibe datos primitivos o DTOs y devuelve datos o lanza
  errores.
- **Manejo de Errores:** Cuando una operación falla por una razón de negocio (ej. un recurso no encontrado o un conflicto de datos), el
  servicio debe lanzar una instancia de una clase de error personalizada que herede de `AppError` (ej. `throw new BadRequestError(...)`).
