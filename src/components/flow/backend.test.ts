import { test, expect } from 'vitest';
import { pickBackend } from './backend';

function fakeGl(available: string[]) {
  return { getExtension: (name: string) => (available.includes(name) ? {} : null) } as unknown as Pick<WebGL2RenderingContext, 'getExtension'>;
}

test('picks f32 when EXT_color_buffer_float exists', () => {
  expect(pickBackend(fakeGl(['EXT_color_buffer_float']))).toBe('f32');
});

test('picks f32 when both float and half-float extensions exist', () => {
  expect(pickBackend(fakeGl(['EXT_color_buffer_float', 'EXT_color_buffer_half_float']))).toBe('f32');
});

test('picks f16 when only EXT_color_buffer_half_float exists', () => {
  expect(pickBackend(fakeGl(['EXT_color_buffer_half_float']))).toBe('f16');
});

test('picks cpu when neither extension exists', () => {
  expect(pickBackend(fakeGl([]))).toBe('cpu');
});

test('picks cpu for a null context', () => {
  expect(pickBackend(null)).toBe('cpu');
});
