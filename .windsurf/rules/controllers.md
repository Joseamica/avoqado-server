---
trigger: always_on
---

### **3. Capa de Controladores (`/src/controllers`)**

Los controladores actúan como un "pegamento" delgado entre la capa HTTP y la lógica de negocio.

- **Responsabilidad Única:** Un controlador debe limitarse a:
  1.  Extraer datos relevantes de `req` (ej. `req.body`, `req.params`, `req.authContext`).
  2.  Llamar al método de servicio correspondiente, pasándole los datos ya limpios y validados.
  3.  Enviar la respuesta HTTP (`res.status(...).json(...)`) con los datos devueltos por el servicio.
  4.  Capturar errores y pasarlos al siguiente middleware de error con `next(error)`.
- **Sin Lógica de Negocio:** Un controlador **nunca** debe contener lógica de negocio ni interactuar directamente con la base de datos
  (Prisma). Su función es orquestar.
