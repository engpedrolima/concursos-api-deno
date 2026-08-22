export const CLASSIFICATION_RULESET_VERSION = "1.0.0";

export const SUBJECT_TAXONOMY = [
  "Direito Administrativo",
  "Direito Constitucional",
  "Direito Penal",
  "Processo Penal",
  "Direito Civil",
  "Processo Civil",
  "Direito do Trabalho",
  "Processo do Trabalho",
  "Direito Tributário",
  "Direito Empresarial",
  "Direitos Humanos",
  "Língua Portuguesa",
  "Raciocínio Lógico",
  "Informática",
  "Legislação Especial",
  "Sem classificação",
] as const;

export type ClassifiedSubject = (typeof SUBJECT_TAXONOMY)[number];

export interface ClassificationAlternative {
  label: string;
  text: string;
}

export interface SubjectClassificationInput {
  statement: string;
  alternatives: readonly ClassificationAlternative[];
}

interface WeightedTerm {
  term: string;
  weight: number;
}

interface SubjectRule {
  subject: Exclude<ClassifiedSubject, "Sem classificação">;
  terms: readonly WeightedTerm[];
}

export interface SubjectScore {
  subject: Exclude<ClassifiedSubject, "Sem classificação">;
  score: number;
  matchedTerms: string[];
}

export interface SubjectClassificationResult {
  rulesetVersion: string;
  subject: ClassifiedSubject;
  score: number;
  matchedTerms: string[];
  scores: SubjectScore[];
}

const terms = (
  phrases: readonly string[],
  weight = 2,
): WeightedTerm[] => phrases.map((term) => ({ term, weight }));

const RULES: readonly SubjectRule[] = [
  {
    subject: "Direito Administrativo",
    terms: [
      ...terms([
        "ato administrativo",
        "administração pública",
        "contrato administrativo",
        "improbidade administrativa",
        "licitação",
        "poder de polícia",
        "processo administrativo",
        "responsabilidade civil do estado",
        "serviço público",
      ], 3),
      ...terms([
        "autarquia",
        "desapropriação",
        "servidor público",
        "agente público",
        "bens públicos",
      ]),
    ],
  },
  {
    subject: "Direito Constitucional",
    terms: [
      ...terms([
        "constituição federal",
        "controle de constitucionalidade",
        "direitos fundamentais",
        "poder constituinte",
        "ação direta de inconstitucionalidade",
        "mandado de injunção",
        "supremo tribunal federal",
      ], 3),
      ...terms([
        "emenda constitucional",
        "competência legislativa",
        "separação dos poderes",
        "remédio constitucional",
      ]),
    ],
  },
  {
    subject: "Direito Penal",
    terms: [
      ...terms([
        "código penal",
        "concurso de pessoas",
        "prescrição penal",
        "tipicidade",
        "culpabilidade",
      ], 3),
      ...terms([
        "crime",
        "dolo",
        "homicídio",
        "furto",
        "roubo",
        "pena privativa",
      ]),
    ],
  },
  {
    subject: "Processo Penal",
    terms: [
      ...terms([
        "código de processo penal",
        "inquérito policial",
        "ação penal",
        "prisão preventiva",
        "prova ilícita",
        "queixa crime",
      ], 3),
      ...terms([
        "denúncia criminal",
        "audiência de custódia",
        "competência criminal",
        "habeas corpus",
      ]),
    ],
  },
  {
    subject: "Direito Civil",
    terms: [
      ...terms([
        "código civil",
        "negócio jurídico",
        "responsabilidade civil",
        "direitos reais",
        "sucessão hereditária",
      ], 3),
      ...terms([
        "obrigação civil",
        "pessoa jurídica",
        "propriedade",
        "posse",
        "decadência",
      ]),
    ],
  },
  {
    subject: "Processo Civil",
    terms: [
      ...terms([
        "código de processo civil",
        "tutela provisória",
        "coisa julgada",
        "cumprimento de sentença",
        "petição inicial",
      ], 3),
      ...terms([
        "agravo de instrumento",
        "apelação",
        "litisconsórcio",
        "execução civil",
        "recurso especial",
      ]),
    ],
  },
  {
    subject: "Direito do Trabalho",
    terms: [
      ...terms([
        "relação de emprego",
        "contrato de trabalho",
        "consolidação das leis do trabalho",
        "jornada de trabalho",
      ], 3),
      ...terms([
        "empregado",
        "empregador",
        "salário",
        "férias",
        "fgts",
        "rescisão trabalhista",
      ]),
    ],
  },
  {
    subject: "Processo do Trabalho",
    terms: [
      ...terms([
        "justiça do trabalho",
        "reclamação trabalhista",
        "recurso ordinário trabalhista",
        "tribunal regional do trabalho",
        "execução trabalhista",
      ], 3),
      ...terms([
        "audiência trabalhista",
        "dissídio coletivo",
        "competência trabalhista",
      ]),
    ],
  },
  {
    subject: "Direito Tributário",
    terms: [
      ...terms([
        "código tributário nacional",
        "crédito tributário",
        "lançamento tributário",
        "imunidade tributária",
        "obrigação tributária",
      ], 3),
      ...terms([
        "tributo",
        "imposto",
        "isenção",
        "icms",
        "iptu",
        "iss",
      ]),
    ],
  },
  {
    subject: "Direito Empresarial",
    terms: [
      ...terms([
        "sociedade empresária",
        "recuperação judicial",
        "título de crédito",
        "estabelecimento empresarial",
        "sociedade anônima",
      ], 3),
      ...terms([
        "empresário",
        "falência",
        "cheque",
        "duplicata",
      ]),
    ],
  },
  {
    subject: "Direitos Humanos",
    terms: [
      ...terms([
        "direitos humanos",
        "sistema interamericano",
        "corte interamericana",
        "convenção americana de direitos humanos",
        "tratado internacional de direitos humanos",
      ], 3),
      ...terms([
        "dignidade da pessoa humana",
        "comissão interamericana",
      ]),
    ],
  },
  {
    subject: "Língua Portuguesa",
    terms: [
      ...terms([
        "interpretação do texto",
        "sentido do texto",
        "concordância verbal",
        "concordância nominal",
        "regência verbal",
      ], 3),
      ...terms([
        "crase",
        "ortografia",
        "pontuação",
        "pronome",
        "oração subordinada",
        "coesão textual",
      ]),
    ],
  },
  {
    subject: "Raciocínio Lógico",
    terms: [
      ...terms([
        "raciocínio lógico",
        "tabela verdade",
        "equivalência lógica",
        "proposição lógica",
      ], 3),
      ...terms([
        "probabilidade",
        "porcentagem",
        "sequência numérica",
        "conjunto",
      ]),
    ],
  },
  {
    subject: "Informática",
    terms: [
      ...terms([
        "segurança da informação",
        "correio eletrônico",
        "sistema operacional",
        "computador",
      ], 3),
      ...terms([
        "software",
        "hardware",
        "internet",
        "windows",
        "linux",
        "excel",
        "navegador web",
      ]),
    ],
  },
  {
    subject: "Legislação Especial",
    terms: [
      ...terms([
        "lei maria da penha",
        "estatuto da criança e do adolescente",
        "estatuto do idoso",
        "lei de drogas",
        "lavagem de dinheiro",
        "organização criminosa",
        "abuso de autoridade",
      ], 4),
      ...terms([
        "legislação especial",
        "estatuto do desarmamento",
        "execução penal",
      ], 3),
    ],
  },
];

export function normalizeClassificationText(value: string): string {
  return value.normalize("NFD").replace(/\p{M}+/gu, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

const containsTerm = (text: string, term: string): boolean =>
  ` ${text} `.includes(` ${normalizeClassificationText(term)} `);

export function classifyQuestionSubject(
  input: SubjectClassificationInput,
): SubjectClassificationResult {
  const alternativeText = [...input.alternatives]
    .sort((left, right) => left.label.localeCompare(right.label, "pt-BR"))
    .map((alternative) => alternative.text);
  const normalizedText = normalizeClassificationText(
    [input.statement, ...alternativeText].join(" "),
  );
  const scores: SubjectScore[] = [];
  for (const rule of RULES) {
    const matched = rule.terms.filter((term) =>
      containsTerm(normalizedText, term.term)
    );
    if (matched.length === 0) continue;
    scores.push({
      subject: rule.subject,
      score: matched.reduce((total, term) => total + term.weight, 0),
      matchedTerms: matched.map((term) => term.term),
    });
  }
  scores.sort((left, right) => {
    const score = right.score - left.score;
    if (score !== 0) return score;
    return SUBJECT_TAXONOMY.indexOf(left.subject) -
      SUBJECT_TAXONOMY.indexOf(right.subject);
  });
  const winner = scores[0];
  return {
    rulesetVersion: CLASSIFICATION_RULESET_VERSION,
    subject: winner?.subject ?? "Sem classificação",
    score: winner?.score ?? 0,
    matchedTerms: winner?.matchedTerms ?? [],
    scores,
  };
}
