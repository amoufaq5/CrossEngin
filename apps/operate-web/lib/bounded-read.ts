/**
 * How far the reads behind a report got — the client mirror of the server's
 * `BoundedReadDeclaration` in `@crossengin/operate-runtime`.
 *
 * The server drains each read to a declared ceiling and names the ones that hit it rather than
 * truncating in silence, so a bounded report is a correct answer over a stated subset. Rendering
 * that is the half the server cannot do: a page that showed the figures and dropped the declaration
 * would be a surface built to make the bound legible, concealing it.
 *
 * `complete` is **required**, as it is on the server, so a page cannot read the figures and forget
 * to ask. Its own module rather than either report's, because both reports carry it and neither
 * owns it — importing one report's types into the other to get it is how two spellings begin.
 */
export interface BoundedReadDeclaration {
  readonly complete: boolean;
  readonly bounded: readonly string[];
}

/**
 * The sentence a bounded report shows, or null when it was read in full.
 *
 * It tests `complete` for truth rather than `bounded.length` for emptiness, and that is the
 * fail-closed direction given how this app parses: `api.ts` casts the body with `as`, so a server
 * that did not send the field at all leaves `complete` `undefined` and the notice appears. An older
 * server is then described as bounded, which is the safe way to be wrong about it.
 */
export function boundedReadNotice(d: BoundedReadDeclaration, unit: string): string | null {
  if (d.complete) return null;
  const names = d.bounded.length > 0 ? d.bounded.join(", ") : "one or more reads";
  return (
    `These figures cover only part of your ${unit}: ${names} reached this deployment's read ceiling, ` +
    `so every total below is computed over the rows that were read and not over all of them.`
  );
}
