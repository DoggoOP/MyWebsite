export type Backend = 'f32' | 'f16' | 'cpu';

/** Pick the solver backend from the float render targets the GPU can write to. */
export function pickBackend(gl: Pick<WebGL2RenderingContext, 'getExtension'> | null): Backend {
  if (!gl) return 'cpu';
  if (gl.getExtension('EXT_color_buffer_float')) return 'f32';
  if (gl.getExtension('EXT_color_buffer_half_float')) return 'f16';
  return 'cpu';
}
