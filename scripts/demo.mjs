import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Standalone simulation: does not import the relay, read .env, or expose /connect.
export function createDemo() {
  const files = new Map([
    ["/", ["demo.html", "text/html"]], ["/demo", ["demo.html", "text/html"]],
    ["/demo.mjs", ["demo.mjs", "text/javascript"]], ["/demo.css", ["demo.css", "text/css"]],
  ]);
  return createServer(async (request, response) => {
    const file = files.get(new URL(request.url, "http://localhost").pathname);
    const headers = { "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" };
    if (!file || request.method !== "GET") { response.writeHead(404, headers); response.end(); return; }
    try {
      const content = await readFile(new URL("../apps/relay/public/" + file[0], import.meta.url));
      response.writeHead(200, { ...headers, "Content-Type": file[1] }); response.end(content);
    } catch { response.writeHead(503, headers); response.end(); }
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const server = createDemo();
  server.listen(Number(process.env.PORT || 4173), process.env.HOST || "127.0.0.1", () => console.log("Long Cable simulated demo: http://127.0.0.1:" + server.address().port));
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close());
}
