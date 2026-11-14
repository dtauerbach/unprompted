// The HTTP method of a request for the approval page, as the proxy saw it
// (src/proxy.ts). A page can't read its own request's method, and the
// approval page skips itself for a trusted app only on a GET. The proxy
// always sets this header, over any the client sent, so a page that finds it
// missing wasn't reached through the proxy and treats the method as unknown.
export const METHOD_HEADER = "x-unprompted-method";

export function withMethod(req: Request): Headers {
  const h = new Headers(req.headers);
  h.set(METHOD_HEADER, req.method);
  return h;
}
