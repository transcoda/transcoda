import { api } from '../../api/client.ts';
import { Icon } from '../../components/Icon.tsx';
import { Loading } from '../../components/Loading.tsx';
import { useAppUpdate } from '../../hooks/useAppUpdate.ts';
import { useAsync } from '../../hooks/useAsync.ts';
import { GuardedLink } from '../../lib/navigation.tsx';
import { AppUpdatePanel } from './AppUpdatePanel.tsx';
import { BackupsPanel } from './BackupsPanel.tsx';
import { useSettings } from './useSettings.ts';

const notRead = 'Could not be read';

/** The codecs Transcoda encodes to, each with the encoders ffmpeg offers for it. */
const FAMILIES: ReadonlyArray<{ label: string; matches(e: string): boolean }> = [
  { label: 'HEVC', matches: (e) => e === 'libx265' || e.startsWith('hevc_') },
  { label: 'H.264', matches: (e) => e === 'libx264' || e.startsWith('h264_') },
  {
    label: 'AV1',
    matches: (e) => ['libsvtav1', 'libaom-av1', 'librav1e'].includes(e) || e.startsWith('av1_'),
  },
  { label: 'Audio', matches: (e) => ['aac', 'ac3', 'eac3', 'libopus', 'opus'].includes(e) },
];

/** ffmpeg found by name on the PATH says nothing the row's label does not: only a real path shows. */
const pathShown = (path: string) => path.includes('/') || path.includes('\\');

/** Hardware encoders are named after their API (`hevc_nvenc`, `h264_vaapi`). */
const HARDWARE = /_(nvenc|qsv|vaapi|videotoolbox|amf|v4l2m2m)$/;

/**
 * The About summary: per codec Transcoda encodes to, the encoders ffmpeg has (hardware ones
 * marked), then the hardware acceleration methods; a codec ffmpeg has no encoder for says so.
 */
export function encoderSummary(
  encoders: readonly string[],
  hwaccels: readonly string[],
): { label: string; value: string }[] {
  const rows = FAMILIES.map((f) => {
    const found = encoders.filter(f.matches).map((e) => (HARDWARE.test(e) ? `${e} (hardware)` : e));
    return { label: f.label, value: found.length > 0 ? found.join(', ') : 'none' };
  });
  rows.push({ label: 'Hardware', value: hwaccels.length > 0 ? hwaccels.join(', ') : 'none' });
  return rows;
}

function Chips({ label, items }: { label: string; items: string[] }) {
  return (
    <div className="about-chips">
      <h3>{label}</h3>
      {items.length === 0 ? (
        <p className="faint">None</p>
      ) : (
        <ul aria-label={label}>
          {items.map((x) => (
            <li key={x} className="scope-tag">
              {x}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * About: a newer release first (what it brings and how to update), then the Transcoda, Node and ffmpeg versions (ffmpeg's path when it is one), the database
 * backups, what ffmpeg can encode with (closed) and the way to the open-source licences.
 */
export function AboutSection() {
  const health = useAsync(() => api.system.health(), []);
  const caps = useAsync(() => api.system.capabilities(), []);
  const settings = useSettings();
  const appUpdate = useAppUpdate();

  if (health.loading && caps.loading && !settings.data && !settings.error) return <Loading />;

  const node = settings.data?.about.node ?? (settings.error ? notRead : '…');
  const version = health.data?.version ?? (health.error ? notRead : '…');
  const ffmpeg = caps.data;

  return (
    <div className="about">
      {appUpdate?.update ? <AppUpdatePanel status={appUpdate} /> : null}
      <dl className="about-list">
        <div className="about-row">
          <dt>Transcoda</dt>
          <dd className="mono">{version}</dd>
        </div>
        <div className="about-row">
          <dt>Node</dt>
          <dd className="mono">{node}</dd>
        </div>
        <div className="about-row">
          <dt>ffmpeg</dt>
          {ffmpeg?.available ? (
            <dd>
              <span className="mono">{ffmpeg.version}</span>
              {pathShown(ffmpeg.path) ? (
                <span className="about-path mono">{ffmpeg.path}</span>
              ) : null}
            </dd>
          ) : ffmpeg ? (
            <dd>
              <span className="about-error">
                <Icon name="alert" size={16} round />
                {`Not available: ${ffmpeg.error}`}
              </span>
              {pathShown(ffmpeg.path) ? (
                <span className="about-path mono">{ffmpeg.path}</span>
              ) : null}
            </dd>
          ) : (
            <dd>{caps.error ? notRead : '…'}</dd>
          )}
        </div>
      </dl>
      <BackupsPanel />
      {ffmpeg?.available ? (
        // What it encodes with is looked up rarely: the codec summary and the full lists, closed.
        <details className="about-caps">
          <summary>
            <span className="about-caps-chevron" aria-hidden="true">
              <Icon name="chevron-down" size={16} />
            </span>
            Show all encoders
          </summary>
          <ul className="about-encoders" aria-label="Encoders Transcoda uses">
            {encoderSummary(ffmpeg.encoders, ffmpeg.hwaccels).map((row) => (
              <li key={row.label} className="about-encoders-row">
                <span className="about-encoders-label">{row.label}</span>
                <span className="mono">{row.value}</span>
              </li>
            ))}
          </ul>
          <Chips label="Encoders" items={ffmpeg.encoders} />
          <Chips label="Hardware acceleration" items={ffmpeg.hwaccels} />
        </details>
      ) : null}
      <GuardedLink href="/settings/about/licences" className="about-link">
        <span>Open-source licences</span>
        <Icon name="chevron-right" />
      </GuardedLink>
    </div>
  );
}
