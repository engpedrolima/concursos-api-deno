import {
  CLASSIFICATION_RULESET_VERSION,
  classifyQuestionSubject,
  normalizeClassificationText,
} from "../database/subject_classifier.ts";

const assertEquals = (actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Esperado ${JSON.stringify(expected)}, recebido ${
        JSON.stringify(actual)
      }`,
    );
  }
};

Deno.test("classificador cobre a taxonomia jurídica e geral", () => {
  const cases = [
    [
      "A licitação e o contrato administrativo regem o serviço público.",
      "Direito Administrativo",
    ],
    [
      "O controle de constitucionalidade compete ao Supremo Tribunal Federal.",
      "Direito Constitucional",
    ],
    [
      "Segundo o Código Penal, a tipicidade integra a análise do crime.",
      "Direito Penal",
    ],
    ["O inquérito policial antecede a ação penal.", "Processo Penal"],
    ["O negócio jurídico é disciplinado pelo Código Civil.", "Direito Civil"],
    [
      "A tutela provisória consta do Código de Processo Civil.",
      "Processo Civil",
    ],
    [
      "A relação de emprego vincula empregado e empregador.",
      "Direito do Trabalho",
    ],
    [
      "A reclamação trabalhista tramita na Justiça do Trabalho.",
      "Processo do Trabalho",
    ],
    [
      "O crédito tributário decorre do lançamento tributário.",
      "Direito Tributário",
    ],
    [
      "A sociedade empresária pode requerer recuperação judicial.",
      "Direito Empresarial",
    ],
    [
      "A Corte Interamericana integra o sistema interamericano de direitos humanos.",
      "Direitos Humanos",
    ],
    [
      "Assinale a opção com concordância verbal e pontuação corretas.",
      "Língua Portuguesa",
    ],
    [
      "A tabela verdade demonstra a equivalência lógica das proposições.",
      "Raciocínio Lógico",
    ],
    ["O sistema operacional Linux é um software de computador.", "Informática"],
    [
      "A Lei Maria da Penha integra a legislação especial.",
      "Legislação Especial",
    ],
  ] as const;
  for (const [statement, expected] of cases) {
    const result = classifyQuestionSubject({ statement, alternatives: [] });
    assertEquals(result.subject, expected);
    assertEquals(result.score > 0, true);
    assertEquals(result.matchedTerms.length > 0, true);
    assertEquals(result.rulesetVersion, CLASSIFICATION_RULESET_VERSION);
  }
});

Deno.test("classificador usa alternativas, desempate estável e fallback", () => {
  const fromAlternative = classifyQuestionSubject({
    statement: "Assinale a alternativa correta.",
    alternatives: [
      { label: "B", text: "O crédito tributário depende de lançamento." },
      { label: "A", text: "Texto neutro." },
    ],
  });
  assertEquals(fromAlternative.subject, "Direito Tributário");

  const tie = classifyQuestionSubject({
    statement: "Constituição Federal e Código Penal.",
    alternatives: [],
  });
  assertEquals(tie.subject, "Direito Constitucional");
  assertEquals(tie.scores.map((score) => score.score), [3, 3]);

  assertEquals(
    classifyQuestionSubject({
      statement: "Enunciado sem vocabulário classificável.",
      alternatives: [],
    }).subject,
    "Sem classificação",
  );
  assertEquals(
    normalizeClassificationText("  Crédito TRIBUTÁRIO! "),
    "credito tributario",
  );
});
