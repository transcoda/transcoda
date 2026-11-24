import { useId, useState } from 'react';
import { copyText } from '../lib/clipboard.ts';
import { Icon } from './Icon.tsx';
import { useToast } from './Toast.tsx';

/** A path cut at its last slash: the folder part (with the slash) and the file name. */
export function splitPath(path: string): { folder: string; name: string } {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return { folder: path.slice(0, at + 1), name: path.slice(at + 1) };
}

/**
 * A file's absolute path in a page header, with Copy path. Wide screens show it whole, wrapped.
 * Phones show one line: the folder cut from the left ("…/Some Film (1950)/") and the file
 * name always whole, with a Show full path button that wraps the whole path in. Screen readers
 * always get the whole path: the short line is decoration (aria-hidden) and the whole path is only
 * visually hidden while the short line stands in for it.
 */
export function FilePath({ path }: { path: string }) {
  const id = useId();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const { folder, name } = splitPath(path);
  const copy = async () => {
    const result = await copyText(path);
    if (result === 'copied') toast.success('Copied');
    else toast.error("Couldn't copy the path");
  };
  return (
    <div className={open ? 'job-path-row file-path is-open' : 'job-path-row file-path'}>
      <span id={`${id}-full`} className="job-path file-path-full">
        {path}
      </span>
      <span className="file-path-short" aria-hidden="true" title={path}>
        {folder ? <span className="file-path-folder">{`\u200e${folder}\u200e`}</span> : null}
        <span className="file-path-name">{name}</span>
      </span>
      <div className="file-path-actions">
        <button
          type="button"
          className="btn btn-sm btn-ghost file-path-toggle"
          aria-expanded={open}
          aria-controls={`${id}-full`}
          onClick={() => setOpen(!open)}
        >
          <span className="file-path-chevron" aria-hidden="true">
            <Icon name="chevron-right" size={14} />
          </span>
          {open ? 'Hide full path' : 'Show full path'}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          aria-describedby={`${id}-full`}
          onClick={() => void copy()}
        >
          <Icon name="copy" size={14} />
          Copy path
        </button>
      </div>
    </div>
  );
}
