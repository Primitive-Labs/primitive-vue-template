import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { JsBaoClient } from "js-bao-wss-client";
import { signIn, signOut } from "./support/signIn";

describe("signed-in example", () => {
  let client: JsBaoClient;
  let email: string;

  beforeAll(async () => {
    ({ client, email } = await signIn());
  });

  afterAll(async () => {
    if (client) await signOut(client);
  });

  it("reads the signed-in user's profile", async () => {
    const profile = await client.me.get();
    expect(profile?.email.toLowerCase()).toBe(email.toLowerCase());
  });
});
