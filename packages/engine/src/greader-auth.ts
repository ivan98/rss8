// Single-user Google Reader auth, stateless: the Api object is replaced after
// about 10 s idle, so every token is recomputed from AUTH_SECRET on each request.
//   Auth token  <user>/<hex HMAC-SHA256(AUTH_SECRET, "auth:" + user + "\n" + API_PASSWORD)>
//   write token first 40 hex chars of HMAC(AUTH_SECRET, "write:" + user + "\n" + API_PASSWORD),
//               padded with Z to 57 characters, the length FreshRSS returns
// Signing the password too, as FreshRSS does, means changing either secret
// logs every client out.

export interface AuthSecrets {
  password: string;
  secret: string;
}

const MIN_SECRET_LENGTH = 32;
const MIN_PASSWORD_LENGTH = 8;

/** Undefined when a secret is missing or too short: the API then refuses every login and token. */
export function authSecrets(env: { API_PASSWORD?: string; AUTH_SECRET?: string }): AuthSecrets | undefined {
  const { API_PASSWORD: password, AUTH_SECRET: secret } = env;
  if (!password || password.length < MIN_PASSWORD_LENGTH) return undefined;
  if (!secret || secret.length < MIN_SECRET_LENGTH) return undefined;
  return { password, secret };
}

// No whitespace (the login answer is line-based) and no "/" (it separates the
// user from the signature).
const USER = /^[^\s/]{1,128}$/;

/** The `Auth` token for a correct login, else undefined. */
export async function login(secrets: AuthSecrets, email: string, passwd: string): Promise<string | undefined> {
  if (!USER.test(email)) return undefined;
  // Comparing two HMACs keeps the comparison constant-time whatever the lengths.
  const [given, expected] = await Promise.all([
    hmacHex(secrets.secret, `password:${passwd}`),
    hmacHex(secrets.secret, `password:${secrets.password}`),
  ]);
  if (!equal(given, expected)) return undefined;
  return authToken(secrets, email);
}

/** The user named by a valid `Authorization: GoogleLogin auth=…` header, else undefined. */
export async function authenticate(secrets: AuthSecrets, header: string | null): Promise<string | undefined> {
  const token = /^GoogleLogin auth=(\S+)$/.exec(header ?? "")?.[1];
  if (!token) return undefined;
  const user = token.slice(0, token.lastIndexOf("/"));
  if (!USER.test(user)) return undefined;
  return equal(token, await authToken(secrets, user)) ? user : undefined;
}

export async function writeToken(secrets: AuthSecrets, user: string): Promise<string> {
  return (await hmacHex(secrets.secret, `write:${user}\n${secrets.password}`)).slice(0, 40).padEnd(57, "Z");
}

/** FreshRSS's rule: no `T`, an empty `T` and `x` pass; anything else must be the user's write token. */
export async function writeTokenAccepted(secrets: AuthSecrets, user: string, t: string | null): Promise<boolean> {
  if (t === null || t === "" || t === "x") return true;
  return equal(t, await writeToken(secrets, user));
}

async function authToken(secrets: AuthSecrets, user: string): Promise<string> {
  return `${user}/${await hmacHex(secrets.secret, `auth:${user}\n${secrets.password}`)}`;
}

const encoder = new TextEncoder();

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
  return Array.from(signature, (b) => b.toString(16).padStart(2, "0")).join("");
}

function equal(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y);
}
