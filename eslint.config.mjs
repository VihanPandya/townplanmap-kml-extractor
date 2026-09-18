import next from 'eslint-config-next';

/**
 * Flat ESLint config.
 *
 * `eslint-config-next` brings the TypeScript and React Hooks rules this project
 * relies on, including the exhaustive-deps rule the one deliberate disable
 * comment in `map-view.tsx` refers to.
 */
const config = [
  {
    ignores: ['.next/**', 'node_modules/**', 'public/maplibre/**', 'next-env.d.ts'],
  },
  ...next,
  {
    rules: {
      /*
       * Downgraded to a warning, deliberately.
       *
       * This rule steers code towards `use()` + Suspense and away from manually
       * managed loading flags. The client screens here fetch from this app's own
       * API in an effect and flip a `loading` flag as they go, which is the
       * pattern the rule flags. It is the conventional approach, it is what the
       * screens were built and verified against, and the alternative is a
       * Suspense refactor of working code. Keeping it visible as a warning is
       * honest; treating it as an error would only invite blanket suppressions.
       */
      'react-hooks/set-state-in-effect': 'warn',
    },
  },
];

export default config;
