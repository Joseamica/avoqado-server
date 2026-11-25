---
title: Activar, ajustar o pausar el programa de referidos
description: Prende el programa de referidos con el premio del cliente nuevo y los tres niveles de quien recomienda, cambia un nivel o pausa la captura de códigos.
product: dashboard
category: clientes
featureCode: REFERRAL_PROGRAM
dashboardRoutes:
  - referrals
roles:
  - OWNER
  - ADMIN
lastVerified: 2026-11-25
sourceRepo: avoqado-web-dashboard
sourceRef: 501e37072a13f5ed8f22e3d650f2598d3d8820b6
relatedArticles:
  - gestionar-clientes
keywords:
  - programa de referidos
  - código de referido
  - activar referidos
  - premio por recomendar
  - niveles de referidos
  - pausar referidos
  - cliente recomienda a otro
  - descuento por referido
---

## Antes de empezar

El programa de referidos viene en el plan **Pro**. Verlo pide permiso para ver referidos; activarlo, editar un nivel o pausarlo pide el permiso para configurarlo, que de fábrica tienen el administrador y el dueño. Sin él sale «No tienes permisos para configurar el programa de referidos. Pídelo a un administrador.».

Así funciona: el cliente nuevo da al pagar el código de quien lo recomendó y recibe un **% de descuento en su primera compra**. Quien recomienda sube de nivel cuando junta referidos que ya compraron, y en cada nivel gana un premio.

## Pasos

1. Abre **Clientes > Programa de Referidos**.
2. En **Premio al referido (su primera compra)**, escribe el % de descuento del cliente nuevo.
3. En **Niveles de quien recomienda**, para cada **Nivel** escribe los **Referidos requeridos** y el **Premio %**. Abajo, escribe la **Vigencia del cupón (días)** de esos premios.
4. Toca **Activar programa de referidos**. Sale «Programa activado correctamente» y la página muestra «✓ Activo desde …» con el **Resumen del mes**.
5. Para cambiar un nivel ya activo, toca **Editar nivel** junto a ese nivel. Ajusta los **Referidos requeridos** y cada premio: **Cupón de descuento** o **Producto gratis** (con su **Producto**, **Cantidad** y **Recurrencia**). Con **Agregar otro premio** sumas otro. Toca **Guardar cambios**.
6. Para detenerlo, toca **Pausar programa**, escribe la **Razón de pausa** si quieres y toca **Pausar**. Los códigos existentes se conservan, pero ya no se pueden capturar códigos nuevos al cobrar hasta que lo vuelvas a activar.

## Problemas frecuentes

- **«Debe ser mayor a … (el umbral del nivel anterior)»** o **«Debe ser menor a … (el umbral del siguiente nivel)»:** cada nivel necesita más referidos que el anterior y menos que el siguiente.
- **«Agrega al menos un premio para este nivel»:** cada nivel lleva por lo menos un premio.
- **«Selecciona un producto para este premio»:** un **Producto gratis** necesita su producto. Este premio lo entrega el personal a mano: no se aplica solo al cobrar.
- **Descuento permanente** sale apagado con «Requiere actualización de la terminal (próximamente)»: todavía no se puede elegir.
- **El cajero no puede capturar el código:** revisa que el programa siga activo (no pausado). En el punto de venta y en la terminal, el código se captura en el cobro con un cliente ya elegido y necesita internet.
- **¿Dónde está el código de un cliente?** En la ficha del cliente, en **Programa de Referidos**. Si dice «Esta persona aún no tiene código activo.», quien puede configurar referidos toca **Activar código ahora**; luego se puede **Copiar** o mandar por **WhatsApp**.
