import type { Beat } from "../Film";
import { tour } from "./tour";

// Every cut of the film the recorder can play: /introducing-v2/film?cut=<name>.
export const CUTS: Record<string, Beat[]> = { tour };
