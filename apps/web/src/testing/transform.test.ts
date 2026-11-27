import { describe, expect, it } from 'vitest';
import { transformOf } from './transform.ts';

const el = (transform: string) => {
  const d = document.createElement('div');
  d.style.transform = transform;
  return d;
};

describe('transformOf', () => {
  it('reads translate and scale whatever spacing or zero-dropping jsdom applies', () => {
    expect(transformOf(el('translate(280px,0px)'))).toEqual({ x: 280, y: 0, scale: 1 });
    expect(transformOf(el('translate(280px)'))).toEqual({ x: 280, y: 0, scale: 1 });
    expect(transformOf(el('translate(12px, 34px) scale(0.5)'))).toEqual({
      x: 12,
      y: 34,
      scale: 0.5,
    });
    expect(transformOf(el('translate(-1.5px,-2px)'))).toEqual({ x: -1.5, y: -2, scale: 1 });
    expect(transformOf(el(''))).toEqual({ x: 0, y: 0, scale: 1 });
  });
});
