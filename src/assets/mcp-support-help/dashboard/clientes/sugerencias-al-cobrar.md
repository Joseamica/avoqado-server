---
title: Sugerencias al cobrar («¿Algo más?» en la pantalla del cliente)
description: Elige qué productos se le ofrecen al cliente en su pantalla antes de pagar, activa las que te proponemos, crea las tuyas o genéralas con IA.
product: dashboard
category: clientes
featureCode: UPSELL
dashboardRoutes:
  - promotions/upsell
roles:
  - OWNER
  - ADMIN
  - MANAGER
lastVerified: 2026-11-25
sourceRepo: avoqado-web-dashboard
sourceRef: 501e37072a13f5ed8f22e3d650f2598d3d8820b6
relatedArticles:
  - configurar-promociones
keywords:
  - sugerencias al cobrar
  - algo más
  - upsell
  - ofrecer un producto al cobrar
  - subir el ticket promedio
  - el cliente ve sugerencias en su pantalla
  - generar sugerencias con IA
  - no aparecen las sugerencias
---

## Antes de empezar

Las sugerencias al cobrar vienen en el plan **Pro**; **Generar con IA** es de **Premium**. Ver la página pide permiso para ver sugerencias; crear, activar o cambiar dónde aparecen pide los permisos de crear y editar sugerencias, que de fábrica tienen el gerente, el administrador y el dueño.

Cuando el cajero da **Cobrar**, al cliente le aparecen hasta 3 productos en su pantalla con un «¿Algo más?». Toca los que quiera y confirma; se agregan a su cuenta antes de pagar. El cajero también las ve en su pantalla.

**Nada se sugiere solo:** primero, en la ficha de cada producto del menú, prende **Sugerir en promociones**. Apagado, ese producto no lo sugiere nada ni nadie. En 1 de cada 10 ventas, al azar, no se muestra nada: así se mide el aumento real del ticket.

## Pasos

1. Abre **Promociones > Sugerencias al cobrar**.
2. En **¿Dónde aparece?**, prende **En el mostrador**. Las otras dos opciones dicen **Próximamente**.
3. En **Esperan tu decisión**, revisa lo que te proponemos (sale de lo que tus tickets muestran que se vende junto) y toca **Activar** en la que quieras, o la **X** para descartarla.
4. Para crear una tuya, en **Activas** toca **Nueva**. Elige el **Momento** (**Siempre, en cualquier cuenta** o **Sólo si ya llevan cierto producto**, con su **Producto que dispara**), el **Producto a sugerir** y, si quieres, el **Gancho (opcional)**.
5. Revisa **Así se va a ver la tarjeta** y toca **Crear**. Sale «Sugerencia creada».
6. En Premium, toca **Generar con IA** para que te proponga sugerencias a partir de tu menú; quedan en **Esperan tu decisión**.

## Problemas frecuentes

- **No aparece ninguna sugerencia al cobrar:** revisa que **En el mostrador** esté prendido, que haya sugerencias en **Activas** y que el producto sugerido tenga prendido **Sugerir en promociones**.
- **«Todavía no hay sugerencias activas.»:** marca productos como sugeribles desde su ficha; de ahí en adelante te proponemos solas, cada noche, las que tus tickets muestran que se venden juntas.
- **«Generar con IA es de Premium»:** el resto de las sugerencias funciona en tu plan.
- **«Ya se generaron hoy»** o **«Falta marcar productos»** al generar con IA: espera al día siguiente, o marca productos como sugeribles.
- **Una propuesta dice que el producto pide opciones:** descártala y créala de nuevo con **Nueva** para elegir la opción.
- **Para quitar una activa**, toca el bote de basura en su renglón.
- **Cuánto vende:** arriba, **Se ofreció** y **Ventas atribuidas** dicen cuántas veces salió y cuánto se vendió por las sugerencias.
