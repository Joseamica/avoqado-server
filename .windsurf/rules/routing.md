---
trigger: always_on
---

### **2. Capa de Ruteo (`/src/routes`)**

Las rutas son el punto de entrada a la API y definen los endpoints, su seguridad y validación.

- **Creación de Rutas:** Para un nuevo contexto, crea un archivo en `/src/routes/{contexto}.routes.ts`. Utiliza `express.Router()` para
  definir los endpoints.
- **Agregación:** El enrutador principal en `/src/routes/index.ts` debe importar y montar todos los enrutadores contextuales bajo un prefijo
  base.
- **Middlewares en Rutas:** La autenticación, autorización y validación se aplican a nivel de ruta, en este orden:
  `authenticateTokenMiddleware`, `authorizeRole(...)`, `validateRequest(...)`, y finalmente, la función del controlador.
- **Documentación:** Cada endpoint debe estar documentado con comentarios JSDoc que sigan el estándar OpenAPI 3.0. Esto se usa para generar
  la documentación de la API automáticamente a través de Swagger.
