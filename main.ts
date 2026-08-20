const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

/** API mínima, exportada para testes sem abrir porta de rede. */
export function handler(request: Request): Response {
  const path = new URL(request.url).pathname;
  if (path === "/") {
    return jsonResponse({
      service: "concursos-api-deno",
      status: "ok",
      imports:
        "Use `deno task import -- --help`. Apenas PDFs públicos de cadernos e gabaritos definitivos em domínios oficiais são aceitos.",
    });
  }
  return jsonResponse({ error: "Rota não encontrada." }, 404);
}

if (import.meta.main) {
  Deno.serve({ port: 8000 }, handler);
}
