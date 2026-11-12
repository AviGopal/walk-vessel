// SPDX-License-Identifier: MIT
import { PORT, VESSEL_ID } from "./config"
import { stop } from "./calls"
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
// systemd stops the walk with SIGTERM, also when a unit it is part of restarts (records, its owner seed): what is in
// flight is ended as a failure first (calls.ts stop), then the process exits.
process.on("SIGTERM", () => { void stop().finally(() => process.exit(0)) })
await register([WALK_HEARTBEAT], WRITTEN)
await Promise.all([beat(), chain()])
