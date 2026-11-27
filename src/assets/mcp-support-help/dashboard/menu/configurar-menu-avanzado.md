---
title: Configurar menú avanzado
description: Administra servicios, grupos de modificadores y paquetes de crédito del menú.
product: dashboard
category: menu
featureCode: AVOQADO_MENU
dashboardRoutes:
  - menumaker/modifier-groups
  - menumaker/services
  - menumaker/credit-packs
roles:
  - OWNER
  - ADMIN
  - MANAGER
lastVerified: 2026-11-26
sourceRepo: avoqado-web-dashboard
relatedArticles:
  - gestionar-productos
  - configurar-promociones
keywords:
  - grupo de modificadores
  - extra no aparece
  - modificador no aparece
  - no sale el extra al vender
  - el precio con el extra no cuadra
  - paquetes de crédito
  - este extra es un platillo del menú
  - ligar un extra a un platillo
  - no puedo ligar el extra al platillo
  - el extra no descuenta inventario
---

## Antes de empezar

Menú avanzado complementa productos, categorías y menús. Los grupos de modificadores permiten agregar opciones como términos, extras, tamaños o instrucciones controladas. Servicios ayudan a organizar venta por tipo de operación cuando el local maneja experiencias, reservas pagadas o conceptos distintos a productos simples. Los paquetes de crédito aplican cuando el negocio vende consumo prepagado o créditos.

Antes de editar, identifica qué producto o menú será afectado. Un modificador mal configurado puede cambiar precios, tiempos de preparación o lo que ve el equipo al tomar pedidos.

## Pasos

1. Abre **Menú** (o **Catálogo**, según tu giro) **> Grupos Modificadores**.
2. Crea o edita el grupo, nombre, opciones, reglas de selección y precios adicionales.
3. Asocia el grupo a los productos que realmente lo necesitan.
4. Entra a **Menú > Servicios** para revisar conceptos que no sean productos tradicionales.
5. Valida nombre, precio, disponibilidad y dónde se mostrará cada servicio.
6. Abre **Menú > Paquetes de Créditos** si el local vende créditos o consumo anticipado.
7. Prueba el flujo de venta después de guardar cambios relevantes.

## Un extra que es un platillo del menú

En la ficha de un extra, **Este extra es un platillo del menú** lo liga a un platillo (por ejemplo, la opción «Papa» del paquete con la «Flauta de papa»). Si el platillo lleva inventario, cada venta del extra lo descuenta (sus piezas o su receta). Si no lleva inventario, el extra no descuenta nada y la liga sólo sirve para contarlo. En los dos casos, sus unidades salen en **Reportes > Ventas por artículo**, columna **Dentro de paquete**, y no como venta suelta del platillo.

Ligar un extra es de los planes Pro y Premium; quitar la liga siempre se puede. Para que el extra descuente inventario, el platillo tiene que llevar inventario (plan Premium). Un platillo que se vende por kilo no se puede ligar.

## Problemas frecuentes

Si un modificador no aparece, confirma que el grupo esté activo y asociado al producto correcto. Si el precio final no coincide, revisa si la opción agrega costo o si el producto ya tiene otro modificador. Si credit packs no aparece, puede faltar permiso específico. Si un servicio se muestra donde no corresponde, revisa menú, categoría y disponibilidad.

## Orden recomendado de configuración

Primero crea productos y categorías base. Después crea grupos de modificadores reutilizables, evitando duplicar grupos con nombres parecidos. Por último, asigna los grupos a productos y valida con una venta de prueba. Para servicios o paquetes de crédito, define previamente reglas de uso, vigencia, reembolsos y quién puede venderlos.

Mantener la estructura limpia facilita reportes e inventario. Si cada producto tiene modificadores duplicados, será más difícil corregir precios o analizar ventas después.

## Cuándo pedir ayuda

Pide soporte si un modificador guarda pero no se asocia, si un paquete de crédito no se puede vender, si un servicio cobra un monto incorrecto o si los cambios no se reflejan después de recargar. Incluye producto, grupo, menú, sucursal y captura del flujo.
