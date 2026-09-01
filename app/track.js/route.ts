export const runtime = "nodejs";
export const dynamic = "force-static";

import { SNIPPET } from "./snippet.source";
import { SNIPPET_MIN } from "./snippet.generated";

/**
 * `snippet.source.ts` is the source of truth and is the file to edit: this
 * snippet is the only thing standing between a visitor and a captured lead, so
 * it is maintained and reviewed in readable form, never minified by hand.
 *
 * `snippet.generated.ts` is written by `scripts/build-track-snippet.ts`, wired
 * to `prebuild` so a plain `npm run build` always regenerates it. esbuild does
 * the transform and stays a devDependency — it is a build tool, and pulling it
 * into the Next server graph breaks the build (webpack cannot parse its .d.ts).
 *
 * Falls back to the readable source if the generated constant is ever empty.
 * The bytes are worth having; they are never worth an outage.
 */
const BODY = SNIPPET_MIN || SNIPPET;

export function GET() {
  return new Response(BODY, {
    status: 200,
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=300, must-revalidate",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
