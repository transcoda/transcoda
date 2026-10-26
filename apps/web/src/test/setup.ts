// jsdom polyfills for every web test (vite.config.ts `test.setupFiles`). Each one is guarded so a
// future jsdom that implements the API wins.

import * as webStreams from 'node:stream/web';
import { configure } from '@testing-library/react';
import { vi } from 'vitest';

// The vmThreads pool runs each file in a VM context whose jsdom global lacks the Web Streams
// classes Node has; @orpc/client needs TransformStream. Lend Node's where they are missing.
for (const name of [
  'ReadableStream',
  'WritableStream',
  'TransformStream',
  'TextEncoderStream',
  'TextDecoderStream',
] as const) {
  if (!(name in globalThis)) Object.assign(globalThis, { [name]: webStreams[name] });
}

// `pnpm check` runs every workspace's tests in parallel, so a jsdom worker can get a fraction of a
// core and a render that takes 50 ms alone takes seconds. Testing Library's 1 s default for
// findBy*/waitFor then expires on healthy code. Only a failing wait pays this ceiling.
configure({ asyncUtilTimeout: 8000 });

if (!globalThis.ResizeObserver) {
  // Fires once, synchronously, on observe so React Flow measures nodes (cards are 210 x 120; groups
  // read their size from style) and computes handle bounds.
  class ResizeObserverStub {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element): void {
      const entry = { target, contentRect: { width: 210, height: 120 } };
      this.callback([entry as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}

// jsdom has no layout, so offsetWidth/offsetHeight are always 0 and React Flow (which measures
// with them, not with the ResizeObserver entry) would never store dimensions or handle bounds, and
// edges would not render. React Flow node wrappers report their inline style size (groups) or the
// card size 210 x 120; every other element keeps jsdom's 0.
const jsdomOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
const jsdomOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
if (
  jsdomOffsetWidth?.get &&
  jsdomOffsetHeight?.get &&
  document.createElement('div').offsetWidth === 0
) {
  const nodeSize = (el: HTMLElement, axis: 'width' | 'height', fallback: number): number | null => {
    if (!el.classList.contains('react-flow__node')) return null;
    const styled = Number.parseFloat(el.style[axis]);
    return Number.isFinite(styled) && styled > 0 ? styled : fallback;
  };
  const width = jsdomOffsetWidth.get;
  const height = jsdomOffsetHeight.get;
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return nodeSize(this, 'width', 210) ?? width.call(this);
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return nodeSize(this, 'height', 120) ?? height.call(this);
    },
  });
}

if (!globalThis.DOMMatrixReadOnly) {
  // Identity matrix: React Flow only reads the zoom (m22) from the viewport's transform.
  class DOMMatrixReadOnlyStub {
    readonly m22 = 1;
  }
  globalThis.DOMMatrixReadOnly = DOMMatrixReadOnlyStub as unknown as typeof DOMMatrixReadOnly;
}

if (!window.matchMedia) {
  // Tests override `matches` per case.
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
}
if (!HTMLDialogElement.prototype.show) {
  HTMLDialogElement.prototype.show = function show(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
}
if (!HTMLDialogElement.prototype.close) {
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
}

if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

if (!navigator.clipboard) {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn() },
    configurable: true,
  });
}
