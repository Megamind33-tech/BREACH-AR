import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (p: string, s: Buffer, n: number) => Promise<Buffer>;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltHex, keyHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(expected, actual);
}

export const sha256Hex = (s: string) => createHash('sha256').update(s).digest('hex');
export const newSecret = (prefix: string) => `${prefix}_${randomBytes(32).toString('base64url')}`;

export const ROLE_RANK = { viewer: 1, technician: 2, admin: 3, owner: 4 } as const;
export type Role = keyof typeof ROLE_RANK;
export const atLeast = (have: Role, need: Role) => ROLE_RANK[have] >= ROLE_RANK[need];
