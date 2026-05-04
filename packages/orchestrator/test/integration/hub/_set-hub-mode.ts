// Side-effect-only module: must be the first import in any hub-mode test.
// Sets ORBITAL_MODE=hub before any tRPC middleware/init module is loaded so
// the lazy tenant middleware singleton picks it up on construction.
process.env.ORBITAL_MODE = 'hub'
