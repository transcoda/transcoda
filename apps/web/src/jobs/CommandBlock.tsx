import { useId, useRef } from 'react';
import { Icon } from '../components/Icon.tsx';
import { useToast } from '../components/Toast.tsx';
import { copyShortcut, copyText } from '../lib/clipboard.ts';

/**
 * Screen 06 "ffmpeg command": the command line as the engine ran it, with "Copy". A dry run's
 * command was only planned: "ffmpeg command (not run)". `level` 3 inside another section (06b's
 * raw ffmpeg output).
 */
export function CommandBlock({
  command,
  notRun = false,
  level = 2,
}: {
  command: string;
  notRun?: boolean;
  level?: 2 | 3;
}) {
  const Heading = level === 3 ? 'h3' : 'h2';
  const headingId = useId();
  const toast = useToast();
  const pre = useRef<HTMLPreElement>(null);
  async function copy() {
    // On plain http there may be no way to write the clipboard: then the command is selected.
    const result = await copyText(command, pre.current);
    if (result === 'copied') toast.success('Copied');
    else if (result === 'selected') toast.info(`Selected. Press ${copyShortcut()} to copy.`);
    else toast.info(`Select the command and press ${copyShortcut()} to copy.`);
  }
  return (
    <section className="panel command-block" aria-labelledby={headingId}>
      <div className="command-head">
        <Heading id={headingId}>{notRun ? 'ffmpeg command (not run)' : 'ffmpeg command'}</Heading>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => void copy()}>
          <Icon name="copy" size={14} />
          Copy
        </button>
      </div>
      <pre ref={pre} className="command-text">
        {command}
      </pre>
    </section>
  );
}
