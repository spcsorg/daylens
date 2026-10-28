// Settings › AI.
import { Later } from './Row.tsx'

// Settings › Recording & privacy shows this; it changes here when AI is turned on.
export const WHAT_GOES_TO_AI = 'Nothing. Hours show what Daylens recorded, and nothing leaves this computer.'

export function AiTab() {
  return <Later text="Choosing an AI to write your hours comes in a later update. Until then, hours show what Daylens recorded, and nothing is sent anywhere." />
}
