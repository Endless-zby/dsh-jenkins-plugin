/**
 * Ambient declarations for the two asset kinds a client bundle imports but this
 * repository's build does not transform.
 *
 * The plugin's browser half is bundled by `scripts/build-client.mjs`, which has
 * no CSS pipeline, so it never imports a stylesheet — but the platform's UI
 * primitive components do, and this program compiles their sources for types.
 * Declaring the modules here keeps that type-only relationship honest instead of
 * letting `tsc` fail on an import this build would never emit.
 */

declare module '*.module.css' {
  const classes: Record<string, string>
  export default classes
}

declare module '*.css'
