# 📦 Guía Completa del Sistema de Inventario de Avoqado

## 🎯 Conceptos Fundamentales

Tu sistema de inventario tiene **tres pilares principales** que trabajan juntos:

### 1. **Materias Primas (Raw Materials)** 🥩🧀🥖
Son los ingredientes base que compras a tus proveedores. Cada materia prima tiene:
- **Stock actual**: Cuánto tienes en tu almacén
- **Costo por unidad**: Cuánto te cuesta cada kg/litro/unidad
- **Control FIFO**: El sistema usa "First In, First Out" (lo primero que entra, es lo primero que sale)
- **Alertas**: Te avisa cuando el stock está bajo

**Ejemplos**: Pan (kg), Carne de res (kg), Queso (kg), Lechuga (kg), Salsa (litros)

### 2. **Recetas (Recipes)** 📝
Una receta define **qué materias primas** y **en qué cantidades** se necesitan para hacer UN producto.

**Ejemplo - Receta de "Hamburguesa Sencilla"**:
```
Hamburguesa Sencilla (1 porción):
  - 200g de Pan
  - 300g de Carne de res
  - 50g de Queso

Costo total de la receta = (0.2kg × $50/kg pan) + (0.3kg × $200/kg carne) + (0.05kg × $100/kg queso)
Costo total = $10 + $60 + $5 = $75 MXN
```

### 3. **Productos (Products)** 🍔
Son los items que tus clientes ven en el menú y pueden ordenar. Un producto puede:
- **Sin inventario**: Solo registra ventas, no afecta stock (ejemplo: café ilimitado)
- **Stock simple**: El producto mismo tiene stock (ejemplo: botellas de vino)
- **Basado en receta**: El producto está compuesto por materias primas (ejemplo: hamburguesa)

---

## 🔄 Flujo de Trabajo Completo

### Paso 1: Configuración Inicial del Menú

#### 1.1 Crear Horarios de Menú
```
Desayuno: 7am - 11am
Comida: 1pm - 5pm
Cena: 7pm - 11pm
```

#### 1.2 Crear Categorías
```
- Hamburguesas
- Bebidas
- Postres
- Entradas
```

### Paso 2: Dar de Alta Materias Primas

Antes de crear productos con inventario, necesitas registrar los ingredientes:

**Ejemplo: Materias Primas para Hamburguesa**

| Nombre | SKU | Categoría | Stock Actual | Unidad | Costo/Unidad | Stock Mínimo | Punto Reorden |
|--------|-----|-----------|--------------|--------|--------------|--------------|---------------|
| Pan para hamburguesa | PAN-001 | GRANOS | 50 kg | KILOGRAM | $50.00 | 5 kg | 10 kg |
| Carne de res molida | CARNE-001 | CARNE | 100 kg | KILOGRAM | $200.00 | 10 kg | 20 kg |
| Queso amarillo | QUESO-001 | LÁCTEOS | 20 kg | KILOGRAM | $100.00 | 2 kg | 5 kg |
| Lechuga | LECH-001 | VERDURAS | 10 kg | KILOGRAM | $30.00 | 1 kg | 3 kg |
| Tomate | TOM-001 | VERDURAS | 15 kg | KILOGRAM | $25.00 | 2 kg | 5 kg |

**Ruta en Dashboard**: `Inventario → Materias Primas → Agregar Materia Prima`

### Paso 3: Crear Productos con el Wizard

Ahora usas el **Product Wizard** (el botón ✨ en la página de productos):

#### 3.1 Paso 1 - Información Básica
```
Nombre: Hamburguesa Sencilla
Descripción: Deliciosa hamburguesa con carne, queso y vegetales
Precio: $120.00 MXN
Categoría: Hamburguesas
Imagen: [URL de la imagen]
```

#### 3.2 Paso 2 - Decisión de Inventario
Seleccionas: **"Usar inventario basado en recetas"**

Opciones disponibles:
- ❌ Sin inventario → Solo registra ventas
- ❌ Stock simple → El producto mismo tiene stock (ej: botellas)
- ✅ **Basado en recetas** → El producto consume materias primas

#### 3.3 Paso 3 - Configurar Receta

**Rendimiento de Porciones**: 1 (esta receta hace 1 hamburguesa)
**Tiempo de Prep**: 5 minutos (opcional)
**Tiempo de Cocción**: 10 minutos (opcional)

**Ingredientes**:
| Materia Prima | Cantidad | Unidad | Opcional |
|---------------|----------|--------|----------|
| Pan para hamburguesa | 200 | gramos | No |
| Carne de res molida | 300 | gramos | No |
| Queso amarillo | 50 | gramos | No |
| Lechuga | 20 | gramos | Sí |
| Tomate | 30 | gramos | Sí |

### Paso 4: ¿Qué Sucede Cuando un Cliente Ordena?

**Escenario**: Un cliente ordena 2 Hamburguesas Sencillas

#### 4.1 Backend detecta la orden
```javascript
// El sistema automáticamente:
1. Busca la receta asociada al producto "Hamburguesa Sencilla"
2. Multiplica las cantidades por 2 (2 hamburguesas)
3. Deduce del stock:
   - Pan: -400g (200g × 2)
   - Carne: -600g (300g × 2)
   - Queso: -100g (50g × 2)
   - Lechuga: -40g (20g × 2)
   - Tomate: -60g (30g × 2)
```

#### 4.2 Registro de Movimientos
El sistema crea registros en `RawMaterialMovement` con:
- Tipo: `SALE` (venta)
- Referencia: ID de la orden
- Cantidad deducida
- Timestamp

#### 4.3 Sistema FIFO
Si tienes múltiples lotes de carne:
```
Lote A (10kg) - Comprado: 2024-01-01 - $180/kg
Lote B (20kg) - Comprado: 2024-01-15 - $200/kg
```

El sistema deduce primero del **Lote A** (más antiguo), luego del **Lote B**.

#### 4.4 Alertas Automáticas
Si después de la venta, el stock de "Queso" baja de su **punto de reorden** (5kg), el sistema:
- Crea una alerta: "Stock bajo de Queso amarillo"
- Muestra notificación en dashboard
- Sugiere crear una orden de compra

---

## 📊 Las Tres Secciones del Inventario

### 1. **Materias Primas** (Raw Materials)
**¿Qué es?** El inventario físico de ingredientes.

**¿Qué haces aquí?**
- Dar de alta nuevos ingredientes
- Ajustar stock manualmente (recibir compras, mermas, robos)
- Ver movimientos de cada materia prima
- Configurar alertas de stock bajo

**Ejemplo de uso**:
- Recibiste 50kg de carne → Ajustas stock +50kg
- Se echó a perder 2kg de queso → Ajustas stock -2kg (razón: "Expirado")

### 2. **Recetas** (Recipes)
**¿Qué es?** La "fórmula" de cada producto.

**¿Qué haces aquí?**
- Crear recetas para productos nuevos
- Modificar recetas existentes (cambiar cantidades, agregar/quitar ingredientes)
- Ver el costo de cada receta
- Calcular el margen de ganancia

**Ejemplo de uso**:
- Tu chef decidió cambiar la hamburguesa: ahora lleva 350g de carne en vez de 300g
- Actualizas la receta → El sistema automáticamente recalcula el costo

### 3. **Precios** (Pricing Policies)
**¿Qué es?** Estrategias para calcular automáticamente el precio de venta.

**¿Qué haces aquí?**
- Definir el margen deseado (ejemplo: 300% sobre el costo)
- Calcular automáticamente precios sugeridos
- Ver el % de costo de comida de cada producto

**Ejemplo de uso**:
```
Hamburguesa Sencilla:
  - Costo de receta: $75 MXN
  - Estrategia: Markup 60% (margen 300%)
  - Precio sugerido: $75 × 1.6 = $120 MXN
  - Food Cost: 62.5% ($75/$120)
```

**Estrategias disponibles**:
- **FOOD_COST_PERCENTAGE**: "Quiero que el costo de comida sea 30%"
- **MARKUP_PERCENTAGE**: "Quiero ganar 300% sobre el costo"
- **FIXED_PRICE**: "El precio es fijo $120"

---

## 🎨 Comparación con Otros Sistemas

### Loyverse
- ✅ Simple para empezar
- ❌ No tiene recetas automáticas
- ❌ Tienes que deducir stock manualmente

### Square
- ✅ Tiene recetas básicas
- ✅ UI muy intuitiva
- ❌ No tiene FIFO avanzado
- ❌ No sugiere precios automáticamente

### **Avoqado**
- ✅ Recetas automáticas con FIFO
- ✅ Deducción automática de stock
- ✅ Sugerencias de precios inteligentes
- ✅ Alertas proactivas
- ✅ Análisis de rentabilidad por producto
- ⚠️ Requiere configuración inicial más compleja

---

## 🛠️ Endpoints del API

### Crear Materia Prima
```http
POST /api/v1/dashboard/venues/{venueId}/inventory/raw-materials
Content-Type: application/json

{
  "name": "Pan para hamburguesa",
  "sku": "PAN-001",
  "category": "GRAINS",
  "currentStock": 50,
  "unit": "KILOGRAM",
  "minimumStock": 5,
  "reorderPoint": 10,
  "costPerUnit": 50,
  "avgCostPerUnit": 50,
  "perishable": true,
  "shelfLifeDays": 7
}
```

### Crear Producto con Inventario (Wizard Todo-en-Uno)
```http
POST /api/v1/dashboard/venues/{venueId}/inventory/products/wizard/create
Content-Type: application/json

{
  "product": {
    "name": "Hamburguesa Sencilla",
    "description": "Deliciosa hamburguesa",
    "price": 120,
    "categoryId": "cm..."
  },
  "inventory": {
    "useInventory": true,
    "inventoryType": "RECIPE_BASED"
  },
  "recipe": {
    "portionYield": 1,
    "prepTime": 5,
    "cookTime": 10,
    "ingredients": [
      {
        "rawMaterialId": "cm...",
        "quantity": 200,
        "unit": "GRAM",
        "isOptional": false
      },
      {
        "rawMaterialId": "cm...",
        "quantity": 300,
        "unit": "GRAM",
        "isOptional": false
      }
    ]
  }
}
```

### Crear Solo Receta (Para Producto Existente)
```http
POST /api/v1/dashboard/venues/{venueId}/inventory/recipes/{productId}
Content-Type: application/json

{
  "portionYield": 1,
  "prepTime": null,  // ✅ Ahora acepta null!
  "cookTime": null,  // ✅ Ahora acepta null!
  "lines": [
    {
      "rawMaterialId": "cm...",
      "quantity": 200,
      "unit": "GRAM",
      "isOptional": false
    }
  ]
}
```

---

## ✅ Checklist: Configuración Inicial

### Paso 1: Configuración Base
- [ ] Crear horarios de menú
- [ ] Crear categorías de productos
- [ ] Configurar impuestos

### Paso 2: Inventario
- [ ] Dar de alta todas las materias primas con su SKU
- [ ] Configurar stock mínimo y puntos de reorden
- [ ] Registrar proveedores

### Paso 3: Productos
- [ ] Crear productos usando el wizard
- [ ] Asignar recetas a productos existentes
- [ ] Configurar políticas de precios

### Paso 4: Validación
- [ ] Hacer una orden de prueba
- [ ] Verificar que se deduce el stock correctamente
- [ ] Revisar movimientos de inventario
- [ ] Confirmar alertas de stock bajo

---

## 🚨 Errores Comunes y Soluciones

### Error: "Expected number, received null" en prepTime/cookTime
**Causa**: El frontend enviaba `null` y el schema solo aceptaba `undefined`

**Solución**: ✅ **YA ARREGLADO** - Ahora los campos `prepTime` y `cookTime` aceptan valores `null`

### Error: "At least one ingredient is required"
**Causa**: Intentaste crear una receta sin ingredientes

**Solución**: Agrega al menos 1 ingrediente a la receta

### Error: "Invalid unit type"
**Causa**: El unit no es un valor válido del enum

**Solución**: Usa unidades válidas: `KILOGRAM`, `GRAM`, `LITER`, `MILLILITER`, `UNIT`, etc.

---

## 📈 Próximas Mejoras Sugeridas

1. **Simplificar UX del Wizard**
   - Hacer el wizard el flujo principal (no el formulario tradicional)
   - Convertir categoryId en un selector dropdown
   - Agregar búsqueda de materias primas al agregar ingredientes

2. **Dashboard de Inventario**
   - Vista general con métricas clave
   - Gráficas de consumo por materia prima
   - Predicción de cuándo se acabará el stock

3. **Órdenes de Compra Automáticas**
   - Cuando una materia prima llega al punto de reorden
   - Sugerir orden de compra basada en consumo histórico

4. **Análisis de Rentabilidad**
   - Ranking de productos más/menos rentables
   - Sugerencias de ajuste de precios
   - Alertas de productos con margen bajo

---

## 🎓 Conceptos Avanzados

### FIFO (First In, First Out)
Imagina tu refrigerador: siempre debes usar primero los ingredientes más antiguos.

**Sin FIFO**:
```
Tienes 2 lotes de carne:
  - Lote viejo (5 días) - $180/kg
  - Lote nuevo (1 día) - $220/kg

Si usas cualquiera aleatoriamente:
  → Riesgo de desperdiciar lote viejo (se echa a perder)
  → Cálculo de costos inconsistente
```

**Con FIFO** (como Avoqado):
```
El sistema SIEMPRE usa el lote más antiguo primero:
  → Reduces desperdicios
  → Cálculo de costos preciso
  → Mejor control de calidad
```

### Varianza de Costos
Detecta cuando el costo real de un producto es diferente al costo esperado.

**Ejemplo**:
```
Costo esperado de hamburguesa: $75
Costo real (última semana): $85
Varianza: +13.3%

Posibles causas:
  - Aumento de precio de carne
  - Desperdicio alto en cocina
  - Porciones más grandes de lo indicado
```

El sistema puede recalcular automáticamente los costos cuando cambian los precios de las materias primas.

---

## 📞 Soporte

Si tienes dudas adicionales sobre el sistema de inventario:

1. Revisa la documentación de Prisma schema: `avoqado-server/prisma/schema.prisma`
2. Consulta los tests: `avoqado-server/tests/workflows/inventory-deduction.test.ts`
3. Revisa el script de prueba: `avoqado-server/test-inventory-deduction.ts`

---

**Última actualización**: 2025-01-13
**Versión**: 1.0
