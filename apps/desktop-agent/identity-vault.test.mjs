import test from "node:test";
import assert from "node:assert/strict";
import { createIdentityVault } from "./identity-vault.mjs";
function fixture() {
  const files = new Map();
  let writes = 0;
  // Synthetic encryption for API-shape tests only. Never used by the app.
  const safeStorage = {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (s) =>
      Buffer.from(s.split("").reverse().join("")),
    decryptStringAsync: async (b) => ({
      result: b.toString().split("").reverse().join(""),
      shouldReEncrypt: false,
    }),
  };
  const fs = {
    mkdir: async () => {},
    readFile: async (p) => {
      if (!files.has(p)) throw Object.assign(new Error(), { code: "ENOENT" });
      return files.get(p);
    },
    writeFile: async (p, s) => {
      writes++;
      files.set(p, s);
    },
    rename: async (a, b) => {
      files.set(b, files.get(a));
      files.delete(a);
    },
  };
  return {
    files,
    safeStorage,
    fs,
    vault: () =>
      createIdentityVault({ safeStorage, directory: "synthetic-no-disk", fs }),
    writes: () => writes,
  };
}
test("identity roundtrips Electron 45 async result shape and serializes concurrent creation", async () => {
  const f = fixture();
  const v = f.vault();
  await v.initialize();
  const [one, two] = await Promise.all([v.ensure(), v.ensure()]);
  assert.deepEqual(one, two);
  assert.equal(f.writes(), 1);
  assert.deepEqual(Object.keys(one).sort(), ["fingerprint", "publicKey"]);
  assert.equal(one.fingerprint.length, 64);
  const restored = f.vault();
  await restored.initialize();
  assert.equal(restored.available(), true);
  assert.deepEqual(restored.publicIdentity(), one);
  await restored.ensure();
  assert.equal(f.writes(), 1);
});
test("unavailable/plaintext storage and tampered identity fail closed without replacement", async () => {
  for (const backend of [false, "basic_text"]) {
    const f = fixture();
    if (backend === false)
      f.safeStorage.isAsyncEncryptionAvailable = async () => false;
    else f.safeStorage.getSelectedStorageBackend = () => backend;
    const v = f.vault();
    await v.initialize();
    await assert.rejects(v.ensure(), /secure_storage/);
    assert.equal(f.writes(), 0);
  }
  const f = fixture();
  const v = f.vault();
  await v.initialize();
  await v.ensure();
  for (const [path, value] of f.files)
    f.files.set(
      path,
      value.replace(/"fingerprint":"[a-f0-9]+"/, '"fingerprint":"tampered"'),
    );
  const restored = f.vault();
  await restored.initialize();
  assert.equal(restored.available(), false);
  await assert.rejects(restored.ensure(), /secure_storage/);
  assert.equal(f.writes(), 1);
});
test("OS encryption rotation rewrites encrypted record while preserving public identity", async () => {
  const f = fixture();
  const v = f.vault();
  await v.initialize();
  const original = await v.ensure();
  const decrypt = f.safeStorage.decryptStringAsync;
  f.safeStorage.decryptStringAsync = async (b) => ({
    ...(await decrypt(b)),
    shouldReEncrypt: true,
  });
  const restored = f.vault();
  await restored.initialize();
  assert.deepEqual(restored.publicIdentity(), original);
  assert.equal(f.writes(), 2);
});
