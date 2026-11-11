// SPDX-License-Identifier: MIT
import { PORT, VESSEL_ID } from "./config"
import { beat, register } from "./heartbeat"
import { chain } from "./loop"
import { HEALTH } from "./routes"
import { WALK_HEARTBEAT } from "./shapes"
import { WRITTEN } from "./written"

Bun.serve({
  port: PORT,
  idleTimeout: 0,
  routes: { [HEALTH]: { GET: () => Response.json({ vessel: VESSEL_ID }) } },
  fetch: () => new Response(null, { status: 404 }),
})
await register([WALK_HEARTBEAT], WRITTEN)
await Promise.all([beat(), chain()])
