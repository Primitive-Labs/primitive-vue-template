// AUTO-GENERATED FROM models.toml — DO NOT EDIT.
// Run `npx js-bao-codegen-v2` to regenerate.
// fingerprint: a9ae2b55d3b0835b
//
// Importing this barrel registers every model with js-bao as a side
// effect (via `attachAndRegisterModel`). Apps should import models from
// this barrel rather than the per-model `*.generated` files so
// registration runs exactly once.

import type { BaseModel } from "js-bao";
import { attachAndRegisterModel, loadSchemaFromTomlString } from "js-bao";
import modelsToml from "./models.toml?raw";
import { UserPref } from "./UserPref.generated";

export { UserPref } from "./UserPref.generated";

const _modelPairs: ReadonlyArray<{
  modelName: string;
  class: typeof BaseModel;
}> = [{ modelName: "user_prefs", class: UserPref }];

const _schemasByName = Object.fromEntries(
  loadSchemaFromTomlString(modelsToml).map((s) => [s.name, s])
);

for (const { modelName, class: ModelClass } of _modelPairs) {
  const schema = _schemasByName[modelName];
  if (!schema) {
    throw new Error(
      `Generated model ${ModelClass.name} expected TOML schema "${modelName}" — did models.toml change without re-running codegen?`
    );
  }
  attachAndRegisterModel(ModelClass, schema);
}

const _knownModelNames = new Set(_modelPairs.map((p) => p.modelName));
for (const schemaName of Object.keys(_schemasByName)) {
  if (!_knownModelNames.has(schemaName)) {
    throw new Error(
      `TOML model "${schemaName}" has no generated class. Run \`npx js-bao-codegen-v2\` to regenerate.`
    );
  }
}

export const allModels: Array<typeof BaseModel> = _modelPairs.map(
  (m) => m.class
);
