// Password (scrypt) dan token login (JWT HS256), hanya memakai node:crypto.
// Keduanya format standar, jadi backend Rust nanti bisa memverifikasi
// hash dan token yang sama (crate `scrypt` dan `jsonwebtoken`).
import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { HttpError } from './router.js';

const scryptAsync = promisify(scrypt);
const N = 2 ** 15, R = 8, P = 1, KEYLEN = 64;
const MAXMEM = 64 * 1024 * 1024;

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new HttpError(400, 'password must be at least 8 characters');
  }
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt' || typeof password !== 'string') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scryptAsync(password, Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: MAXMEM,
  });
  return timingSafeEqual(actual, expected);
}

// Hash palsu untuk username yang tidak ada, supaya waktu respons tetap sama
// (penyerang tidak bisa menebak username mana yang terdaftar).
export const DUMMY_HASH = await hashPassword('dummy-password-for-timing');

const b64u = (s) => Buffer.from(s).toString('base64url');
const TOKEN_TTL = 30 * 24 * 3600; // 30 hari

export function signToken(payload, secret) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ ...payload, iat: now, exp: now + TOKEN_TTL }));
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

export function verifyToken(token, secret) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts;
  const expected = createHmac('sha256', secret).update(`${head}.${body}`).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const header = JSON.parse(Buffer.from(head, 'base64url'));
    const payload = JSON.parse(Buffer.from(body, 'base64url'));
    if (header.alg !== 'HS256') return null;
    if (typeof payload.exp !== 'number' || payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

// Batas percobaan login: 10 kali per 15 menit per IP.
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

export function checkLoginRate(ip) {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || entry.reset < now) {
    attempts.set(ip, { count: 1, reset: now + WINDOW_MS });
    return;
  }
  entry.count += 1;
  if (entry.count > MAX_ATTEMPTS) {
    throw new HttpError(429, 'too many login attempts, try again later');
  }
}

export function clearLoginRate(ip) {
  attempts.delete(ip);
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of attempts) if (e.reset < now) attempts.delete(ip);
}, WINDOW_MS).unref();
