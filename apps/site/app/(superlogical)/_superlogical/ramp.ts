// Superlogical's "sherbet" ramp. The panel shows ramp positions smoothstep(0.5 * progress + 0.5 * y).
export type Stop = [number, [number, number, number]];

export const SHERBET: Stop[] = [
  [0, [209, 182, 254]],
  [0.165, [255, 145, 105]],
  [0.87, [214, 248, 126]],
  [1, [225, 251, 150]],
];

// Dark mode lowers the last two stops to OKLab L 0.42 and 0.3, as the reference does.
export const SHERBET_DARK: Stop[] = [
  [0, [209, 182, 254]],
  [0.165, [255, 145, 105]],
  [0.87, [64, 88, 0]],
  [1, [38, 53, 0]],
];
