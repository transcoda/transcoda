import tmdbLogo from '../assets/tmdb.svg';

/** The notice TMDB's terms require wherever its data is used (its settings, and the shell footer). */
export function TmdbAttribution() {
  return (
    <p className="tmdb-attribution">
      <a href="https://www.themoviedb.org" target="_blank" rel="noopener noreferrer">
        <img src={tmdbLogo} alt="TMDB" height={20} />
      </a>
      <span>This product uses the TMDB API but is not endorsed or certified by TMDB.</span>
    </p>
  );
}
