import { handler } from "../main.ts";

const assertEquals = (actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Esperado ${JSON.stringify(expected)}, recebido ${
        JSON.stringify(actual)
      }`,
    );
  }
};

Deno.test("interface serve os quatro assets com content types corretos", async () => {
  const assets = [
    ["/app/", "text/html; charset=utf-8"],
    ["/app/index.html", "text/html; charset=utf-8"],
    ["/app/app.js", "text/javascript; charset=utf-8"],
    ["/app/styles.css", "text/css; charset=utf-8"],
  ] as const;
  for (const [path, contentType] of assets) {
    const response = await handler(new Request(`http://localhost${path}`));
    assertEquals(response.status, 200);
    assertEquals(response.headers.get("content-type"), contentType);
    assertEquals(response.headers.get("x-content-type-options"), "nosniff");
    assertEquals((await response.text()).length > 0, true);
  }
});

Deno.test("rota raiz permanece health check JSON", async () => {
  const response = await handler(new Request("http://localhost/"));
  assertEquals(response.status, 200);
  assertEquals(
    response.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
  const body = await response.json();
  assertEquals(body.status, "ok");
  assertEquals(body.service, "concursos-api-deno");
});

Deno.test("whitelist rejeita traversal e arquivos estáticos inexistentes", async () => {
  const paths = [
    "/app/not-found.js",
    "/app/../main.ts",
    "/app/%2e%2e/main.ts",
    "/app/..%2Fmain.ts",
    "/app/%2e%2e%2Fdatabase%2Fconnection.ts",
  ];
  for (const path of paths) {
    const response = await handler(new Request(`http://localhost${path}`));
    assertEquals(response.status, 404);
    assertEquals(
      response.headers.get("content-type"),
      "application/json; charset=utf-8",
    );
    assertEquals(await response.json(), { error: "Rota não encontrada." });
  }
});

Deno.test("asset conhecido rejeita método diferente de GET", async () => {
  const response = await handler(
    new Request("http://localhost/app/app.js", { method: "POST" }),
  );
  assertEquals(response.status, 405);
  assertEquals(response.headers.get("allow"), "GET");
  assertEquals(
    response.headers.get("content-type"),
    "application/json; charset=utf-8",
  );
});
