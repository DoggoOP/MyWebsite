/** D2Q9 lattice tables and flow constants, copied from airflow.ts. */
export const DX = [0, 1, 0, -1, 0, 1, -1, -1, 1] as const;
export const DY = [0, 0, 1, 0, -1, 1, 1, -1, -1] as const;
export const OPP = [0, 3, 4, 1, 2, 7, 8, 5, 6] as const;
export const WT = [4 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 9, 1 / 36, 1 / 36, 1 / 36, 1 / 36] as const;
export const OMEGA = 1.84;
/** Inlet speed in lattice units, pointing along +row (down the page). */
export const LATTICE_SPEED = 0.085;
export const RHO_MIN = 0.65;
export const RHO_MAX = 1.45;
/** Collision clamps each velocity component to this magnitude. */
export const VELOCITY_LIMIT = 0.19;
/** addForce clamps each accumulated velocity increment to this magnitude. */
export const FORCE_LIMIT = 0.12;

/** Cross-stream inlet velocity at column x; tick counts lattice steps. */
export function inletRipple(x: number, tick: number): number {
  return 0.0035 * Math.sin(x * 0.085 + tick * 0.025) + 0.0015 * Math.sin(x * 0.21 - tick * 0.031);
}
