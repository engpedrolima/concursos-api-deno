import { handler } from "../main.ts";

const assertEquals = (actual: unknown, expected: unknown) => {
  if (actual !== expected) {
    throw new Error(
      `Esperado ${JSON.stringify(expected)}, recebido ${
        JSON.stringify(actual)
      }`,
    );
  }
};

Deno.test("a rota de saúde retorna serviço saudável", async () => {
  const response = await handler(new Request("http://localhost/"));
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.status, "ok");
  assertEquals(body.service, "concursos-api-deno");
});

Deno.test("uma rota inexistente retorna 404", async () => {
  const response = await handler(new Request("http://localhost/inexistente"));
  assertEquals(response.status, 404);
  const body = await response.json();
  assertEquals(body.error, "Rota não encontrada.");
});
