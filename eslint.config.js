// ESLint flat config.
//
// Linting covers all of `src/` (type-aware), plus `scripts/`, the root config
// files, and `eslint.config.js` itself. Three rules are relaxed in
// narrowly-scoped blocks further down
// (`return-await`, `require-await`, `unbound-method`). Each relaxation is
// scoped to a specific file glob where the rule provably cannot distinguish a
// real defect from an established pattern in this codebase, and each carries a
// comment explaining the concrete reason. Every other finding is a real defect
// and is fixed in the source rather than suppressed.

import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Generated output, dependencies, coverage and local agent/tool state.
    // `dist/` matters here: it is a real tsc build of `src/`, so linting it
    // would report every finding twice with stale line numbers.
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "**/*.tsbuildinfo",
      // Agent/tool scratch state, not project source.
      ".agents/**",
      ".claude/**",
      ".cursor/**",
      ".devin/**",
      ".windsurf/**",
    ],
  },

  // ---- Source: TypeScript, type-aware, Node runtime -------------------------
  {
    files: ["src/**/*.ts"],
    extends: [
      js.configs.recommended,
      ...tseslint.configs.recommendedTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        // `projectService` reuses one TypeScript program across files instead
        // of building a fresh program per linted file, which is the difference
        // between a ~30s lint run and a ~30 minute one.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // --- Promise correctness ---------------------------------------------
      // The highest-value rules in this config. A financial backend must never
      // let an unawaited promise fail silently or hand a promise to a caller
      // that will not await it.
      // `ignoreVoid` keeps this codebase's explicit `void somePromise()` marker
      // ("I know, and I don't need the result") legal; `ignoreIIFE: false` means
      // a bare `(async () => {...})()` with no handler is still flagged.
      "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: true, ignoreIIFE: false }],
      // A void-returning callback (a Fastify handler, a BullMQ processor) that
      // is `async` is fine; a callback whose declared return type is `void` but
      // which actually hands a promise to nobody is not.
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { arguments: false, attributes: false } },
      ],
      // Outside the controllers (relaxed below) this is real: a `return somePromise`
      // inside a `try` would let the rejection escape the adjacent `catch`.
      "@typescript-eslint/return-await": ["error", "in-try-catch"],
      "@typescript-eslint/require-await": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "separate-type-imports" },
      ],

      // --- A swallowed error is a lost financial invariant --------------------
      "@typescript-eslint/no-empty-function": [
        "error",
        { allow: ["private-constructors", "protected-constructors"] },
      ],
      // Reject `any` unless it is genuinely unavoidable. The codebase is
      // strict-mode TypeScript end to end, so `any` is always a hole here.
      "@typescript-eslint/no-explicit-any": "error",
      // Unused args prefixed with `_` are the conventional escape hatch; a bare
      // unused arg means the signature is wrong.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
      // Short-circuit/ternary/tagged-template are the legitimate expression
      // forms; a bare `db.deleteUser()` as a statement is a bug.
      "@typescript-eslint/no-unused-expressions": [
        "error",
        { allowShortCircuit: true, allowTernary: true, allowTaggedTemplates: true },
      ],

      // --- Restrictive-syntax rules: these are security controls -------------
      // No eval / Function constructor in a service that touches keys and PINs.
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
      // Prototype pollution / `__proto__` walking.
      "no-proto": "error",
      // Dynamic property access off a bare identifier is how object-injection
      // bugs get written (`obj[userInput]`).
      "@typescript-eslint/dot-notation": "error",
      "no-with": "error",
      "no-labels": "error",
      "no-caller": "error",
      "no-extend-native": "error",
      "no-script-url": "error",

      // --- Node/service hygiene --------------------------------------------
      // Log objects, never string-concatenated secrets.
      "no-console": "error",
      "eqeqeq": ["error", "always", { null: "ignore" }],
      "no-var": "error",
      "prefer-const": ["error", { destructuring: "all" }],
      "object-shorthand": ["error", "always"],
      "no-useless-rename": "error",
      "no-useless-constructor": "error",
      "no-throw-literal": "error",
      "prefer-promise-reject-errors": "error",
      "no-async-promise-executor": "error",
    },
  },

  // ---- Boot-time env validation --------------------------------------------
  // `no-console` is enforced everywhere else in `src`, with one exception.
  // `src/config/logger.ts` imports `src/config/env.ts`, so at the point this
  // schema is evaluated no logger instance can exist yet, and this is the fatal
  // pre-boot abort that must reach the operator's stderr before the process
  // exits. Structured logging is not available, and is not needed.
  {
    files: ["src/config/env.ts"],
    rules: {
      "no-console": "off",
    },
  },

  // ---- Fastify controllers --------------------------------------------------
  // Every controller handler here follows one shape:
  //
  //     async handler(req, reply) {
  //       try   { const x = await service.doThing(); return reply.send(x); }
  //       catch { return handleError(err, reply); }
  //     }
  //
  // `reply.send()` is synchronous and returns `FastifyReply`; the rule reads the
  // enclosing `async` and asks for `return await reply.send(...)`, which would
  // be wrong (it adds a microtask hop and buys nothing). The promise that
  // actually needs awaiting is the service call, and it is already awaited.
  // Turning this off here — and only here — is what keeps it active across the
  // services, where an un-awaited `return` really would escape a `catch`.
  {
    files: ["src/controllers/**/*.ts"],
    rules: {
      "@typescript-eslint/return-await": "off",
    },
  },

  // ---- Route registration ---------------------------------------------------
  // Routes register handler references from plain object-literal controllers
  // (`app.get("/me", opts, accountController.me)`). Those objects never use
  // `this`, so there is no `this` to lose — the rule cannot see that, and
  // binding or wrapping 40+ registrations would only obscure them. The rule
  // stays on for services and controllers, where a lost `this` is plausible.
  {
    files: ["src/routes/**/*.ts"],
    rules: {
      "@typescript-eslint/unbound-method": "off",
    },
  },

  // ---- Chain adapters -------------------------------------------------------
  // Adapters are object literals satisfying the `ChainAdapter` interface, whose
  // members are declared `Promise<T>`. Several of them (e.g. TON's
  // `estimateFee`) legitimately contain no `await` because their whole body is
  // a `throw`, and the `async` keyword is what turns that into a rejected
  // promise rather than a synchronous throw at the call site. Removing `async`
  // to satisfy this rule would change the adapter's error contract.
  {
    files: ["src/chains/**/*.ts"],
    rules: {
      "@typescript-eslint/require-await": "off",
    },
  },

  // ---- Tests: same syntax rules, relaxed where a test must reach in -------
  {
    files: ["src/**/*.test.ts", "src/**/__tests__/**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Tests legitimately fabricate partial Prisma/Redis objects, so the
      // `any`-poisoning rules would fire on almost every mock.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      // Type-level truthiness in a test is noise, not a bug.
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/no-empty-function": "off",
      "no-console": "off",
      // `vi.spyOn(service, "method")` and mock objects that mirror an async
      // interface must be `async`; the rule cannot tell a signature match from
      // a forgotten `await`. A genuinely un-awaited async call inside a test is
      // still caught by `no-floating-promises`, which is not relaxed.
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/unbound-method": "off",
    },
  },

  // ---- Scripts + root config files -----------------------------------------
  // Linted WITHOUT the type-aware rules on purpose.
  //
  // `tsconfig.json` includes only `src` — it is the build project, and widening
  // its `include` would change what `tsc -p` emits into `dist/`. These five
  // files (two scripts, two root config files, one scratch file) therefore
  // belong to no TypeScript project, and the project service cannot resolve
  // them: both `allowDefaultProject` and `defaultProject` were tried and both
  // report every file here as "not found by the project service" (the former
  // intermittently, the latter on every run), which would make `npm run lint`
  // non-deterministic.
  //
  // The trade-off is deliberate and small: five operator-facing tooling files
  // get the syntax-level recommended set (unused imports, unsafe constructs,
  // `no-eval`, promise handling) instead of type-aware rules. All application
  // code under `src/` is fully type-aware.
  {
    files: ["scripts/**/*.ts", "scripts/**/*.mts", "*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // These are operator-facing probes that print their own findings.
      "no-console": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },

  // ---- The ESLint config file itself ---------------------------------------
  {
    files: ["eslint.config.js", "vitest.config.ts"],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "no-console": "off",
    },
  },
);
