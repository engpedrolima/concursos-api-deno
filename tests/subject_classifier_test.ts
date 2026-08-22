import {
  CLASSIFICATION_RULESET_VERSION,
  classifyQuestionSubject,
  FORBIDDEN_ISOLATED_CLASSIFICATION_TERMS,
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
  assertEquals(CLASSIFICATION_RULESET_VERSION, "1.1.0");
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
      "O segurado obrigatório integra o Regime Geral de Previdência Social.",
      "Direito Previdenciário",
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
      "Nicolás Maduro governa a Venezuela em meio à crise política.",
      "Atualidades",
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

Deno.test("termos genéricos isolados não classificam questões", () => {
  for (const term of FORBIDDEN_ISOLATED_CLASSIFICATION_TERMS) {
    const result = classifyQuestionSubject({
      statement: `O enunciado menciona apenas ${term}.`,
      alternatives: [],
    });
    assertEquals(result.subject, "Sem classificação");
  }

  assertEquals(
    classifyQuestionSubject({
      statement: "A empresa foi contratada para executar o serviço.",
      alternatives: [],
    }).subject,
    "Sem classificação",
  );
  assertEquals(
    classifyQuestionSubject({
      statement: "A sociedade empresária requereu recuperação judicial.",
      alternatives: [],
    }).subject,
    "Direito Empresarial",
  );
});

Deno.test("previdenciário prevalece sobre vocabulário trabalhista", () => {
  const result = classifyQuestionSubject({
    statement:
      "O empregado com relação de emprego é segurado obrigatório do RGPS.",
    alternatives: [],
  });
  assertEquals(result.subject, "Direito Previdenciário");
  assertEquals(
    result.scores.some((score) => score.subject === "Direito do Trabalho"),
    false,
  );
});

Deno.test("marcadores metalinguísticos priorizam Língua Portuguesa", () => {
  const result = classifyQuestionSubject({
    statement:
      "A correção gramatical do período sobre o Conselho Federal de Odontologia seria preservada.",
    alternatives: [],
  });
  assertEquals(result.subject, "Língua Portuguesa");
});

Deno.test("ruleset 1.1.0 cobre lacunas fortes do relatório", () => {
  const cases = [
    [
      "Solicito que Sua Senhoria encaminhes os materiais citados no memorando.",
      "Língua Portuguesa",
    ],
    [
      "É possível compartilhar o Chrome com outras pessoas no mesmo dispositivo.",
      "Informática",
    ],
    [
      "A inscrição secundária em outro conselho regional dispensa nova anualidade.",
      "Legislação Especial",
    ],
    [
      "Técnicos em prótese dentária não podem fazer publicidade.",
      "Legislação Especial",
    ],
    [
      "O juiz deve observar a oportunidade de as partes se manifestarem, conforme o CPC.",
      "Processo Civil",
    ],
    [
      "No processo civil, a falta de intimação pode gerar nulidade.",
      "Processo Civil",
    ],
    [
      "No âmbito do RDC, admite-se a contratação para execução concorrente.",
      "Direito Administrativo",
    ],
    [
      "Marine Le Pen participou do primeiro turno das eleições francesas.",
      "Atualidades",
    ],
    [
      "O auxílio-acidente independe de carência previdenciária.",
      "Direito Previdenciário",
    ],
  ] as const;

  for (const [statement, expected] of cases) {
    assertEquals(
      classifyQuestionSubject({ statement, alternatives: [] }).subject,
      expected,
    );
  }
});

Deno.test("Q41 e Q59 permanecem sem classificação por segurança", () => {
  const statements = [
    "A atuação da comissão de ética deve ser provocada privativamente pela autoridade competente de cada órgão.",
    "A portaria é o ato por meio do qual a presidência do conselho dispõe sobre matéria de sua competência.",
  ];
  for (const statement of statements) {
    assertEquals(
      classifyQuestionSubject({ statement, alternatives: [] }).subject,
      "Sem classificação",
    );
  }
});

Deno.test("Q80 Q85 e Q100 registram contaminação suspeita para auditoria", () => {
  const cases = [
    [
      "Compete ao Tribunal de Contas da União sustar contratos administrativos. A respeito do processo do trabalho, julgue os itens seguintes.",
      "Direito Administrativo",
    ],
    [
      "O próprio juiz trabalhista pode instaurar o incidente e da decisão cabe agravo de petição. Com relação à previdência social, julgue os itens seguintes.",
      "Processo do Trabalho",
    ],
    [
      "No inadimplemento contratual, o devedor responde por caso fortuito ou força maior. Com base em direito processual civil, julgue os itens seguintes.",
      "Direito Civil",
    ],
  ] as const;

  for (const [statement, expected] of cases) {
    assertEquals(
      classifyQuestionSubject({ statement, alternatives: [] }).subject,
      expected,
    );
  }
});
