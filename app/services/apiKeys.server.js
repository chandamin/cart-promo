import { createHash, randomBytes } from "node:crypto";
import prisma from "../db.server";

const KEY_PREFIX = "cp_";

function hashKey(key) {
  return createHash("sha256").update(key).digest("hex");
}

export async function getApiKeyInfo(shop) {
  const record = await prisma.apiKey.findUnique({ where: { shop } });
  return record
    ? { keyPrefix: record.keyPrefix, createdAt: record.createdAt, lastUsedAt: record.lastUsedAt }
    : null;
}

/** Creates (or replaces) the shop's API key. Returns the plaintext key — the only time it exists. */
export async function generateApiKey(shop) {
  const key = KEY_PREFIX + randomBytes(32).toString("hex");
  const data = { keyHash: hashKey(key), keyPrefix: key.slice(0, KEY_PREFIX.length + 6), lastUsedAt: null };
  await prisma.apiKey.upsert({ where: { shop }, create: { shop, ...data }, update: data });
  return key;
}

export async function revokeApiKey(shop) {
  await prisma.apiKey.deleteMany({ where: { shop } });
}

/** Resolves a presented key to its shop, or null. */
export async function findShopByApiKey(key) {
  if (!key?.startsWith(KEY_PREFIX)) return null;
  const record = await prisma.apiKey.findUnique({ where: { keyHash: hashKey(key) } });
  if (!record) return null;
  await prisma.apiKey.update({ where: { id: record.id }, data: { lastUsedAt: new Date() } });
  return record.shop;
}
