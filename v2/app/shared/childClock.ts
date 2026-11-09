// The first import of every Node process the app starts: it moves that process's clock by the offset main handed down.
import { OFFSET_ENV, shiftClock } from './clock.ts'

shiftClock(Number(process.env[OFFSET_ENV]))
