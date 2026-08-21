import {
  buildQuestionSearch,
  buildStatisticsSearch,
  feedbackPresentation,
  formatPercent,
  setText,
  studyStateMessage,
} from "../public/app.js";

const assertEquals = (actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Esperado ${JSON.stringify(expected)}, recebido ${
        JSON.stringify(actual)
      }`,
    );
  }
};

Deno.test("lógica da UI monta filtros de questões e estatísticas", () => {
  const filters = {
    organizer: " Banca Alpha ",
    year: "2026",
    role: "Analista",
    subject: "Direito",
    kind: "certo-errado",
    deduplicate: true,
  };
  const questions = new URLSearchParams(buildQuestionSearch(filters));
  assertEquals(questions.get("organizer"), "Banca Alpha");
  assertEquals(questions.get("year"), "2026");
  assertEquals(questions.get("role"), "Analista");
  assertEquals(questions.get("subject"), "Direito");
  assertEquals(questions.get("kind"), "certo-errado");
  assertEquals(questions.get("deduplicate"), "true");
  assertEquals(questions.get("limit"), "100");

  const statistics = new URLSearchParams(buildStatisticsSearch(filters));
  assertEquals(statistics.get("organizer"), "Banca Alpha");
  assertEquals(statistics.has("deduplicate"), false);
  assertEquals(statistics.has("limit"), false);
});

Deno.test("feedback puro diferencia resposta correta e incorreta", () => {
  assertEquals(feedbackPresentation("B", "B"), {
    isCorrect: true,
    heading: "Correto",
    message: "Correto. Gabarito: B.",
  });
  assertEquals(feedbackPresentation("A", "B"), {
    isCorrect: false,
    heading: "Incorreto",
    message: "Incorreto. Gabarito: B.",
  });
  assertEquals(formatPercent(66.67), "66,67%");
});

Deno.test("estados principais têm mensagens seguras e acionáveis", () => {
  assertEquals(
    studyStateMessage({ loading: true, total: 0 }),
    "Carregando questões…",
  );
  assertEquals(
    studyStateMessage({ error: true, total: 0 }),
    "Não foi possível carregar os dados. Verifique se o servidor local está disponível.",
  );
  assertEquals(
    studyStateMessage({ total: 0 }),
    "Nenhuma questão encontrada. Gere um artefato e importe-o com deno task db:import antes de estudar.",
  );
  assertEquals(studyStateMessage({ total: 2 }), "");
});

Deno.test("dados potencialmente maliciosos são atribuídos somente como texto", async () => {
  const target = {
    textContent: "",
    innerHTML: "sentinela",
  };
  const malicious = '<img src=x onerror="globalThis.compromised=true">';
  setText(target, malicious);
  assertEquals(target.textContent, malicious);
  assertEquals(target.innerHTML, "sentinela");
  assertEquals(
    (globalThis as unknown as Record<string, unknown>).compromised,
    undefined,
  );

  const source = await Deno.readTextFile(
    new URL("../public/app.js", import.meta.url),
  );
  assertEquals(source.includes("textContent"), true);
  assertEquals(source.includes("innerHTML"), false);
});
