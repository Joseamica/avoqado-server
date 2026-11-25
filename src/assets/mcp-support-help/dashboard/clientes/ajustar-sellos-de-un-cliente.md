---
title: Ajustar los sellos de un cliente desde su ficha
description: En la ficha del cliente, fija cuántos sellos tiene en su tarjeta actual, con un motivo, por ejemplo si venía de otro programa o se le olvidó un sello.
product: dashboard
category: clientes
featureCode: LOYALTY_PROGRAM
dashboardRoutes:
  - customers/:customerId
  - loyalty/card
roles:
  - OWNER
  - ADMIN
  - MANAGER
lastVerified: 2026-11-25
sourceRepo: avoqado-web-dashboard
sourceRef: 501e37072a13f5ed8f22e3d650f2598d3d8820b6
relatedArticles:
  - configurar-lealtad
  - disenar-tarjeta-digital
keywords:
  - ajustar sellos
  - corregir sellos
  - poner sellos a mano
  - se le olvidó un sello
  - le faltan sellos al cliente
  - tarjeta de sellos
  - venía de otro sistema de lealtad
---

## Antes de empezar

La tarjeta de sellos viene con el programa de lealtad del plan **Pro**. **Ajustar sellos** pide el permiso de ajustar la lealtad, que de fábrica tienen el gerente, el administrador y el dueño.

La sección de sellos sale en la ficha del cliente cuando el negocio tiene la tarjeta de sellos. Si el programa de sellos está apagado, el ajuste no se guarda y sale «El programa de sellos está apagado».

El ajuste no suma ni resta: **fija el total** de sellos que debe tener la tarjeta actual del cliente.

## Pasos

1. Abre **Clientes > Todos los Clientes** y toca al cliente.
2. En su tarjeta de sellos ves «… de … sellos» y, si tiene, los premios por canjear. Toca **Ajustar sellos**.
3. En **¿Cuántos sellos tiene?**, escribe el total que debe quedar, de 0 al máximo de la tarjeta.
4. Abajo sale cómo queda: «Pasa de … a … sellos». Si llega al máximo, dice que completa la tarjeta, gana su premio y empieza una nueva en 0.
5. Escribe el **Motivo** (por ejemplo, «Venía de otro sistema de lealtad»), de al menos 5 letras.
6. Toca **Guardar**. Sale «Sellos ajustados».

## Problemas frecuentes

- **El botón Guardar está apagado:** revisa que el número esté entre 0 y el máximo de la tarjeta y que el motivo tenga al menos 5 letras.
- **«Los sellos de este cliente cambiaron mientras tanto: ahora tiene …»:** alguien le selló una compra mientras ajustabas. Revisa el número nuevo y vuelve a intentar.
- **«No se pudieron ajustar los sellos»:** lee el mensaje que trae y vuelve a intentar; si se repite, pide que lo revise una persona del equipo de Avoqado.
- **No sale Ajustar sellos:** te falta el permiso de ajustar la lealtad.
- **Para cambiar cuántos sellos pide la tarjeta o el premio**, ve a la configuración del programa de lealtad; aquí sólo se corrige la tarjeta de un cliente.
