/**
 * Who may do what on an extension's routes, by the person behind the request (`http.person`, which a Pithagoras of
 * 0.3.0 and later has): every route needs a signed-in person, and a request that changes something the portal's
 * primary person; a colleague or a guest of the portal may read. A portal without `http.person` has only its own
 * sign-in gate in front of the routes, as before. One gate for the extensions that need it (Office, Nextcloud), so
 * that the two do not come to differ.
 */

/** Who is behind a request to the package's routes (`http.person`). */
export interface RequestPerson {
  id: string;
  name: string;
  role: "primary" | "colleague" | "guest" | "unknown";
}

/** Methods that only read. */
const READS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface PersonGateOptions {
  /** The portal's `http`, read at each request (the half may be started again with another portal). */
  http: () => unknown;
  /** What a change by anyone but the primary person is refused with. */
  refused: string;
  /** Requests the gate lets through as they are (traffic that a signature of the half's own opens). */
  pass?: (req: { method?: string; url?: string }) => boolean;
  /** Where a failure to read the person is said; it is refused like a request with no person. */
  log?: (message: string) => void;
}

/** For the whole of an extension's routes, after `writesFromHere`. A POST counts as a change, whatever it does. */
export function personGate(options: PersonGateOptions) {
  return (req: { method?: string; url?: string }, res: { status: (code: number) => { json: (body: unknown) => void } }, next: () => void): void => {
    const http = options.http() as { person?: (req: never) => RequestPerson | undefined } | undefined;
    if (typeof http?.person !== "function" || options.pass?.(req)) return next();
    let person: RequestPerson | undefined;
    try {
      person = http.person(req as never);
    } catch (e) {
      options.log?.((e as Error).message);
    }
    if (!person) return void res.status(401).json({ error: "Sign in to the portal first.", code: "no_person" });
    if (!READS.has(req.method ?? "GET") && person.role !== "primary") return void res.status(403).json({ error: options.refused, code: "not_primary" });
    next();
  };
}
