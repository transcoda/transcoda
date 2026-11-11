/**
 * Test helper: a strict reader for the Prometheus text format (0.0.4), enough to check what
 * `renderExposition` writes. It throws on anything it would not accept: a malformed line, HELP or
 * TYPE twice for a family, a sample before its TYPE, a bad name, label or escape.
 */
export interface ParsedSample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

export interface ParsedExposition {
  help: Map<string, string>;
  types: Map<string, string>;
  samples: ParsedSample[];
}

const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const TYPES = new Set(['counter', 'gauge', 'histogram', 'summary', 'untyped']);

function family(name: string, types: Map<string, string>): string | undefined {
  if (types.has(name)) return name;
  for (const suffix of ['_bucket', '_sum', '_count']) {
    if (name.endsWith(suffix)) {
      const base = name.slice(0, -suffix.length);
      if (types.get(base) === 'histogram') return base;
    }
  }
  return undefined;
}

function parseLabels(src: string, line: string): Record<string, string> {
  const labels: Record<string, string> = {};
  let i = 0;
  while (i < src.length) {
    const eq = src.indexOf('=', i);
    if (eq < 0) throw new Error(`bad labels: ${line}`);
    const key = src.slice(i, eq);
    if (!LABEL.test(key) || key in labels) throw new Error(`bad label name ${key}: ${line}`);
    if (src[eq + 1] !== '"') throw new Error(`unquoted label value: ${line}`);
    let j = eq + 2;
    let value = '';
    for (;;) {
      const c = src[j];
      if (c === undefined) throw new Error(`unterminated label value: ${line}`);
      if (c === '"') break;
      if (c === '\\') {
        const n = src[j + 1];
        if (n === 'n') value += '\n';
        else if (n === '\\' || n === '"') value += n;
        else throw new Error(`bad escape: ${line}`);
        j += 2;
      } else {
        if (c === '\n') throw new Error(`raw newline in label value: ${line}`);
        value += c;
        j += 1;
      }
    }
    labels[key] = value;
    i = j + 1;
    if (i < src.length) {
      if (src[i] !== ',') throw new Error(`expected comma: ${line}`);
      i += 1;
    }
  }
  return labels;
}

function parseValue(raw: string, line: string): number {
  if (raw === '+Inf') return Number.POSITIVE_INFINITY;
  if (raw === '-Inf') return Number.NEGATIVE_INFINITY;
  if (raw === 'NaN') return Number.NaN;
  if (!/^-?\d+(\.\d+)?(e[+-]?\d+)?$/i.test(raw)) throw new Error(`bad value: ${line}`);
  return Number(raw);
}

export function parseExposition(text: string): ParsedExposition {
  if (text !== '' && !text.endsWith('\n')) throw new Error('missing final newline');
  const help = new Map<string, string>();
  const types = new Map<string, string>();
  const samples: ParsedSample[] = [];
  for (const line of text.split('\n').slice(0, -1)) {
    if (line.startsWith('# HELP ') || line.startsWith('# TYPE ')) {
      const rest = line.slice(7);
      const sp = rest.indexOf(' ');
      const name = sp < 0 ? rest : rest.slice(0, sp);
      const arg = sp < 0 ? '' : rest.slice(sp + 1);
      if (!NAME.test(name)) throw new Error(`bad name: ${line}`);
      const map = line.startsWith('# HELP ') ? help : types;
      if (map.has(name)) throw new Error(`repeated: ${line}`);
      if (map === types && !TYPES.has(arg)) throw new Error(`bad type: ${line}`);
      map.set(name, arg.replace(/\\n/g, '\n').replace(/\\\\/g, '\\'));
      continue;
    }
    if (line.startsWith('#') || line === '')
      throw new Error(`unexpected line: ${JSON.stringify(line)}`);
    const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{(.*)\})? (\S+)$/s.exec(line);
    if (!m) throw new Error(`bad sample: ${line}`);
    const name = m[1] as string;
    if (family(name, types) === undefined) throw new Error(`sample before its TYPE: ${line}`);
    samples.push({
      name,
      labels: m[3] ? parseLabels(m[3], line) : {},
      value: parseValue(m[4] as string, line),
    });
  }
  return { help, types, samples };
}
