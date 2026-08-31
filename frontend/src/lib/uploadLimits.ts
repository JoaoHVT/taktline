/**
 * uploadLimits — the one size ceiling every file picker in the app enforces.
 *
 * MIRRORS THE SERVER, IT DOES NOT REPLACE IT. `main.py::_UPLOAD_MAX_BYTES` is the control and
 * rejects an oversize body regardless of what the browser did; this is the courtesy check that
 * turns a 413 arriving after a 40 MB upload into an immediate, named refusal. Keep the two
 * numbers equal — if the server's `UPLOAD_MAX_BYTES` is ever raised, raise this with it.
 *
 * IT ALSO GUARDS THE PURELY LOCAL READERS. Logística, Materiais and the GCR plan parse their
 * workbook in the browser and never upload it, so the server ceiling does not apply to them at
 * all. Those are precisely the readers that fall over on a huge file — `XLSX.read` over tens of
 * MB of decompressed XML is the tab's memory ceiling, not the network's — so they need a limit
 * of their own, and it is the same number for one reason: a user who is told "40 MB" on one
 * screen must not be refused at 25 MB on another.
 */

/** 40 MB, matching `main.py::_UPLOAD_MAX_BYTES`. */
export const UPLOAD_MAX_BYTES = 40 * 1024 * 1024

/** "41,3 MB" — for the refusal message, so the user sees how far over they are. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / (1024 * 1024)).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`
}

/** The refusal text. One wording everywhere: the message names the limit AND the actual size,
 *  because "arquivo muito grande" alone leaves the user with nothing to act on. */
export const oversizeMessage = (file: { name: string; size: number }): string =>
  `"${file.name}" tem ${formatBytes(file.size)} e excede o limite de ` +
  `${formatBytes(UPLOAD_MAX_BYTES)} por arquivo.`

/**
 * Null when the file is within the limit, the refusal message when it is not.
 *
 * Returns a message rather than throwing: every call site already has an error slot on screen
 * (`setFileError`, `setError`, …) and a thrown value would have to be caught into it anyway.
 */
export function checkUploadSize(
  file: { name: string; size: number },
  maxBytes: number = UPLOAD_MAX_BYTES,
): string | null {
  return file.size > maxBytes ? oversizeMessage(file) : null
}
