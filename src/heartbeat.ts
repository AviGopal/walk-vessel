// SPDX-License-Identifier: MIT
import { DISCOVERY_URL, ENDPOINT, KEY, VESSEL_ID } from "./config"
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
  const r = await fetch(new URL(path, DISCOVERY_URL).href, init)
  if (!r.ok) {
    console.error(`${path} answered ${r.status}: ${await r.text()}`)
    process.exit(1)
  }
  return (await r.json()) as Answer
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
