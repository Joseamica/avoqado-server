---
title: Gestionar terminales
description: Revisa terminales, estado de conexión y activación.
product: dashboard
category: terminales
featureCode: AVOQADO_TPVS
dashboardRoutes:
  - tpv
roles:
  - OWNER
  - ADMIN
  - MANAGER
lastVerified: 2026-11-26
sourceRepo: avoqado-web-dashboard
popular: true
keywords:
  - estado de la terminal
  - terminal pendiente
  - dice pendiente
  - falta activar la terminal
  - la terminal no aparece
  - terminal activa pero no cobra
---

## Antes de empezar

Terminales muestra los dispositivos asociados al local. Úsala para confirmar si una terminal está asignada, activa y lista para operar. Esta vista no reemplaza la revisión física del dispositivo: si una terminal no cobra, revisa también conexión, batería, sesión y estado en el equipo.

Los datos siempre dependen del local activo. Si administras varias sucursales, cambia primero a la sucursal donde está la terminal.

## Pasos

1. Abre **Dispositivos**.
2. Busca la terminal por nombre, identificador o estado.
3. Revisa si aparece activa, pendiente o con algún problema de conexión.
4. Abre el detalle si necesitas validar información del dispositivo.
5. Compara con pagos recientes si estás investigando una terminal que no refleja cobros.
6. Si se requiere activación, sigue el flujo indicado o contacta a soporte con el identificador del dispositivo.

## Problemas frecuentes

Si la terminal no aparece, puede no estar asignada al local correcto. Si aparece pendiente, falta completar activación. Si aparece activa pero no cobra, revisa conexión y estado físico. Si los pagos no coinciden, filtra **Ventas > Transacciones** por fecha y terminal cuando el filtro esté disponible.

## Diagnóstico rápido de una terminal

Cuando una terminal falla, revisa primero lo físico: batería, conexión, red, sesión y si el equipo tiene el dispositivo correcto. Después revisa el Dashboard para confirmar asignación, estado y sucursal. Esto evita escalar problemas que se resuelven con conexión o reinicio.

Si el cobro se realizó pero no aparece, busca en **Ventas > Transacciones** por hora y monto. Si hay varias terminales, anota cuál se usó y quién operó el cobro para comparar contra el historial disponible.

## Cuándo pedir ayuda

Contacta soporte si la terminal no aparece asignada, si no termina activación, si cobra pero no registra pagos o si varias terminales fallan al mismo tiempo. Comparte identificador de terminal, sucursal, hora del intento y mensaje de error.
