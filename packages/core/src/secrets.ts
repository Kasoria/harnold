import fs from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "./config.ts";

/** AES-256-GCM with a per-workspace key file (chmod 600). Protects secrets at rest in the DB. */
const keyFilePath = path.join(config.dataDirectory, "secret.key");

function loadOrCreateKey(): Buffer {
  if (fs.existsSync(keyFilePath)) return Buffer.from(fs.readFileSync(keyFilePath, "utf8").trim(), "base64");
  const key = randomBytes(32);
  fs.writeFileSync(keyFilePath, key.toString("base64"), { mode: 0o600 });
  return key;
}

const encryptionKey = loadOrCreateKey();

export function encryptSecret(plainText: string): string {
  const initializationVector = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey, initializationVector);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  return ["v1", initializationVector.toString("base64"), cipher.getAuthTag().toString("base64"), encrypted.toString("base64")].join(":");
}

export function decryptSecret(cipherText: string): string {
  const [version, initializationVector, authTag, encrypted] = cipherText.split(":");
  if (version !== "v1") throw new Error("Unbekanntes Secret-Format");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey, Buffer.from(initializationVector, "base64"));
  decipher.setAuthTag(Buffer.from(authTag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]).toString("utf8");
}
