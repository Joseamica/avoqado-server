---
trigger: always_on
---

### **6. Base de Datos y Schema Prisma**

El schema de Prisma es la única fuente de verdad para la estructura de la base de datos.

- **Definición:** El schema se encuentra en `prisma/migrations/{timestamp}_/migration.sql` y es gestionado por Prisma Migrate.
- **Modelos y Relaciones:** Los modelos se definen con `PascalCase` (ej. `StaffVenue`). Los campos usan `camelCase` (ej. `totalSales`). Las
  relaciones y sus claves foráneas deben estar explícitamente definidas con `@relation`.
- **Enums:** Para campos con un conjunto predefinido de valores (ej. `OrderStatus`, `StaffRole`), se deben usar `enums` de Prisma. Estos
  enums se importan y se utilizan en todo el código (schemas de Zod, lógica de autorización, etc.) para mantener la consistencia.
- **Acceso a Datos:** Toda interacción con la base de datos debe realizarse a través de la instancia única de `PrismaClient` exportada desde
  `/src/utils/prismaClient.ts`.
