/**
 * The session cookie name, isolated in a dependency-free module so the edge
 * middleware can import it without pulling in node:crypto (which `lib/auth.ts`
 * uses and which isn't available in the edge runtime).
 */
export const SESSION_COOKIE = "arbor_admin";
