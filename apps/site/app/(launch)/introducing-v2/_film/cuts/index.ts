import type { Beat } from "../Film";
import { dots } from "./dots";
import { duet } from "./duet";

// Every cut of the film the recorder can play: /introducing-v2/film?cut=<name>.
export const CUTS: Record<string, Beat[]> = { duet, dots };
