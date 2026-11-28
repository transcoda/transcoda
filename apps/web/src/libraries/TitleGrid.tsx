import type {
  LibrarySeasonsOutput,
  LibraryTitle,
  OutcomeCounts,
  PosterRef,
} from '@transcoda/contract';
import { Link } from 'wouter';
import { APPROVAL_WORD, VERDICT_WORD, verdictOf } from '../jobs/job-text.ts';
import { Poster } from '../jobs/Poster.tsx';
import { fmtBytes } from '../lib/bytes.ts';

const num = (n: number) => n.toLocaleString('en-US');

/** "12 replaced · 2 kept original · 1 failed · saved 4.20 GB"; a zero part is left out. */
export function outcomeLine(o: OutcomeCounts, savedBytes: number): string {
  const parts: string[] = [];
  if (o.replaced > 0) parts.push(`${num(o.replaced)} replaced`);
  if (o.kept > 0) parts.push(`${num(o.kept)} kept original`);
  if (o.failed > 0) parts.push(`${num(o.failed)} failed`);
  if (savedBytes > 0) parts.push(`saved ${fmtBytes(savedBytes)}`);
  return parts.join(' · ');
}

const episodeCount = (n: number) => `${num(n)} ${n === 1 ? 'episode' : 'episodes'}`;

/** What `Poster` shows when a title has no poster: its placeholder. */
const NO_POSTER: Parameters<typeof Poster>[0]['job'] = {
  id: '',
  media: {
    kind: 'unknown',
    title: '',
    year: null,
    season: null,
    episode: null,
    episodeTitle: null,
    source: 'filename',
    poster: false,
  },
};

/** One card: a single link, so its accessible name is all of its text. */
function Card({
  href,
  poster,
  title,
  lines,
}: {
  href: string;
  poster: PosterRef | null;
  title: string;
  lines: Array<string | null>;
}) {
  return (
    <li>
      <Link href={href} className="library-card">
        <Poster job={poster ?? NO_POSTER} size="card" of={poster?.of} />
        <div className="library-card-title">{title}</div>
        {lines.map((line) =>
          line ? (
            <div key={line} className="library-card-line">
              {line}
            </div>
          ) : null,
        )}
      </Link>
    </li>
  );
}

const base = (libraryId: string) => `/libraries/${encodeURIComponent(libraryId)}`;

/** A title card's identity: the show key or the movie's file id. */
export const titleKey = (t: LibraryTitle): string =>
  t.type === 'show' ? `s:${t.key}` : `m:${t.fileId}`;

/** The library's shows and movies. */
export function TitleGrid({ libraryId, items }: { libraryId: string; items: LibraryTitle[] }) {
  return (
    <ul className="library-grid" aria-label="Titles">
      {items.map((t) =>
        t.type === 'show' ? (
          <Card
            key={titleKey(t)}
            href={`${base(libraryId)}/shows/${encodeURIComponent(t.key)}`}
            poster={t.poster}
            title={t.title}
            lines={[
              t.year === null
                ? episodeCount(t.episodes)
                : `${t.year} · ${episodeCount(t.episodes)}`,
              outcomeLine(t.outcomes, t.savedBytes) || null,
            ]}
          />
        ) : (
          <Card
            key={titleKey(t)}
            href={`${base(libraryId)}/files/${encodeURIComponent(t.fileId)}`}
            poster={t.poster}
            title={t.latest.media.title}
            lines={[
              t.latest.media.year === null ? null : String(t.latest.media.year),
              t.latest.approval ? APPROVAL_WORD : VERDICT_WORD[verdictOf(t.latest)],
            ]}
          />
        ),
      )}
    </ul>
  );
}

const seasonName = (season: number | 'none') =>
  season === 'none' ? 'No season' : season === 0 ? 'Specials' : `Season ${season}`;

/** One show's seasons. */
export function SeasonGrid({
  libraryId,
  showKey,
  seasons,
}: {
  libraryId: string;
  showKey: string;
  seasons: LibrarySeasonsOutput['seasons'];
}) {
  return (
    <ul className="library-grid" aria-label="Seasons">
      {seasons.map((s) => (
        <Card
          key={String(s.season)}
          href={`${base(libraryId)}/shows/${encodeURIComponent(showKey)}/seasons/${s.season}`}
          poster={s.poster}
          title={seasonName(s.season)}
          lines={[episodeCount(s.episodes), outcomeLine(s.outcomes, s.savedBytes) || null]}
        />
      ))}
    </ul>
  );
}
