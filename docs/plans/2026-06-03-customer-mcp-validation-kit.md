# Customer MCP — Validation Kit (run on 1 real operator)

**Goal:** In ~15 minutes, learn whether a real venue operator _pulls_ for an AI agent connected to their Avoqado — **before** spending days
on OAuth + deploy. One operator, one sitting. This is the office-hours discipline: validate demand with the cheapest possible build (which
already exists — 7 scoped read tools).

**What "pull" means:** they ask their own questions, they reach for it to answer something they actually wanted to know, or they ask "how do
I get this / can it _do_ things / how much?". Polite nods are not pull.

---

## 0. Setup (2 min — on your machine)

```bash
# terminal 1 — start the scoped read server (auto-OWNER token printed too)
cd avoqado-server/.worktrees/customer-mcp
npm run dev                       # (or: MCP_DEV_PORT=4100 npx tsx scripts/mcp-dev-server.ts)

# terminal 2 — connect THIS operator's real venues by their email
npx tsx scripts/mcp-token-for.ts maria@elcliente.com
# → copy the printed `claude mcp add … --header "Authorization: Bearer …"` line and run it
```

Open Claude → the `avoqado` MCP is connected, **scoped to that operator's real venues** (their data, not seed). Token lasts 12h.

> **Constraint:** the URL is `localhost`, so this is a **guided / screen-share / in-person** demo (you drive or sit beside them). A remote
> hands-off trial needs a staging deploy — deliberately not built yet (don't pay for it until this sitting says it's worth it).

---

## 1. The demo arc — hand them the keyboard after Q2

Ask Claude these in natural language (let _them_ phrase it once they catch on):

| Ask Claude (natural language)                       | Tool it hits           | Watch for                                      |
| --------------------------------------------------- | ---------------------- | ---------------------------------------------- |
| "¿Cuáles son mis sucursales?"                       | `list_my_venues`       | warm-up                                        |
| "¿Cómo van mis ventas hoy / esta semana?"           | `daily_sales`          | do they expect _more_ — margins, vs last week? |
| "Muéstrame mis últimas órdenes"                     | `recent_orders`        | —                                              |
| "¿Dónde se vendió el serial / la SIM \_\_\_?"       | `find_order`           | ⭐ the wow for serial/inventory businesses     |
| "¿Qué reservas tengo esta semana?"                  | `reservations`         | —                                              |
| "¿Tengo alguna terminal mal configurada?"           | `audit_terminals`      | "no sabía que podía ver eso"                   |
| "¿Cuánto inventario serializado me queda?"          | `serialized_inventory` | —                                              |
| _(you, quietly)_ "¿y las ventas de [otro negocio]?" | scope guard            | **it refuses** → the trust moment              |

**After Q2, stop driving. Hand them the keyboard.** The single most valuable data point of the whole sitting is _what they type when you're
not steering_.

---

## 2. Read the signal (write it down as it happens)

**STRONG pull → build more:**

- They ask a question you didn't script.
- They ask **"can it _do_ things?"** (create/edit/charge) → that's the pull toward Phase 2 writes.
- They ask **"how do I get this? when? how much?"** → buying signal.
- They use it to answer something they genuinely wanted to know today.
- They get quiet and _keep typing_.

**WEAK / none → park it:**

- Polite nods, "qué padre", no follow-up question.
- They'd rather just open the dashboard.
- They can't think of anything to ask after the scripted arc.

---

## 3. The close — one question

> "Si esto viviera en **tu** Claude conectado a tu Avoqado, ¿lo abrirías el lunes? ¿Qué sería lo **primero** que le pedirías — y eso hoy lo
> haces en el dashboard o no?"

The answer to _"qué le pedirías primero"_ is your Phase 2 roadmap, for free. If it's a **write** ("que me cambie el precio", "que cree la
reserva"), note it — that's where the real value (and willingness to pay) lives.

---

## 4. Log it (2 min, right after)

Drop raw notes in `Avoqado-HQ/customer-calls/`. The one line that matters: **did they pull, or were they just polite?** Plus their first
unprompted ask, verbatim.

**Decision rule:** 3 operators independently reaching for the _same_ unprompted thing = build that next. One excited operator = promising.
Zero pull across 3 = you just saved yourself the entire OAuth + deploy build. That's a win either way.

---

## If the signal is STRONG → then, in order

1. **Deploy Phase 0 to staging** — make it reachable for hands-off trials (cheaper than OAuth).
2. **Execute the Phase 1 OAuth plan** — `docs/plans/2026-06-03-customer-mcp-phase1-oauth-plan.md` (connect without a pasted token).
3. **Start Phase 2 writes** — on whatever they pulled for (preview+confirm, T1 only).

## If WEAK → park it

The 7 tools + the plan stay on the branch, committed, costing nothing. You learned the market truth for the price of one coffee instead of
two weeks of plumbing.
