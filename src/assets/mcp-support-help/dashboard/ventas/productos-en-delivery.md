---
title: Qué productos subes a cada app de delivery
description: Elige qué productos de tu carta publicas en Uber Eats y en Rappi y con qué precio, desde Delivery o desde la ficha del producto («Vender en»).
product: dashboard
category: ventas
featureCode: DELIVERY_CHANNELS
dashboardRoutes:
  - delivery
roles:
  - OWNER
  - ADMIN
  - MANAGER
lastVerified: 2026-11-26
sourceRepo: avoqado-web-dashboard
relatedArticles:
  - agotados-por-inventario-en-delivery
  - horario-margen-y-modo-de-aceptacion
  - problemas-con-pedidos-de-delivery
keywords:
  - el producto no aparece en Rappi
  - el producto no aparece en Uber
  - cómo quito un producto de Rappi
  - cómo quito un producto de Uber
  - quiero volver a publicar todo
  - volver a todo el catálogo en Rappi
  - el producto nuevo no sale en Rappi
  - vender en
---

## Antes de empezar

Delivery es una función del plan **Premium**. Si tu plan no la incluye, la pantalla se ve con candado.

Quién puede qué:

- **Dueño y administrador**: conectan, cambian horario, margen, productos e impresión, prenden o apagan **Recibir pedidos** y cambian el modo de aceptación.
- **Gerente**: ve la pantalla de Delivery, pero no cambia la configuración.

## Pasos

### Qué productos subes a cada app

Cada canal tiene su propia lista, sus propios precios y su propia regla de agotados. Todo está en **Horario, precios, productos e impresión**, en **Productos en Rappi** (o **Productos en Uber Eats**).

- **Publica todo tu catálogo**: viene así al conectar. Lo que des de alta después también se publica.
- **Elegir cuáles**: para marcar producto por producto. Busca por nombre o código; **Todos** marca o desmarca una categoría completa; arriba ves cuántos llevas («12 de 80»).
- **Precio fijo por canal**: junto a cada producto puedes escribir un precio distinto para ese canal, con IVA incluido. Vacío, se publica con tu margen («Sin precio fijo se publica en $…»).
- **Rappi sólo acepta pesos enteros**: si escribes $47.50, te dice «Rappi lo publica en $48».
- Un canal necesita al menos un producto. Si no quieres vender ahí por un tiempo, apaga **Recibir pedidos** en la tarjeta del canal.

Con **Elegir cuáles**, un producto que das de alta después **no se publica solo**. Arriba de la lista sale «2 productos nuevos no están en Rappi»: con **Revisarlos** ves sólo esos para marcarlos, y con **Ya los revisé** se quita el aviso. Si borraste de tu carta un producto que estaba en la lista, el aviso trae **Quitarlos**.

¿Ya no quieres una lista? En la misma sección presiona **Publicar todo mi catálogo** y confirma con **Publicar todo**: el canal vuelve a publicar todo, con lo que des de alta después incluido. Los precios que pusiste para ese canal se conservan, y el cambio se guarda al presionar **Guardar**.

### Desde la ficha del producto: «Vender en»

Al crear o editar un producto en **Menú > Productos**, la casilla **Vender en** dice en qué apps aparece. Marca o desmarca y guarda.

- Si el canal publicaba todo tu catálogo y le quitas la marca a un producto, el canal pasa a publicar sólo los que elijas (todos menos ése). Te lo avisa antes de guardar.
- La casilla sólo aparece si tienes un canal conectado y permiso para administrar los canales.
- Si dice «El producto se guardó, pero no se pudo agregar a Rappi: inténtalo desde Delivery», hazlo desde **Productos en Rappi**.

## Problemas frecuentes

**Un producto no aparece en Rappi o en Uber.** Revisa en **Productos en <canal>** si el canal está en **Elegir cuáles** y ese producto no está marcado, o si es un producto nuevo (busca el aviso «productos nuevos no están en…»). Revisa también si está agotado por inventario o si el canal dice **Pausado**.

**Quiero volver a publicar todo mi catálogo en una app.** En **Productos en <canal>** presiona **Publicar todo mi catálogo**, confirma con **Publicar todo** y guarda.

**Quiero quitar un producto de una app.** Desmárcalo en **Productos en <canal>** o en la casilla **Vender en** del producto, y guarda.
