// SPDX-License-Identifier: MIT
import { PORT, VESSEL_ID } from "./config"
import { stop } from "./calls"
import { beat, register } from "./heartbeat"
import { chain } from "./loop"
import { HEALTH, IMPULSE_RESOLVE } from "./routes"
import { WALK_HEARTBEAT } from "./shapes"
import { WRITTEN } from "./written"

Bun.serve({
  port: PORT,
  idleTimeout: 0,
  routes: {
    [HEALTH]: { GET: () => Response.json({ vessel: VESSEL_ID }) },
    // The shape this vessel registers is answered, so a caller routing it through discovery learns that a walk is
    // serving (from this node or a peer). A read: no row is written and nothing else is told. Any other shape is
    // refused by name, apart from a request that reached no route at all.
    [IMPULSE_RESOLVE]: {
      POST: async (req) => {
        const body = (await req.json().catch(() => ({}))) as { pointer?: { type?: unknown }; impulse?: { pointer?: { type?: unknown } } }
        const type = (body.impulse?.pointer ?? body.pointer)?.type
        return type === WALK_HEARTBEAT
          ? Response.json({ vessel: VESSEL_ID, alive: true })
          : Response.json({ error: `not served here: ${String(type)}` }, { status: 404 })
      },
    },
  },
  fetch: () => new Response(null, { status: 404 }),
})
// systemd stops the walk with SIGTERM, also when a unit it is part of restarts (records, its owner seed): what is in
// flight is ended as a failure first (calls.ts stop), then the process exits.
process.on("SIGTERM", () => { void stop().finally(() => process.exit(0)) })
await register([WALK_HEARTBEAT], WRITTEN)
await Promise.all([beat(), chain()])
