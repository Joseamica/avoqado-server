---
title: Configurar menu avanzado
description: Administra servicios, grupos de modificadores y paquetes de credito del menu.
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
lastVerified: 2026-05-21
sourceRepo: avoqado-web-dashboard
relatedArticles:
  - gestionar-productos
  - configurar-promociones
---

## Antes de empezar

Menu avanzado complementa productos, categorias y menus. Los grupos de modificadores permiten agregar opciones como terminos, extras, tamanos o instrucciones controladas. Servicios ayudan a organizar venta por tipo de operacion cuando el local maneja experiencias, reservas pagadas o conceptos distintos a productos simples. Los paquetes de credito aplican cuando el negocio vende consumo prepagado o creditos.

Antes de editar, identifica que producto o menu sera afectado. Un modificador mal configurado puede cambiar precios, tiempos de preparacion o lo que ve el equipo al tomar pedidos.

## Pasos

1. Abre **Menu > Grupos de modificadores**.
2. Crea o edita el grupo, nombre, opciones, reglas de seleccion y precios adicionales.
3. Asocia el grupo a los productos que realmente lo necesitan.
4. Entra a **Menu > Servicios** para revisar conceptos que no sean productos tradicionales.
5. Valida nombre, precio, disponibilidad y donde se mostrara cada servicio.
6. Abre **Menu > Paquetes de credito** si el local vende creditos o consumo anticipado.
7. Prueba el flujo de venta despues de guardar cambios relevantes.

## Problemas frecuentes

Si un modificador no aparece, confirma que el grupo este activo y asociado al producto correcto. Si el precio final no coincide, revisa si la opcion agrega costo o si el producto ya tiene otro modificador. Si credit packs no aparece, puede faltar permiso especifico. Si un servicio se muestra donde no corresponde, revisa menu, categoria y disponibilidad.

## Orden recomendado de configuracion

Primero crea productos y categorias base. Despues crea grupos de modificadores reutilizables, evitando duplicar grupos con nombres parecidos. Por ultimo, asigna los grupos a productos y valida con una venta de prueba. Para servicios o paquetes de credito, define previamente reglas de uso, vigencia, reembolsos y quien puede venderlos.

Mantener la estructura limpia facilita reportes e inventario. Si cada producto tiene modificadores duplicados, sera mas dificil corregir precios o analizar ventas despues.

## Cuando pedir ayuda

Pide soporte si un modificador guarda pero no se asocia, si un paquete de credito no se puede vender, si un servicio cobra un monto incorrecto o si los cambios no se reflejan despues de recargar. Incluye producto, grupo, menu, sucursal y captura del flujo.
