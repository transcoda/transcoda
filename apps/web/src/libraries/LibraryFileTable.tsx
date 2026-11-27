import type { FileSort, LibraryFile } from '@transcoda/contract';
import { useEffect, useRef } from 'react';
import { Link } from 'wouter';
import { ResultCell, TitleSub } from '../jobs/JobCells.tsx';
import { JobStateChip } from '../jobs/JobStateChip.tsx';
import { phoneLine } from '../jobs/job-text.ts';
import { jobTitle } from '../jobs/media-text.ts';
import { Poster } from '../jobs/Poster.tsx';
import { useQueue } from '../jobs/use-queue.ts';
import { fmtBytes } from '../lib/bytes.ts';
import { fmtFull, fmtStamp, jobLastTime } from '../lib/time.ts';
import { usePhone } from '../lib/use-phone.ts';
import type { Selection } from './use-selection.ts';

const num = (n: number) => n.toLocaleString('en-US');

const fileHref = (libraryId: string, fileId: string) =>
  `/libraries/${encodeURIComponent(libraryId)}/files/${encodeURIComponent(fileId)}`;

/** The title as the row's link (the same pattern as a Jobs row). */
function FileLink({
  libraryId,
  file,
  className,
}: {
  libraryId: string;
  file: LibraryFile;
  className: string;
}) {
  return (
    <Link
      href={fileHref(libraryId, file.id)}
      className={className}
      aria-label={jobTitle(file.latest)}
      title={file.fileName}
    >
      {file.latest.media.title}
    </Link>
  );
}

function SortHeader({
  label,
  sort,
  active,
  desc,
  onSort,
  className,
}: {
  label: string;
  sort: FileSort;
  active: FileSort;
  desc: boolean;
  onSort(sort: FileSort, desc: boolean): void;
  className?: string;
}) {
  const on = active === sort;
  return (
    <th
      scope="col"
      className={className}
      aria-sort={on ? (desc ? 'descending' : 'ascending') : undefined}
    >
      <button
        type="button"
        className="library-sort"
        onClick={() => onSort(sort, on ? !desc : false)}
      >
        {label}
        {on ? <span aria-hidden="true">{desc ? ' ↓' : ' ↑'}</span> : null}
      </button>
    </th>
  );
}

function Pager({
  total,
  count,
  offset,
  limit,
  onPage,
}: {
  total: number;
  count: number;
  offset: number;
  limit: number;
  onPage(offset: number): void;
}) {
  if (total === 0) return null;
  const last = Math.min(offset + Math.max(count, 1), total, offset + limit);
  return (
    <nav className="library-pager" aria-label="Pages">
      <span className="library-pager-range">{`${num(offset + 1)}–${num(last)} of ${num(total)}`}</span>
      {/* Past the first page Previous stays, even when a refresh left everything on one page. */}
      {total <= limit && offset === 0 ? null : (
        <>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={offset === 0}
            onClick={() => onPage(Math.max(0, offset - limit))}
          >
            Previous
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={offset + limit >= total}
            onClick={() => onPage(offset + limit)}
          >
            Next
          </button>
        </>
      )}
    </nav>
  );
}

/** One page of a library's files: a sortable table, or cards on a phone. */
export function LibraryFileTable({
  libraryId,
  files,
  total,
  sort,
  desc,
  onSort,
  offset,
  limit,
  onPage,
  selection,
}: {
  libraryId: string;
  files: LibraryFile[];
  total: number;
  sort: FileSort;
  desc: boolean;
  onSort(sort: FileSort, desc: boolean): void;
  offset: number;
  limit: number;
  onPage(offset: number): void;
  /** Row checkboxes and a header checkbox for this page; none on a phone. */
  selection?: Selection;
}) {
  const phone = usePhone();
  const queuePaused = useQueue().status?.paused ?? false;
  const pageIds = files.map((f) => f.id);
  const picked = selection ? pageIds.filter((id) => selection.selected.has(id)).length : 0;
  const allPicked = pageIds.length > 0 && picked === pageIds.length;
  const headBox = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (headBox.current) headBox.current.indeterminate = picked > 0 && !allPicked;
  }, [picked, allPicked]);
  const pager = (
    <Pager total={total} count={files.length} offset={offset} limit={limit} onPage={onPage} />
  );

  if (phone) {
    return (
      <div className="library-files">
        <section className="phone-section" aria-label="Files">
          {files.map((file) => (
            <div key={file.id} className="phone-card row-link">
              <div className="phone-card-head">
                <FileLink libraryId={libraryId} file={file} className="job-name row-link-main" />
              </div>
              <TitleSub media={file.latest.media} />
              <span className="phone-card-line">
                {`${fmtBytes(file.sizeBytes)} · ${phoneLine(file.latest)}`}
              </span>
            </div>
          ))}
        </section>
        {files.length === 0 ? <p className="library-empty">No files match.</p> : null}
        {pager}
      </div>
    );
  }

  return (
    <div className="library-files">
      <div className="job-list">
        <table className="job-table library-table" aria-label="Files">
          <colgroup>
            {selection ? <col className="library-col-check" /> : null}
            <col />
            <col className="library-col-size" />
            <col className="job-col-status" />
            <col className="job-col-result" />
            <col className="job-col-when" />
          </colgroup>
          <thead>
            <tr>
              {selection ? (
                <th scope="col" className="library-col-check">
                  <input
                    ref={headBox}
                    type="checkbox"
                    aria-label="Select this page"
                    checked={allPicked}
                    disabled={pageIds.length === 0}
                    onChange={(e) => selection.setPage(pageIds, e.target.checked)}
                  />
                </th>
              ) : null}
              <SortHeader label="Title" sort="title" active={sort} desc={desc} onSort={onSort} />
              <SortHeader
                label="Size"
                sort="size"
                active={sort}
                desc={desc}
                onSort={onSort}
                className="library-col-size"
              />
              <SortHeader label="Status" sort="result" active={sort} desc={desc} onSort={onSort} />
              <th scope="col">Result</th>
              <SortHeader
                label="Last run"
                sort="lastRun"
                active={sort}
                desc={desc}
                onSort={onSort}
                className="job-when"
              />
            </tr>
          </thead>
          <tbody>
            {files.map((file) => {
              const when = jobLastTime(file.latest);
              return (
                <tr key={file.id} className="row-link">
                  {selection ? (
                    <td className="library-col-check">
                      <input
                        type="checkbox"
                        aria-label={`Select ${file.fileName}`}
                        checked={selection.selected.has(file.id)}
                        onChange={() => selection.toggle(file.id)}
                      />
                    </td>
                  ) : null}
                  <td>
                    <div className="job-title">
                      <Poster job={file.poster ?? file.latest} size="row" />
                      <div className="job-title-main">
                        <FileLink
                          libraryId={libraryId}
                          file={file}
                          className="job-name job-title-text row-link-main"
                        />
                        <TitleSub media={file.latest.media} />
                      </div>
                    </div>
                  </td>
                  <td className="library-col-size">{fmtBytes(file.sizeBytes)}</td>
                  <td>
                    <JobStateChip job={file.latest} />
                  </td>
                  <ResultCell job={file.latest} queuePaused={queuePaused} />
                  <td className="job-when">
                    <time dateTime={when} title={fmtFull(when)}>
                      {fmtStamp(when)}
                    </time>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {files.length === 0 ? <p className="library-empty">No files match.</p> : null}
      {pager}
    </div>
  );
}
