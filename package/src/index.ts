import type {
  Extension,
  ExtensionSetupResult,
  PGliteInterface,
} from '@electric-sql/pglite'

const setup = async (_pg: PGliteInterface, emscriptenOpts: any) => {
  return {
    emscriptenOpts,
    bundlePath: new URL('../release/rdkit.tar.gz', import.meta.url),
  } satisfies ExtensionSetupResult
}

export const rdkit = {
  name: 'rdkit',
  setup,
} satisfies Extension
