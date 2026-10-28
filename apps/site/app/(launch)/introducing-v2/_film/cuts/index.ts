import type { Beat } from "../Film";
import { duet } from "./duet";
import { handson } from "./handson";

// Every cut of the film the recorder can play: /introducing-v2/film?cut=<name>.
export const CUTS: Record<string, Beat[]> = { duet, handson };
