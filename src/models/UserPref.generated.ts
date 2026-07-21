// AUTO-GENERATED FROM models.toml — DO NOT EDIT.
// Run `npx js-bao-codegen-v2` to regenerate.
// fingerprint: a9ae2b55d3b0835b

import type { BaseModel } from "js-bao";
import { BaseModel as BaseModelImpl } from "js-bao";

export interface UserPrefAttrs {
  id: string;
  key?: string;
  value?: string;
}

export interface UserPref extends UserPrefAttrs, BaseModel {}

export class UserPref extends BaseModelImpl {}

export const UserPref_modelName = "user_prefs" as const;
