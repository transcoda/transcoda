/** The admin the setup spec creates; a throwaway server, so a fixed password is fine. */
export const ADMIN = { username: 'admin', password: 'e2e-password-not-secret' } as const;

/** Where e2e/server.mjs puts the fixture movies, as the server sees them. */
export const MOVIES_PATH = `${process.env.E2E_WORK ?? '/tmp/transcoda-e2e'}/media/movies`;
