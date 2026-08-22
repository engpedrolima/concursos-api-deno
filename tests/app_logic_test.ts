import {
  buildQuestionSearch,
  buildStatisticsSearch,
  createQuestionPager,
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
  assertEquals(questions.get("offset"), "0");

  const secondPage = new URLSearchParams(
    buildQuestionSearch(filters, { limit: 25, offset: 50 }),
  );
  assertEquals(secondPage.get("limit"), "25");
  assertEquals(secondPage.get("offset"), "50");

  const statistics = new URLSearchParams(buildStatisticsSearch(filters));
  assertEquals(statistics.get("organizer"), "Banca Alpha");
  assertEquals(statistics.has("deduplicate"), false);
  assertEquals(statistics.has("limit"), false);
});

Deno.test("paginação mantém total global e busca a próxima página sob demanda", async () => {
  const calls: Array<{ limit: number; offset: number }> = [];
  const pager = createQuestionPager({
    pageSize: 2,
    fetchPage: ({ limit, offset }: { limit: number; offset: number }) => {
      calls.push({ limit, offset });
      return Promise.resolve({
        total: 3,
        items: offset === 0
          ? [{ occurrenceId: 10 }, { occurrenceId: 11 }]
          : [{ occurrenceId: 12 }],
      });
    },
  });

  await pager.goTo(0);
  assertEquals(pager.snapshot().total, 3);
  assertEquals(pager.snapshot().counter, "1 de 3");
  assertEquals(calls, [{ limit: 2, offset: 0 }]);

  await pager.next();
  assertEquals(pager.snapshot().counter, "2 de 3");
  assertEquals(calls.length, 1);

  await pager.next();
  assertEquals(pager.snapshot().current, { occurrenceId: 12 });
  assertEquals(pager.snapshot().counter, "3 de 3");
  assertEquals(calls, [
    { limit: 2, offset: 0 },
    { limit: 2, offset: 2 },
  ]);

  await pager.previous();
  assertEquals(pager.snapshot().current, { occurrenceId: 11 });
  assertEquals(pager.snapshot().counter, "2 de 3");
  assertEquals(calls.length, 2);
});

Deno.test("aplicar filtros reinicia índice e cache de páginas", async () => {
  let filter = "inicial";
  const calls: Array<{ filter: string; offset: number }> = [];
  const pager = createQuestionPager({
    pageSize: 2,
    fetchPage: ({ offset }: { offset: number }) => {
      calls.push({ filter, offset });
      return Promise.resolve({
        total: 4,
        items: [{ occurrenceId: offset + 1 }, { occurrenceId: offset + 2 }],
      });
    },
  });

  await pager.goTo(0);
  await pager.goTo(2);
  assertEquals(pager.snapshot().cachedPageCount, 2);

  filter = "novo";
  pager.reset();
  await pager.goTo(0);
  assertEquals(pager.snapshot().counter, "1 de 4");
  assertEquals(pager.snapshot().cachedPageCount, 1);
  assertEquals(calls, [
    { filter: "inicial", offset: 0 },
    { filter: "inicial", offset: 2 },
    { filter: "novo", offset: 0 },
  ]);
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
