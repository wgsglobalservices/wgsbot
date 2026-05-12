import { AppError } from "./errors";

export async function readTextWithLimit(request: Request, maxBytes: number, code = "PAYLOAD_TOO_LARGE"): Promise<string> {
  return new TextDecoder().decode(await readBodyWithLimit(request.body, maxBytes, code));
}

export async function readStreamTextWithLimit(stream: ReadableStream<Uint8Array>, maxBytes: number, code = "PAYLOAD_TOO_LARGE"): Promise<string> {
  return new TextDecoder().decode(await readBodyWithLimit(stream, maxBytes, code));
}

export async function readBodyWithLimit(
  stream: ReadableStream<Uint8Array> | null,
  maxBytes: number,
  code = "PAYLOAD_TOO_LARGE"
): Promise<Uint8Array> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new AppError(code, `Request body exceeds ${maxBytes} bytes.`, 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export function limitReadableStream(stream: ReadableStream<Uint8Array> | null, maxBytes: number): ReadableStream<Uint8Array> | null {
  if (!stream) return null;
  let total = 0;
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength;
        if (total > maxBytes) {
          controller.error(new AppError("PAYLOAD_TOO_LARGE", `Request body exceeds ${maxBytes} bytes.`, 413));
          return;
        }
        controller.enqueue(chunk);
      }
    })
  );
}
