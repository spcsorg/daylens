import type { ReactNode } from "react";
import type { Beat, Ratio } from "../Film";
import { duet } from "./duet";
import { mymind } from "./mymind";

// Every cut of the film the recorder can play: /introducing-v2/film?cut=<name>.
export const CUTS: Record<string, Beat[]> = { duet };

// A cut with a stage of its own, which draws every frame itself instead of playing beats through Film.
export type Stage = { length: number; render: (t: number, ratio: Ratio) => ReactNode };
export const STAGES: Record<string, Stage> = { mymind };
