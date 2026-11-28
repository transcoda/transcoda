import { type ReactNode, useRef } from 'react';
import { Icon } from '../../components/Icon.tsx';
import { ARROWED } from '../flow/edge-style.ts';

/** A key line in the canvas edge style `edge-<kind>`, with its arrowhead when the canvas draws one. */
function Line({ kind, children }: { kind: 'data' | 'broken'; children: string }) {
  const arrow = ARROWED.has(`edge-${kind}`);
  return (
    <li className="legend-item">
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
    </li>
  );
}

/** A port shape: its input (hollow) and output (filled) handle side by side, as the cards draw them. */
function Port({ type, children }: { type: 'file' | 'data'; children: string }) {
  return (
    <li className="legend-item">
      <span className="legend-mark" aria-hidden="true">
        <span className={`legend-swatch is-${type}-in`} />
        <span className={`legend-swatch is-${type}-out`} />
      </span>
      <span>{children}</span>
    </li>
  );
}

function Badge({ tone, children, word }: { tone: string; children: ReactNode; word: string }) {
  return (
    <li className="legend-item">
      <span className="legend-mark" aria-hidden="true">
        <span className={`legend-badge is-${tone}`}>{children}</span>
      </span>
      <span>{word}</span>
    </li>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="legend-row">
      <span className="legend-label">{label}</span>
      <ul className="legend-items">{children}</ul>
    </div>
  );
}

function Key({ k, children }: { k: string; children: string }) {
  return (
    <li className="legend-item">
      <span className="legend-mark">
        <kbd>{k}</kbd>
      </span>
      <span>{children}</span>
    </li>
  );
}

/**
 * The canvas key, a "Key" disclosure at the bottom left of the canvas (closed by its Close button
 * or Escape). It explains only what a card or a line does not say in words: the line styles, the
 * port shapes and the state badges (glyph-only on the zoomed-out icon tiles). `keys` adds the
 * keyboard shortcuts, which only an editable canvas has.
 */
export function CanvasLegend({ keys }: { keys: boolean }) {
  const details = useRef<HTMLDetailsElement>(null);
  const toggle = useRef<HTMLElement>(null);
  function close() {
    if (details.current) details.current.open = false;
    toggle.current?.focus();
  }
  return (
    <details ref={details} className="canvas-legend nopan nowheel">
      <summary
        ref={toggle}
        className="canvas-legend-toggle"
        title={keys ? 'Line styles, ports, badges and shortcuts' : 'Line styles, ports and badges'}
      >
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
          <Icon name="cross" size={16} />
        </button>
        <Row label="Lines">
          <Line kind="data">data</Line>
          <Line kind="broken">leads to a broken node</Line>
        </Row>
        <Row label="Ports">
          <Port type="file">file</Port>
          <Port type="data">data</Port>
        </Row>
        <Row label="Badges">
          <Badge tone="missing" word="plugin missing">
            <Icon name="plug-off" size={10} />
          </Badge>
          <Badge tone="setting" word="needs a setting">
            !
          </Badge>
          <Badge tone="unavailable" word="not on this server">
            <Icon name="lock" size={9} />
          </Badge>
          <Badge tone="unreachable" word="not reachable: no path from the trigger">
            !
          </Badge>
        </Row>
        {keys && (
          <Row label="Keys">
            <Key k="Tab">next node</Key>
            <Key k="Enter">node actions</Key>
            <Key k="C">connect</Key>
            <Key k="Del">remove</Key>
            <Key k="/">add a node</Key>
          </Row>
        )}
      </div>
    </details>
  );
}
