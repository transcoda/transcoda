// Helpers the router tests share: read a procedure's declared errors and route.

type Procedure = { '~orpc': { errorMap: Record<string, unknown>; route: Record<string, unknown> } };

/** The error codes a procedure declares. */
export const errorsOf = (p: unknown) => Object.keys((p as Procedure)['~orpc'].errorMap);

/** A procedure's route: method, path, description. */
export const route = (p: unknown) => (p as Procedure)['~orpc'].route;
