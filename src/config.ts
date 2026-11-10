// SPDX-License-Identifier: MIT
const need = (name: string, v: string | undefined): string => {
  if (v === undefined) {
    console.error(`missing env ${name}`)
    process.exit(1)
  }
  return v
}
export const VESSEL_ID = need("WALK_VESSEL_ID", process.env.WALK_VESSEL_ID)
export const PORT = Number(need("WALK_PORT", process.env.WALK_PORT))
export const DISCOVERY_URL = need("DISCOVERY_URL", process.env.DISCOVERY_URL)
export const ENDPOINT = need("WALK_ENDPOINT", process.env.WALK_ENDPOINT)
export const KEY = need("METABOB_API_KEY", process.env.METABOB_API_KEY)
