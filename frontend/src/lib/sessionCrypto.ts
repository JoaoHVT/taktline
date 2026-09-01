/**
 * sessionCrypto — password-based encryption for exported session files.
 *
 * SECURITY MODEL (Idea 3, "password-derived AES-256"):
 *   A session file is fully self-contained and lives OUTSIDE the app's auth
 *   boundary once downloaded. The only real protection for such a file is to
 *   make the decryption key derive from a secret that is NOT in the file: the
 *   user's password. We therefore encrypt the entire payload with AES-256-GCM
 *   using a key derived from the password via PBKDF2-SHA256 (600k iterations).
 *
 *   - Confidentiality: opening the file in a text editor reveals only the
 *     crypto envelope (salt / iv / ciphertext) — no business data.
 *   - Integrity / tamper detection: AES-GCM's authentication tag makes ANY
 *     edit to the ciphertext (or a swapped salt/iv) fail decryption. The
 *     envelope parameters are additionally bound as GCM "additional data".
 *   - Possessing the JSON alone is insufficient: without the password the
 *     contents are unrecoverable (there is no recovery — by design).
 *
 * The password is used transiently to derive a key and is never stored,
 * logged, or written anywhere.
 */

// ── Envelope constants ───────────────────────────────────────────────────────
const FMT = 'taktline-session-enc'
const ENC_V = 2                       // envelope format version (2 = gzip-compressed plaintext)
const AAD = 'taktline-session-enc:v1' // bound as AES-GCM additional data
const PBKDF2_ITER = 600_000
const SALT_BYTES = 16
const IV_BYTES = 12

/** Supported *inner* (application-data) payload version.
 *  v1 = original Capacity-only payload (and legacy plaintext).
 *  v2 = adds the Carga de Fábrica (Gantt) section + capacity filters/overrides.
 *  Older builds reject a v2 file with UNSUPPORTED_VERSION (graceful). */
const SUPPORTED_DATA_VERSION = 2

/** Hard cap on the file we are willing to parse (DoS guard on import). */
export const MAX_SESSION_CHARS = 32 * 1024 * 1024 // 32 MB

/** Hard cap on the DECOMPRESSED payload (zip-bomb guard). Compression routinely buys
 *  10× on this JSON, so a legitimate session stays far below this. */
const MAX_INFLATED_BYTES = 512 * 1024 * 1024 // 512 MB

/** Minimum length we require of a session password on save. */
export const MIN_PASSWORD_LEN = 8

// ── Typed errors ─────────────────────────────────────────────────────────────
export type SessionErrorCode =
  | 'NO_CRYPTO'          // WebCrypto unavailable (insecure context)
  | 'TOO_LARGE'          // file exceeds MAX_SESSION_CHARS
  | 'INVALID'            // not a recognisable session file
  | 'PASSWORD_REQUIRED'  // encrypted file loaded without a password
  | 'BAD_PASSWORD'       // wrong password OR tampered ciphertext
  | 'MALFORMED'          // decrypted bytes are not valid JSON
  | 'UNSUPPORTED_VERSION'// newer file than this build understands
  | 'INVALID_SCHEMA'     // payload shape failed validation

export class SessionError extends Error {
  code: SessionErrorCode
  constructor(code: SessionErrorCode, message: string) {
    super(message)
    this.name = 'SessionError'
    this.code = code
  }
}

export type SessionFormat = 'encrypted' | 'legacy' | 'invalid'

interface Envelope {
  fmt: string
  encv: number
  cipher: string
  kdf: string
  iter: number
  salt: string
  iv: string
  data: string
  /** Compression applied to the plaintext BEFORE encryption. Absent/'none' on
   *  envelopes written by builds older than encv 2. */
  zip?: 'gzip' | 'none'
}

// ── Small helpers ────────────────────────────────────────────────────────────
function requireCrypto(): SubtleCrypto {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) {
    throw new SessionError(
      'NO_CRYPTO',
      'Criptografia indisponível neste ambiente (requer conexão segura HTTPS).',
    )
  }
  return subtle
}

// Chunked so a multi-megabyte payload doesn't blow the argument limit of
// String.fromCharCode.apply (and to keep the intermediate strings small).
const B64_CHUNK = 0x8000

function bytesToB64(bytes: Uint8Array): string {
  const parts: string[] = []
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    parts.push(String.fromCharCode(...bytes.subarray(i, i + B64_CHUNK)))
  }
  return btoa(parts.join(''))
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Copy any byte view into a fresh, concrete ArrayBuffer (satisfies BufferSource). */
function buf(u: Uint8Array): ArrayBuffer {
  const b = new ArrayBuffer(u.byteLength)
  new Uint8Array(b).set(u)
  return b
}

function utf8(s: string): ArrayBuffer {
  return buf(new TextEncoder().encode(s))
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

// ── Compression (gzip, via the platform CompressionStream) ───────────────────
// Session payloads are mostly repetitive JSON, so gzip typically shrinks them by an
// order of magnitude. Compression happens BEFORE encryption (ciphertext is
// incompressible), and is transparent: the envelope records which codec was used and
// the reader applies the matching one — files written without it still load.

function hasCompression(): boolean {
  return typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined'
}

/** Drain a stream into one contiguous byte array, aborting past `cap` bytes. */
async function readAll(stream: ReadableStream<Uint8Array>, cap: number): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      size += value.byteLength
      if (size > cap) {
        await reader.cancel().catch(() => {})
        throw new SessionError('TOO_LARGE', 'Arquivo de sessão muito grande.')
      }
      chunks.push(value)
    }
  }
  const out = new Uint8Array(size)
  let at = 0
  for (const c of chunks) { out.set(c, at); at += c.byteLength }
  return out
}

/** Push bytes through a (de)compression transform. The casts bridge the DOM lib's
 *  BufferSource-typed writable side to our concrete Uint8Array pipeline. */
async function through(bytes: Uint8Array, ts: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const src = new Blob([buf(bytes)]).stream() as unknown as ReadableStream<Uint8Array>
  const out = src.pipeThrough(ts as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)
  return readAll(out, MAX_INFLATED_BYTES)
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  return through(bytes, new CompressionStream('gzip'))
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (!hasCompression()) {
    throw new SessionError(
      'NO_CRYPTO',
      'Este navegador não suporta descompactação de sessões (atualize o navegador).',
    )
  }
  try {
    return await through(bytes, new DecompressionStream('gzip'))
  } catch (e) {
    if (e instanceof SessionError) throw e
    throw new SessionError('MALFORMED', 'Conteúdo da sessão corrompido (falha ao descompactar).')
  }
}

async function deriveKey(password: string, salt: Uint8Array, iter: number): Promise<CryptoKey> {
  const subtle = requireCrypto()
  const baseKey = await subtle.importKey(
    'raw',
    utf8(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  )
  return subtle.deriveKey(
    { name: 'PBKDF2', salt: buf(salt), iterations: iter, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Encrypt a session payload with a password. Returns the file text to download.
 * Throws SessionError('NO_CRYPTO') if WebCrypto is unavailable.
 */
export async function encryptSession(payload: unknown, password: string): Promise<string> {
  const subtle = requireCrypto()
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const key = await deriveKey(password, salt, PBKDF2_ITER)

  // Compress first — ciphertext is incompressible, so the order matters. Browsers
  // without CompressionStream simply write an uncompressed (encv 1) envelope.
  const raw = new TextEncoder().encode(JSON.stringify(payload))
  const compressed = hasCompression()
  const plain = compressed ? await gzip(raw) : raw

  const ct = await subtle.encrypt(
    { name: 'AES-GCM', iv: buf(iv), additionalData: utf8(AAD) },
    key,
    buf(plain),
  )
  const envelope: Envelope = {
    fmt: FMT,
    encv: compressed ? ENC_V : 1,
    cipher: 'AES-256-GCM',
    kdf: 'PBKDF2-SHA256',
    iter: PBKDF2_ITER,
    salt: bytesToB64(salt),
    iv: bytesToB64(iv),
    data: bytesToB64(new Uint8Array(ct)),
    zip: compressed ? 'gzip' : 'none',
  }
  // Written compactly (no pretty-printing): `data` is one long base64 blob, so
  // indentation only inflated the file.
  return JSON.stringify(envelope)
}

/**
 * Classify a file's text WITHOUT decrypting — used to route the load UI
 * (prompt for a password vs. load a legacy plaintext session). Never throws.
 */
export function detectSessionFormat(text: string): SessionFormat {
  let obj: unknown
  try { obj = JSON.parse(text) } catch { return 'invalid' }
  if (!isObject(obj)) return 'invalid'
  if (obj.fmt === FMT) return 'encrypted'
  // Legacy = an old, unencrypted session written before this feature existed.
  if ('items' in obj || 'importMeta' in obj || 'assemblyDetails' in obj || 'version' in obj) {
    return 'legacy'
  }
  return 'invalid'
}

function validateEnvelope(obj: unknown): Envelope {
  if (!isObject(obj) || obj.fmt !== FMT) {
    throw new SessionError('INVALID', 'Arquivo de sessão inválido.')
  }
  if (typeof obj.encv !== 'number' || obj.encv > ENC_V) {
    throw new SessionError(
      'UNSUPPORTED_VERSION',
      'Este arquivo foi criado por uma versão mais recente do aplicativo.',
    )
  }
  if (obj.cipher !== 'AES-256-GCM'
    || typeof obj.salt !== 'string'
    || typeof obj.iv !== 'string'
    || typeof obj.data !== 'string') {
    throw new SessionError('INVALID', 'Arquivo de sessão corrompido ou inválido.')
  }
  if (obj.zip != null && obj.zip !== 'gzip' && obj.zip !== 'none') {
    throw new SessionError('UNSUPPORTED_VERSION', 'Compactação de sessão desconhecida neste arquivo.')
  }
  return obj as unknown as Envelope
}

/** Structural + version validation of a decrypted / legacy payload. */
function validatePayload(obj: unknown): Record<string, unknown> {
  if (!isObject(obj)) throw new SessionError('INVALID_SCHEMA', 'Conteúdo da sessão inválido.')

  const ver = obj.version
  if (ver != null && (typeof ver !== 'number' || ver > SUPPORTED_DATA_VERSION)) {
    throw new SessionError(
      'UNSUPPORTED_VERSION',
      'Este arquivo foi criado por uma versão mais recente do aplicativo.',
    )
  }

  const arrayOk = (v: unknown) => v == null || Array.isArray(v)
  const objOk = (v: unknown) => v == null || isObject(v)

  if (!arrayOk(obj.items))            throw new SessionError('INVALID_SCHEMA', 'Lista de itens inválida no arquivo.')
  if (!arrayOk(obj.lastSolverRows))   throw new SessionError('INVALID_SCHEMA', 'Resultados de otimização inválidos no arquivo.')
  if (!objOk(obj.assemblyDetails))    throw new SessionError('INVALID_SCHEMA', 'Detalhes de montagem inválidos no arquivo.')
  if (!objOk(obj.importMeta))         throw new SessionError('INVALID_SCHEMA', 'Metadados de importação inválidos no arquivo.')
  if (obj.solverKpis != null && !isObject(obj.solverKpis)) {
    throw new SessionError('INVALID_SCHEMA', 'KPIs inválidos no arquivo.')
  }
  if (obj.headcountMode != null && obj.headcountMode !== 'skill' && obj.headcountMode !== 'headcount') {
    throw new SessionError('INVALID_SCHEMA', 'Modo de headcount inválido no arquivo.')
  }
  if (obj.viewMode != null && obj.viewMode !== 'semanal' && obj.viewMode !== 'mensal') {
    throw new SessionError('INVALID_SCHEMA', 'Modo de visualização inválido no arquivo.')
  }
  if (obj.mappedDays != null && typeof obj.mappedDays !== 'number') {
    throw new SessionError('INVALID_SCHEMA', 'Dias mapeados inválidos no arquivo.')
  }

  return obj
}

/**
 * Read a session file to a validated payload object.
 *   - Enforces the size cap (DoS guard) before parsing.
 *   - Encrypted files require the correct password (AES-GCM verifies integrity).
 *   - Legacy plaintext files load without a password (nothing to decrypt).
 *   - The resulting payload is structurally validated before it is returned.
 * Throws SessionError with a user-facing (pt-BR) message on any failure.
 */
export async function readSessionFile(
  text: string,
  password: string | null,
): Promise<Record<string, unknown>> {
  if (text.length > MAX_SESSION_CHARS) {
    throw new SessionError('TOO_LARGE', 'Arquivo de sessão muito grande.')
  }

  const fmt = detectSessionFormat(text)
  if (fmt === 'invalid') {
    throw new SessionError('INVALID', 'Arquivo de sessão inválido.')
  }

  if (fmt === 'legacy') {
    // Unencrypted session from before this feature — parse directly.
    return validatePayload(JSON.parse(text))
  }

  // Encrypted path.
  if (!password) {
    throw new SessionError('PASSWORD_REQUIRED', 'Senha necessária para abrir esta sessão.')
  }
  const env = validateEnvelope(JSON.parse(text))
  const key = await deriveKey(password, b64ToBytes(env.salt), env.iter || PBKDF2_ITER)

  let ptBuf: ArrayBuffer
  try {
    ptBuf = await requireCrypto().decrypt(
      { name: 'AES-GCM', iv: buf(b64ToBytes(env.iv)), additionalData: utf8(AAD) },
      key,
      buf(b64ToBytes(env.data)),
    )
  } catch {
    // AES-GCM auth failure: wrong password OR the file was tampered with.
    throw new SessionError('BAD_PASSWORD', 'Senha incorreta ou arquivo corrompido/adulterado.')
  }

  // Decompress if the envelope says so (transparent: older, uncompressed
  // envelopes carry no `zip` field and are decoded directly).
  const plain = env.zip === 'gzip'
    ? await gunzip(new Uint8Array(ptBuf))
    : new Uint8Array(ptBuf)

  let obj: unknown
  try {
    obj = JSON.parse(new TextDecoder().decode(plain))
  } catch {
    throw new SessionError('MALFORMED', 'Conteúdo da sessão inválido.')
  }
  return validatePayload(obj)
}
