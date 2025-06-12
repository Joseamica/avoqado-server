# Documentación del Proyecto: avoqado-server

Este documento proporciona una descripción técnica detallada de la estructura, componentes y arquitectura del backend `avoqado-server`.

## 1. Arquitectura General

El proyecto sigue una **Arquitectura por Capas (Layered Architecture)** inspirada en los principios de **Clean Architecture**. El flujo de
una petición es el siguiente:

`Route -> Middleware(s) -> Controller -> Service -> Prisma (DB)`

- **Separación de Responsabilidades**: Cada capa tiene un propósito único.
- **Flujo de Dependencia Unidireccional**: Las dependencias fluyen hacia el núcleo del negocio (servicios), haciendo que la lógica de
  negocio sea independiente del framework web.
- **Inyección de Dependencias Implícita**: Los servicios y utilidades (como el cliente de Prisma) se importan donde se necesitan.

---

## 2. Estructura de Archivos y Componentes

### 2.1. Directorio Raíz (`/`)

- **`package.json`**: Define los scripts (`dev`, `build`, `test`), las dependencias del proyecto (Express, Prisma, Zod, etc.) y las
  dependencias de desarrollo (TypeScript, ts-node-dev, etc.).
- **`tsconfig.json`**: Archivo de configuración de TypeScript. Define las reglas de compilación, como el directorio de salida (`dist`), el
  target de ECMAScript y las rutas base.
- **`jest.config.js`**: Configuración para el framework de testing Jest.
- **`.eslintrc.json`**: Reglas para el linter ESLint, asegurando un estilo de código consistente.
- **`prisma/schema.prisma`**: **Corazón del acceso a datos**. Define los modelos de la base de datos, relaciones y enums. Es la fuente única
  de verdad para la estructura de la base de datos.

### 2.2. Código Fuente (`/src`)

#### `/src/app.ts`

- **Propósito**: Punto de entrada y configuración central de la aplicación Express.
- **Dependencias Clave**: `express`, `cors`, `winston` (logger), `swagger-ui-express`.
- **Lógica Principal**:
  1. Crea la instancia de la aplicación Express.
  2. Aplica middlewares globales:
     - `cors`: Para permitir peticiones de orígenes cruzados.
     - `express.json()`: Para parsear cuerpos de petición en formato JSON.
     - `requestLogger`: Middleware personalizado para loguear cada petición HTTP.
  3. Monta el enrutador principal desde `src/routes/index.ts`, que a su vez contiene todas las rutas de la aplicación.
  4. Configura la ruta `/docs` para servir la documentación de la API con Swagger.
  5. Registra el **manejador de errores global** como el último middleware, que se encarga de atrapar todos los errores y enviar una
     respuesta estandarizada.
- **Conexiones**: Es el orquestador principal. Importa las rutas y la configuración, y es a su vez importado por `server.ts` para iniciar el
  servidor.

#### `/src/server.ts`

- **Propósito**: Iniciar el servidor HTTP.
- **Dependencias Clave**: `http`, `app` (la instancia de Express).
- **Lógica Principal**:
  - Importa la aplicación `app` configurada.
  - Lee el puerto del entorno y lo establece en la app.
  - Crea un servidor HTTP y lo pone a escuchar en el puerto especificado.
  - Maneja eventos del servidor como `listening` y `error`.
- **Conexiones**: Separa la lógica de "arranque" de la de "configuración", una buena práctica para la mantenibilidad y los tests.

#### `/src/routes/`

- **Propósito**: Definir los endpoints de la API, asociando URLs a middlewares y controladores.
- **Ejemplo (`dashboard.routes.ts`**):
  - **Dependencias**: `express.Router`, controladores (`venue.dashboard.controller`), middlewares (`authenticateToken`, `authorizeRole`,
    `validateRequest`) y schemas de Zod.
  - **Lógica Principal**: Crea una instancia de `express.Router()` y define las rutas para un contexto específico (ej. `dashboard`). Cada
    definición de ruta es una cadena de ejecución:
    1. `router.post('/venues', ...)`: Define el método HTTP y la URL.
    2. `authenticateTokenMiddleware`: Primer middleware, asegura que el usuario esté autenticado.
    3. `authorizeRole(['ADMIN'])`: Segundo, asegura que el usuario tenga el rol adecuado.
    4. `validateRequest(createVenueSchema)`: Tercero, valida el cuerpo de la petición.
    5. `venueController.create`: La función del controlador que se ejecuta si todo lo anterior pasa.
  - **Conexiones**: Las rutas son el "pegamento" de la aplicación. Son importadas por `src/routes/index.ts`, que las agrupa y exporta al
    `app.ts`. Llaman a los controladores para manejar la lógica de la petición.

#### `/src/controllers/`

- **Propósito**: Orquestar el flujo de la petición. Actúa como un intermediario delgado.
- **Ejemplo (`venue.dashboard.controller.ts`**):
  - **Dependencias**: `express` (para los tipos `Request`, `Response`, `NextFunction`), servicios (`venue.dashboard.service`).
  - **Lógica Principal**:
    - Cada método (ej. `create`, `getById`) es una función asíncrona que recibe `req`, `res`, `next`.
    - **No contiene lógica de negocio**.
    - Extrae la información necesaria del objeto `req` (`req.body`, `req.params`, `req.authContext`).
    - Llama al método de servicio correspondiente, pasándole los datos limpios.
    - Recibe la respuesta del servicio y la envía al cliente usando `res.status(...).json(...)`.
    - Envuelve la lógica en un bloque `try...catch` y pasa cualquier error a `next(error)` para que lo maneje el middleware global.
  - **Conexiones**: Es llamado por una ruta y a su vez llama a un servicio.

#### `/src/services/`

- **Propósito**: Contener toda la lógica de negocio. Es el **núcleo de la aplicación**.
- **Ejemplo (`venue.dashboard.service.ts`**):
  - **Dependencias**: `prismaClient`, clases de error (`AppError`, `NotFoundError`), utilidades.
  - **Lógica Principal**:
    - Implementa las operaciones de negocio (ej. crear un nuevo local, calcular métricas, etc.).
    - Es la **única capa que interactúa directamente con la base de datos** a través de `prismaClient`.
    - Realiza validaciones de negocio complejas (ej. verificar si un recurso ya existe antes de crearlo).
    - Lanza errores operacionales (`throw new ConflictError(...)`) cuando una regla de negocio no se cumple.
    - Es agnóstico a HTTP: no conoce `req` ni `res`. Recibe datos primitivos o DTOs y devuelve datos o lanza un error.
  - **Conexiones**: Es llamado por los controladores. Depende de la capa de datos (Prisma) y de las clases de error.

#### `/src/schemas/`

- **Propósito**: Definir esquemas de validación y tipos de datos (DTOs) usando Zod.
- **Ejemplo (`venue.schema.ts`**):
  - **Dependencias**: `zod`.
  - **Lógica Principal**: Exporta objetos de Zod que definen la forma, tipo y restricciones de los datos de entrada de la API (ej.
    `createVenueSchema`). Por ejemplo, `z.string().min(3)` para un nombre.
  - **Conexiones**: Estos esquemas son importados y utilizados por el middleware `validateRequest` en la capa de ruteo para validar
    automáticamente las peticiones entrantes.

#### `/src/middlewares/`

- **Propósito**: Contener lógica reutilizable que opera sobre las peticiones HTTP.
- **Archivos Clave**:
  - **`authenticateToken.middleware.ts`**: Valida el JWT. Si es válido, decodifica el payload y lo adjunta a `req.authContext`.
  - **`authorizeRole.middleware.ts`**: Middleware factory que comprueba si el rol del usuario (`req.authContext.role`) está en una lista de
    roles permitidos.
  - **`validation.ts`**: Middleware factory que toma un schema de Zod y valida `req.body`, `req.query` o `req.params`.
- **Conexiones**: Son utilizados en la capa de `routes` para proteger y validar endpoints.

#### `/src/errors/AppError.ts`

- **Propósito**: Definir una clase base `AppError` y subclases (`NotFoundError`, `BadRequestError`, `ConflictError`, etc.) para un manejo de
  errores estandarizado.
- **Lógica Principal**: Cada clase de error almacena un `statusCode` HTTP y un mensaje. Esto permite a los servicios lanzar errores de
  negocio de forma semántica (`throw new NotFoundError()`) sin acoplarse a códigos de estado HTTP.
- **Conexiones**: Son lanzados por los servicios y capturados por el manejador de errores global en `app.ts`, que usa el `statusCode` para
  la respuesta HTTP.

#### `/src/utils/prismaClient.ts`

- **Propósito**: Crear y exportar una **instancia única (singleton)** del cliente de Prisma.
- **Lógica Principal**: Instancia `new PrismaClient()` y lo exporta. Esto previene la creación de múltiples pools de conexiones a la base de
  datos, mejorando el rendimiento.
- **Conexiones**: Es importado por todos los servicios que necesitan interactuar con la base de datos.

---
