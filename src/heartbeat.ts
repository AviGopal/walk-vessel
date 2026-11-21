// SPDX-License-Identifier: MIT
import { DISCOVERY_URL, ENDPOINT, KEY, VESSEL_ID } from "./config"
import { gateUndecided, READ_AGAIN_MS, READ_WAIT_MS } from "./calls"
import { AUTH_SCHEME, HEARTBEAT, REGISTER } from "./routes"

type Answer = { nextHeartbeatMs: number }

const NO_LIMIT_MS = 2147483647

const post = async (path: string, payload: object): Promise<Answer> => {
  const init = {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `${AUTH_SCHEME} ${KEY}` },
    body: JSON.stringify(payload),
    timeout: false,
  }
  // As every call the walk makes (calls.ts resolve): an error on the way is an outage, asked again within READ_WAIT_MS,
  // never a throw out of the heartbeat that ends the walk with its calls in flight, and so is discovery saying identity could
  // not decide on the key (calls.ts gateUndecided). A refusal still stops it.
  const start = Date.now()
  for (;;) {
    try {
      const r = await fetch(new URL(path, DISCOVERY_URL).href, init)
      if (!r.ok) {
        const text = await r.text()
        if (gateUndecided(r.status, text) && Date.now() - start < READ_WAIT_MS) {
          console.error(`${path} answered ${r.status}: ${text}; asking again`)
          await Bun.sleep(READ_AGAIN_MS)
          continue
        }
        console.error(`${path} answered ${r.status}: ${text}`)
        process.exit(1)
      }
      return (await r.json()) as Answer
    } catch (e) {
      if (Date.now() - start >= READ_WAIT_MS) {
        console.error(`${path}: no answer for ${Math.round(READ_WAIT_MS / 1000)} s (${e instanceof Error ? e.name : String(e)}); stopping so the unit restarts`)
        process.exit(1)
      }
      console.error(`${path}: no answer (${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}); asking again`)
      await Bun.sleep(READ_AGAIN_MS)
    }
  }
}

// shapes: what this vessel serves. written: rows it writes but does not serve, each with what it is (discovery keeps
// them apart, as data_shapes, so none of them is ever routed or offered as a call).
export const register = async (shapes: string[], written: Record<string, string> = {}): Promise<void> => {
  const writes = Object.keys(written)
  await post(REGISTER, {
    vesselId: VESSEL_ID, endpoint: ENDPOINT, shapes, resolve_timeout_ms: NO_LIMIT_MS,
    ...(writes.length > 0 ? { writes, shape_descriptions: written } : {}),
  })
}

export const beat = async (): Promise<void> => {
  while (true) {
    const a = await post(HEARTBEAT, { vesselId: VESSEL_ID })
    await Bun.sleep(a.nextHeartbeatMs)
  }
}
