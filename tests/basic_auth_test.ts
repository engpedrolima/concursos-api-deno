import type { Database } from "../database/connection.ts";
import {
  ACCESS_PASSWORD_ENV,
  ACCESS_USER_ENV,
  createHandler,
  readAccessCredentials,
} from "../main.ts";

const assertEquals = (actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Esperado ${JSON.stringify(expected)}, recebido ${
        JSON.stringify(actual)
      }`,
    );
  }
};

const credentials = {
  user: "usuario-sintetico",
  password: "credencial-sintetica",
};

function authorizationHeader(user: string, password: string): string {
  const bytes = new TextEncoder().encode(`${user}:${password}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

Deno.test("autenticacao so e ativada com as duas variaveis definidas", () => {
  const readFrom = (values: Record<string, string>) => (name: string) =>
    values[name];

  assertEquals(readAccessCredentials(readFrom({})), null);
  assertEquals(
    readAccessCredentials(readFrom({ [ACCESS_USER_ENV]: credentials.user })),
    null,
  );
  assertEquals(
    readAccessCredentials(
      readFrom({ [ACCESS_PASSWORD_ENV]: credentials.password }),
    ),
    null,
  );
  assertEquals(
    readAccessCredentials(
      readFrom({
        [ACCESS_USER_ENV]: credentials.user,
        [ACCESS_PASSWORD_ENV]: credentials.password,
      }),
    ),
    credentials,
  );
});

Deno.test("handler permanece aberto quando a protecao nao esta configurada", async () => {
  const handler = createHandler();

  const appResponse = await handler(new Request("http://localhost/app/"));
  assertEquals(appResponse.status, 200);

  const apiResponse = await handler(
    new Request("http://localhost/api/rota-inexistente"),
  );
  assertEquals(apiResponse.status, 404);
  assertEquals(apiResponse.headers.get("www-authenticate"), null);
});

Deno.test("rotas protegidas exigem credenciais validas", async () => {
  const handler = createHandler({ accessCredentials: credentials });

  for (const path of ["/app/", "/app/app.js", "/api/questions"]) {
    const response = await handler(new Request(`http://localhost${path}`));
    assertEquals(response.status, 401);
    assertEquals(
      response.headers.get("www-authenticate"),
      'Basic realm="concursos-api-deno", charset="UTF-8"',
    );
  }

  const invalidResponse = await handler(
    new Request("http://localhost/api/questions", {
      headers: {
        authorization: authorizationHeader(credentials.user, "incorreta"),
      },
    }),
  );
  assertEquals(invalidResponse.status, 401);

  const healthResponse = await handler(new Request("http://localhost/"));
  assertEquals(healthResponse.status, 200);
});

Deno.test("credenciais validas autorizam interface e API", async () => {
  const database = { close() {} } as unknown as Database;
  const handler = createHandler({
    accessCredentials: credentials,
    dependencies: {
      openDatabase: () => database,
      migrate: () => {},
      listQuestions: (_database, filters) => ({
        items: [],
        total: 0,
        limit: filters?.limit ?? 25,
        offset: filters?.offset ?? 0,
      }),
    },
  });
  const authorization = authorizationHeader(
    credentials.user,
    credentials.password,
  );

  const appResponse = await handler(
    new Request("http://localhost/app/", {
      headers: { authorization },
    }),
  );
  assertEquals(appResponse.status, 200);

  const apiResponse = await handler(
    new Request("http://localhost/api/questions", {
      headers: { authorization },
    }),
  );
  assertEquals(apiResponse.status, 200);
  assertEquals(await apiResponse.json(), {
    items: [],
    total: 0,
    limit: 25,
    offset: 0,
  });
});
