import { type ReactNode, useRef } from 'react';
import { Icon } from '../../components/Icon.tsx';
import { ARROWED } from '../flow/edge-style.ts';

/** A key line in the canvas edge style `edge-<kind>`, with its arrowhead when the canvas draws one. */
function Line({
  kind,
  children,
}: {
  kind: 'file' | 'path' | 'data' | 'untaken' | 'broken';
  children: string;
}) {
  const arrow = ARROWED.has(`edge-${kind}`);
  return (
    <span className="legend-item">
      <svg
        width="26"
        height="8"
        viewBox="0 0 26 8"
        aria-hidden="true"
        className={`legend-line is-${kind}`}
      >
        <path className="legend-stroke" d={arrow ? 'M2 4 H18' : 'M2 4 H24'} />
        {arrow && <path className="legend-arrow" d="M18 0 L25 4 L18 8 Z" />}
      </svg>
      <span>{children}</span>
    </span>
  );
}

function Item({ swatch, children }: { swatch: string; children: ReactNode }) {
  return (
    <span className="legend-item">
      <span className={`legend-swatch ${swatch}`} aria-hidden="true" />
      <span>{children}</span>
    </span>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="legend-row">
      <span className="legend-label">{label}</span>
      <div className="legend-items">{children}</div>
    </div>
  );
}

function Key({ k, children }: { k: string; children: string }) {
  return (
    <span className="legend-item">
      <kbd>{k}</kbd>
      <span>{children}</span>
    </span>
  );
}

/** Screen 05's colour key and shortcuts, a "Key" disclosure at the bottom left of the canvas (closed by its Close button or Escape). */
export function CanvasLegend() {
  const details = useRef<HTMLDetailsElement>(null);
  const toggle = useRef<HTMLElement>(null);
  function close() {
    if (details.current) details.current.open = false;
    toggle.current?.focus();
  }
  return (
    <details ref={details} className="canvas-legend nopan nowheel">
      <summary ref={toggle} className="canvas-legend-toggle" title="Colour key and shortcuts">
        <Icon name="info" size={16} />
        Key
      </summary>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Escape from the focused Close button or key closes the key. */}
      <div
        className="canvas-legend-body"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            close();
          }
        }}
      >
        <button type="button" className="panel-close" aria-label="Close key" onClick={close}>
          <Icon name="cross" size={16} strokeWidth={2.4} />
        </button>
        <Row label="Lines">
          <Line kind="file">file flow</Line>
          <Line kind="path">path this file took (moving)</Line>
          <Line kind="data">data, value on the line</Line>
          <Line kind="untaken">not taken</Line>
          <Line kind="broken">leads to a broken node</Line>
        </Row>
        <Row label="Handles">
          <Item swatch="is-file-in">file in</Item>
          <Item swatch="is-file-out">file out</Item>
          <Item swatch="is-data-in">data in</Item>
          <Item swatch="is-data-out">data out</Item>
          <span className="legend-item">
            <span className="legend-port is-pass">Yes</span>/
            <span className="legend-port is-else">No</span>
            <span>branch outputs are labelled</span>
          </span>
        </Row>
        <Row label="States">
          <Item swatch="is-selected">selected (toolbar above)</Item>
          <Item swatch="is-running">running (moving border)</Item>
          <span className="legend-item">
            <span className="legend-badge is-missing" aria-hidden="true">
              <Icon name="plug-off" size={10} strokeWidth={2.8} />
            </span>
            <span>plugin missing</span>
          </span>
          <span className="legend-item">
            <span className="legend-badge is-setting" aria-hidden="true">
              !
            </span>
            <span>needs a setting</span>
          </span>
          <span className="legend-item">
            <span className="legend-badge is-unavailable" aria-hidden="true">
              <Icon name="lock" size={9} strokeWidth={2.8} />
            </span>
            <span>not on this server</span>
          </span>
          <span className="legend-item">
            <span className="legend-badge is-unreachable" aria-hidden="true">
              !
            </span>
            <span>not reachable — no path from the trigger</span>
          </span>
          <Item swatch="is-group">group</Item>
        </Row>
        <Row label="Node colours">
          <Item swatch="is-kind is-trigger">trigger</Item>
          <Item swatch="is-kind is-condition">condition</Item>
          <Item swatch="is-kind is-action">action</Item>
          <Item swatch="is-kind is-finish">finish</Item>
          <Item swatch="is-kind is-data">data</Item>
        </Row>
        <Row label="Keys">
          <Key k="Tab">next node</Key>
          <Key k="Enter">node actions</Key>
          <Key k="C">connect</Key>
          <Key k="Del">remove</Key>
          <Key k="/">add</Key>
        </Row>
      </div>
    </details>
  );
}
