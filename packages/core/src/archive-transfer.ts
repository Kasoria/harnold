/**
 * Brings a workspace archive into a Harnold core: announce it, upload it in parallel pieces, let the core unpack and
 * apply it. Used by the Core ("move to a server") and by the UI (file import), so this file has no imports and uses
 * only what Node and browsers share.
 *
 * Small pieces keep every request short, so no time limit or upload limit on the way (Node, reverse proxy, tunnel)
 * can cut off a large workspace on a slow line. Several at once use the line better than a single connection.
 */

export type ByteRange = [start: number, end: number];
export type UploadState = "receiving" | "unpacking" | "restarting" | "restartRequired" | "applied" | "failed";
export type UploadStatus = { state: UploadState; receivedBytes: number; ranges?: ByteRange[]; error?: string; warning?: string };
export type ServerAnswer = Partial<UploadStatus> & { uploadId?: string };

export type TransferBody = string | Uint8Array<ArrayBuffer> | Blob;
/** One request to the receiving core. Throws only when there is no answer. */
export type TransferRequest = (method: "GET" | "POST" | "PUT", route: string, options: { body?: TransferBody; contentType?: string; signal: AbortSignal }) => Promise<{ status: number; answer: ServerAnswer }>;

export type TransferProgress = { phase: "uploading" | "unpacking" | "restarting"; sentBytes: number; totalBytes: number; remainingSeconds: number | null; reconnecting: boolean };
export type TransferMessages = {
  serverError: (statusCode: number, detail?: string) => string;
  connectionLost: (reason: string) => string;
  uploadLimit: () => string;
  notResponding: () => string;
};

export type TransferOptions = {
  totalBytes: number;
  /** Size after unpacking, if known: the receiver checks its free disk space before the upload. */
  unpackedBytes?: number;
  read: (start: number, end: number) => Promise<Uint8Array<ArrayBuffer> | Blob>;
  request: TransferRequest;
  parallelUploads: number;
  signal: AbortSignal;
  messages: TransferMessages;
  onProgress: (progress: TransferProgress) => void;
};

const minimumChunkBytes = 256 * 1024;
const initialChunkBytes = 512 * 1024;
const maximumChunkBytes = 8 * 1024 * 1024;
const targetChunkSeconds = 10;
const chunkTimeoutMilliseconds = 4 * 60 * 1000;
const shortTimeoutMilliseconds = 60 * 1000;
/** Per parallel upload; with the pauses below about half an hour without a connection before giving up. */
const failuresPerUpload = 60;
const maximumCreateAttempts = 6;
const statusPollMilliseconds = 3000;
/** About fifteen minutes in which the receiver may be unreachable while it restarts. */
const maximumStatusFailures = 300;
const speedWindowMilliseconds = 60 * 1000;

/** The parts of `0…totalBytes` that `received` (sorted, not overlapping) does not cover. */
export function missingRanges(received: ByteRange[], totalBytes: number): ByteRange[] {
  const missing: ByteRange[] = [];
  let position = 0;
  for (const [start, end] of received) {
    if (start > position) missing.push([position, start]);
    position = Math.max(position, end);
  }
  if (position < totalBytes) missing.push([position, totalBytes]);
  return missing;
}

/** `ranges` plus `added`, sorted and with touching parts joined. */
export function addRange(ranges: ByteRange[], added: ByteRange): ByteRange[] {
  const merged: ByteRange[] = [];
  for (const [start, end] of [...ranges, added].sort((first, second) => first[0] - second[0])) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

const pause = (milliseconds: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });

const isTemporaryFailure = (statusCode: number) => statusCode === 408 || statusCode === 425 || statusCode === 429 || statusCode >= 500;
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A request that ends when the transfer is cancelled or the answer takes too long. */
async function sendWithTimeout(options: TransferOptions, signal: AbortSignal, method: "GET" | "POST" | "PUT", route: string, body?: TransferBody, contentType?: string, timeoutMilliseconds = shortTimeoutMilliseconds) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, timeoutMilliseconds);
  try {
    signal.throwIfAborted();
    return await options.request(method, route, { body, contentType, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

/** Announces the archive; a short interruption here must not throw away the packed workspace. */
async function createUpload(options: TransferOptions): Promise<string> {
  const body = JSON.stringify({ sizeBytes: options.totalBytes, unpackedBytes: options.unpackedBytes });
  for (let attempt = 1; ; attempt += 1) {
    let failure: string;
    let temporary = true;
    try {
      const { status, answer } = await sendWithTimeout(options, options.signal, "POST", "/api/migration/uploads", body, "application/json");
      if (status < 300 && answer.uploadId) return answer.uploadId;
      failure = options.messages.serverError(status, answer.error);
      temporary = isTemporaryFailure(status);
    } catch (networkError) {
      options.signal.throwIfAborted();
      failure = options.messages.connectionLost(describe(networkError));
    }
    if (!temporary || attempt >= maximumCreateAttempts) throw new Error(failure);
    await pause(statusPollMilliseconds * attempt, options.signal);
  }
}

async function uploadRanges(options: TransferOptions, uploadId: string, pending: ByteRange[]): Promise<void> {
  const queue = pending.map(([start, end]): ByteRange => [start, end]);
  let chunkBytes = initialChunkBytes;
  let chunkCeiling = maximumChunkBytes;
  let sentBytes = options.totalBytes - queue.reduce((sum, [start, end]) => sum + end - start, 0);
  let piecesUnderway = 0;
  let consecutiveFailures = 0;
  let samples = [{ time: Date.now(), bytes: sentBytes }];
  // Stops the other uploads as soon as one of them gives up.
  const stop = new AbortController();
  const stopWithCaller = () => stop.abort(options.signal.reason);
  options.signal.addEventListener("abort", stopWithCaller, { once: true });
  let failure: unknown = null;

  const report = (reconnecting: boolean) => {
    const now = Date.now();
    while (samples.length > 2 && now - samples[0].time > speedWindowMilliseconds) samples.shift();
    const bytesPerSecond = ((sentBytes - samples[0].bytes) / Math.max(1, now - samples[0].time)) * 1000;
    const remainingSeconds = !reconnecting && bytesPerSecond > 0 ? Math.ceil((options.totalBytes - sentBytes) / bytesPerSecond) : null;
    options.onProgress({ phase: "uploading", sentBytes, totalBytes: options.totalBytes, remainingSeconds, reconnecting });
  };

  const takePiece = (): ByteRange | null => {
    const first = queue[0];
    if (!first) return null;
    const end = Math.min(first[1], first[0] + chunkBytes);
    if (end === first[1]) queue.shift();
    else queue[0] = [end, first[1]];
    return [first[0], end];
  };

  const uploadNext = async () => {
    let ownFailures = 0;
    for (;;) {
      stop.signal.throwIfAborted();
      const piece = takePiece();
      if (!piece) {
        // Another upload may still hand its piece back.
        if (!piecesUnderway) return;
        await pause(200, stop.signal);
        continue;
      }
      piecesUnderway += 1;
      const [start, end] = piece;
      const length = end - start;
      let retryReason: string | null = null;
      try {
        const chunk = await options.read(start, end);
        const startedAt = Date.now();
        let response: { status: number; answer: ServerAnswer } | null = null;
        try {
          response = await sendWithTimeout(options, stop.signal, "PUT", `/api/migration/uploads/${uploadId}/chunk?offset=${start}`, chunk, "application/octet-stream", chunkTimeoutMilliseconds);
        } catch (networkError) {
          stop.signal.throwIfAborted();
          chunkBytes = Math.max(minimumChunkBytes, Math.floor(chunkBytes / 2));
          retryReason = describe(networkError);
        }
        if (response && response.status === 413) {
          // A reverse proxy in front of the server allows only small requests.
          if (length <= minimumChunkBytes) throw new Error(options.messages.uploadLimit());
          chunkCeiling = Math.min(chunkCeiling, Math.max(minimumChunkBytes, Math.floor(length / 2)));
          chunkBytes = Math.min(chunkBytes, chunkCeiling);
          queue.unshift(piece);
          continue;
        }
        if (response && isTemporaryFailure(response.status)) retryReason = response.answer.error ?? String(response.status);
        else if (response && response.status >= 300) throw new Error(options.messages.serverError(response.status, response.answer.error));
        if (retryReason === null) {
          ownFailures = 0;
          consecutiveFailures = 0;
          sentBytes += length;
          const bytesPerSecond = length / Math.max(0.05, (Date.now() - startedAt) / 1000);
          chunkBytes = Math.round(Math.max(minimumChunkBytes, Math.min(chunkCeiling, chunkBytes * 2, bytesPerSecond * targetChunkSeconds)));
          samples.push({ time: Date.now(), bytes: sentBytes });
          report(false);
          continue;
        }
        queue.unshift(piece);
      } finally {
        piecesUnderway -= 1;
      }
      ownFailures += 1;
      consecutiveFailures += 1;
      if (consecutiveFailures > failuresPerUpload * options.parallelUploads) throw new Error(options.messages.connectionLost(retryReason));
      // One piece failing among successful ones is not worth a message.
      if (consecutiveFailures >= options.parallelUploads) report(true);
      await pause(Math.min(30_000, 1000 * 2 ** Math.min(ownFailures - 1, 5)), stop.signal);
      // The measured speed no longer holds after a pause.
      if (consecutiveFailures >= options.parallelUploads) samples = [{ time: Date.now(), bytes: sentBytes }];
    }
  };

  report(false);
  try {
    await Promise.allSettled(
      Array.from({ length: options.parallelUploads }, () =>
        uploadNext().catch((uploadError: unknown) => {
          failure ??= uploadError;
          stop.abort(uploadError);
        }),
      ),
    );
  } finally {
    options.signal.removeEventListener("abort", stopWithCaller);
  }
  options.signal.throwIfAborted();
  if (failure) throw failure;
}

/** Starts unpacking and follows the receiver until the workspace is in place. */
async function applyUpload(options: TransferOptions, uploadId: string): Promise<{ restartRequired: boolean; warning: string | null }> {
  const route = `/api/migration/uploads/${uploadId}`;
  const progress = (phase: "unpacking" | "restarting") => options.onProgress({ phase, sentBytes: options.totalBytes, totalBytes: options.totalBytes, remainingSeconds: null, reconnecting: false });
  progress("unpacking");
  let failures = 0;
  for (;;) {
    let response: { status: number; answer: ServerAnswer } | null = null;
    try {
      response = await sendWithTimeout(options, options.signal, "GET", route);
      // "receiving" with nothing missing: not started yet (or the receiver restarted while unpacking).
      if (response.status < 300 && response.answer.state === "receiving" && !missingRanges(response.answer.ranges ?? [], options.totalBytes).length) {
        response = null;
        response = await sendWithTimeout(options, options.signal, "POST", `${route}/complete`);
      }
    } catch {
      options.signal.throwIfAborted();
    }
    const answer = response?.answer;
    if (response && response.status < 300 && answer?.state === "receiving") {
      const missing = missingRanges(answer.ranges ?? [], options.totalBytes);
      if (missing.length) {
        await uploadRanges(options, uploadId, missing);
        progress("unpacking");
        continue;
      }
    }
    if (!response || isTemporaryFailure(response.status) || (response.status < 300 && !answer?.state)) {
      failures += 1;
      if (failures > maximumStatusFailures) throw new Error(options.messages.notResponding());
      progress("restarting");
    } else if (response.status >= 300) {
      throw new Error(options.messages.serverError(response.status, answer?.error));
    } else {
      failures = 0;
      if (answer?.state === "applied") return { restartRequired: false, warning: answer.warning ?? null };
      if (answer?.state === "restartRequired") return { restartRequired: true, warning: null };
      if (answer?.state === "failed") throw new Error(options.messages.serverError(response.status, answer.error));
      progress(answer?.state === "restarting" ? "restarting" : "unpacking");
    }
    await pause(statusPollMilliseconds, options.signal);
  }
}

export async function transferArchive(options: TransferOptions): Promise<{ restartRequired: boolean; warning: string | null }> {
  const uploadId = await createUpload(options);
  await uploadRanges(options, uploadId, [[0, options.totalBytes]]);
  return applyUpload(options, uploadId);
}
