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
  vueTsConfigs.recommended,
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
  // with intentionally single-word names (Button, Card, …). Renaming them
  // would diverge from upstream, so exempt them from the multi-word rule.
  {
    name: "primitive-vue-template/shadcn-ui-components",
    files: ["src/components/ui/**/*.vue"],
    rules: {
      "vue/multi-word-component-names": "off",
    },
  }
);


