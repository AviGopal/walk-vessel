// SPDX-License-Identifier: MIT
import { PORT } from "./config"
import { beat, register } from "./heartbeat"
import { chain } from "./loop"
import { WALK_HEARTBEAT } from "./shapes"

Bun.serve({ port: PORT, idleTimeout: 0, fetch: () => new Response(null, { status: 404 }) })
await register([WALK_HEARTBEAT])
await Promise.all([beat(), chain()])
