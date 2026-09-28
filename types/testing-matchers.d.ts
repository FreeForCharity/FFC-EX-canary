// Type-level registration for the test globals and matchers that jest.setup.js
// and the jest runner provide at runtime.
//
// tsconfig `include` covers only **/*.ts and **/*.tsx, and jest.setup.js is a
// .js file, so nothing pulled @types/jest or jest-dom's matcher augmentation
// into the TypeScript program. Next 16.2 did not type-check the test files
// during `next build`; Next 16.3 does, which surfaced that as ~880 "Cannot
// find name 'describe'" / "'expect'" / "Cannot find namespace 'jest'" errors.
//
// The reference directive is what actually pulls @types/jest in: under pnpm's
// strict node_modules layout tsc's automatic @types discovery does not reach
// it, unlike @types/node which arrives via ordinary module imports.
/// <reference types="jest" />

import '@testing-library/jest-dom'

// Installed by jest-axe's extend-expect entry point; the module's own types are
// declared in jest-axe.d.ts (which must stay a script file — see there).
declare global {
  namespace jest {
    interface Matchers<R> {
      toHaveNoViolations(): R
    }
  }
}
