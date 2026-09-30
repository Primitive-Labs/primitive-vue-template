import skipFormatting from "@vue/eslint-config-prettier/skip-formatting";
import {
  defineConfigWithVueTs,
  vueTsConfigs,
} from "@vue/eslint-config-typescript";
import pluginVue from "eslint-plugin-vue";
import { globalIgnores } from "eslint/config";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export default defineConfigWithVueTs(
  {
    name: "template/files-to-lint",
    files: ["**/*.{ts,mts,tsx,vue}"],
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: dirname(fileURLToPath(new URL(".", import.meta.url))),
      },
    },
  },

  globalIgnores(["**/dist/**", "**/dist-ssr/**", "**/coverage/**"]),

  pluginVue.configs["flat/essential"],
  vueTsConfigs.recommendedTypeChecked,
  skipFormatting,

  // Generated model attribute files use the standard js-bao
  // class/interface declaration-merging idiom. The pattern is intentional
  // and the files are generated from `models.toml`, so silence the generic
  // warning for those files only.
  {
    name: "primitive-vue-template/generated-models",
    files: ["src/models/*.generated.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-declaration-merging": "off",
      "@typescript-eslint/prefer-as-const": "off",
    },
  },

  // shadcn-vue base components are vendored verbatim under src/components/ui
  // and are not edited here. Their names are intentionally single-word
  // (Button, Card, …); renaming them would diverge from upstream. Some import
  // a props type from a sibling `.vue` file, which the type-aware linter
  // resolves through the `*.vue` module shim as `any` (vue-tsc resolves it
  // fine), so the redundant-constituent rule reports a false positive there.
  {
    name: "primitive-vue-template/shadcn-ui-components",
    files: ["src/components/ui/**/*.vue"],
    rules: {
      "vue/multi-word-component-names": "off",
      "@typescript-eslint/no-redundant-type-constituents": "off",
    },
  },
  // Platform deprecations. Every deprecated member of js-bao-wss-client,
  // primitive-app and js-bao carries a `@deprecated` note in its typings, and
  // this type-aware rule reports each use with that note, so `pnpm lint` lists
  // what the next major of the platform removes. Replace the use with what the
  // note names rather than suppressing the warning.
  {
    name: "primitive-vue-template/platform-deprecations",
    files: ["src/**/*.{ts,mts,tsx,vue}"],
    rules: { "@typescript-eslint/no-deprecated": "warn" },
  }
);
