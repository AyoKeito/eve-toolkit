// unbzip2-stream ships no types and has no @types package. It exports a single
// factory returning a Transform stream that bzip2-decompresses piped bytes.
declare module "unbzip2-stream" {
  import type { Transform } from "node:stream";
  export default function unbzip2Stream(): Transform;
}
