/**
 * Test-only stand-in for the `server-only` package.
 *
 * The real package throws unless it is imported from a React Server Component,
 * which is exactly the guarantee we want in the app but makes these modules
 * impossible to exercise from a test. Aliased in `vitest.config.ts`; nothing in
 * `app/` or `server/` imports this file.
 */
export {};
