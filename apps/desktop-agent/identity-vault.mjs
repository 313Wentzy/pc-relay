import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";

// Private keys stay in this main-process closure. Only public identity is returned.
export function createIdentityVault({
  safeStorage,
  directory,
  fs = { readFile, writeFile, mkdir, rename },
}) {
  let identity = null;
  let creating = null;
  let available = false;
  let signingKey = null;
  const file = join(directory, "identity.json");
  const publicIdentity = (privateKey) => {
    if (createPrivateKey(privateKey).asymmetricKeyType !== "ed25519")
      throw new Error("invalid_identity");
    const publicKey = createPublicKey(privateKey).export({
      type: "spki",
      format: "pem",
    });
    return Object.freeze({
      publicKey,
      fingerprint: createHash("sha256").update(publicKey).digest("hex"),
    });
  };
  async function encryptedRecord(privateKey, publicPart) {
    const encrypted = await safeStorage.encryptStringAsync(privateKey);
    if (!Buffer.isBuffer(encrypted) || !encrypted.length)
      throw new Error("secure_storage_unavailable");
    return {
      version: 1,
      ...publicPart,
      encryptedPrivateKey: encrypted.toString("base64"),
    };
  }
  async function save(record) {
    await fs.mkdir(directory, { recursive: true });
    const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(record), {
      mode: 0o600,
      flag: "wx",
    });
    await fs.rename(temporary, file);
  }
  async function initialize() {
    available =
      typeof safeStorage.isAsyncEncryptionAvailable === "function" &&
      (await safeStorage.isAsyncEncryptionAvailable());
    if (
      typeof safeStorage.getSelectedStorageBackend === "function" &&
      safeStorage.getSelectedStorageBackend() === "basic_text"
    )
      available = false;
    if (!available) return;
    try {
      const text = await fs.readFile(file, "utf8");
      if (text.length > 16384) throw new Error("invalid_identity");
      const saved = JSON.parse(text);
      if (saved.version !== 1 || typeof saved.encryptedPrivateKey !== "string")
        throw new Error("invalid_identity");
      const decrypted = await safeStorage.decryptStringAsync(
        Buffer.from(saved.encryptedPrivateKey, "base64"),
      );
      if (typeof decrypted?.result !== "string")
        throw new Error("invalid_identity");
      const publicPart = publicIdentity(decrypted.result);
      if (
        publicPart.publicKey !== saved.publicKey ||
        publicPart.fingerprint !== saved.fingerprint
      )
        throw new Error("invalid_identity");
      if (decrypted.shouldReEncrypt)
        await save(await encryptedRecord(decrypted.result, publicPart));
      identity = publicPart;
      signingKey = decrypted.result;
    } catch (error) {
      // Never silently replace an unreadable or tampered paired identity.
      if (error.code !== "ENOENT") available = false;
    }
  }
  async function ensure() {
    if (!available) throw new Error("secure_storage_unavailable");
    if (identity) return identity;
    if (!creating)
      creating = (async () => {
        const { privateKey } = generateKeyPairSync("ed25519", {
          privateKeyEncoding: { type: "pkcs8", format: "pem" },
          publicKeyEncoding: { type: "spki", format: "pem" },
        });
        const publicPart = publicIdentity(privateKey);
        await save(await encryptedRecord(privateKey, publicPart));
        identity = publicPart;
        signingKey = privateKey;
        return identity;
      })().finally(() => {
        creating = null;
      });
    return creating;
  }
  async function readState() {
    if (!available) throw new Error("secure_storage_unavailable");
    try {
      const text = await fs.readFile(
        join(directory, "pairing-state.json"),
        "utf8",
      );
      if (text.length > 65536) throw new Error("invalid_state");
      const stored = JSON.parse(text);
      if (stored.version !== 1 || typeof stored.encrypted !== "string")
        throw new Error("invalid_state");
      const { result } = await safeStorage.decryptStringAsync(
        Buffer.from(stored.encrypted, "base64"),
      );
      return JSON.parse(result);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw new Error("invalid_encrypted_state");
    }
  }
  async function writeState(state) {
    if (!available) throw new Error("secure_storage_unavailable");
    const encrypted = await safeStorage.encryptStringAsync(
      JSON.stringify(state),
    );
    if (!Buffer.isBuffer(encrypted) || !encrypted.length)
      throw new Error("secure_storage_unavailable");
    await fs.mkdir(directory, { recursive: true });
    const location = join(directory, "pairing-state.json");
    const temporary = `${location}.${randomBytes(8).toString("hex")}.tmp`;
    await fs.writeFile(
      temporary,
      JSON.stringify({ version: 1, encrypted: encrypted.toString("base64") }),
      { mode: 0o600, flag: "wx" },
    );
    await fs.rename(temporary, location);
  }
  return Object.freeze({
    initialize,
    ensure,
    publicIdentity: () => identity,
    available: () => available,
    readState,
    writeState,
    signRelay: async (body) => {
      await ensure();
      if (typeof body !== "string" || body.length > 16384)
        throw new Error("invalid_proof");
      const parsed = JSON.parse(body);
      if (
        parsed.purpose !== "long-cable-relay-proof-v1" ||
        typeof parsed.nonce !== "string" ||
        parsed.nonce.length !== 43 ||
        typeof parsed.certificate !== "string"
      )
        throw new Error("invalid_proof");
      return sign(null, Buffer.from(body), signingKey).toString("base64url");
    },
  });
}
