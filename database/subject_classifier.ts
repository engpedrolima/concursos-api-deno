export const CLASSIFICATION_RULESET_VERSION = "1.1.0";

export const SUBJECT_TAXONOMY = [
  "Direito Administrativo",
  "Direito Constitucional",
  "Direito Penal",
  "Processo Penal",
  "Direito Civil",
  "Processo Civil",
  "Direito Previdenciário",
  "Direito do Trabalho",
  "Processo do Trabalho",
  "Direito Tributário",
  "Direito Empresarial",
  "Direitos Humanos",
  "Atualidades",
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
  minimumScore?: number;
}

/** Termos genéricos que nunca podem constituir uma regra isolada. */
export const FORBIDDEN_ISOLATED_CLASSIFICATION_TERMS = [
  "empresa",
  "STF",
  "prescrição",
  "imigração",
  "migração",
  "integridade física",
  "dispositivo",
  "configuração",
  "informação",
] as const;

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
        "contratos administrativos",
        "cadastro de inadimplentes",
        "improbidade administrativa",
        "licitação",
        "poder de polícia",
        "processo administrativo",
        "rdc",
        "regime diferenciado de contratações",
        "responsabilidade civil do estado",
        "serviço público",
        "tribunal de contas da união",
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
        "norma constitucional",
        "poder constituinte",
        "ação direta de inconstitucionalidade",
        "mandado de injunção",
        "supremo tribunal federal",
      ], 3),
      ...terms([
        "cargos públicos",
        "conselho nacional de justiça",
        "emenda constitucional",
        "competência legislativa",
        "inconstitucional lei estadual",
        "livre manifestação do pensamento",
        "poder executivo",
        "poder legislativo",
        "presidente da república",
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
        "disposição do próprio corpo",
        "inadimplemento contratual",
        "negócio jurídico",
        "responsabilidade civil",
        "direitos reais",
        "sucessão hereditária",
      ], 3),
      ...terms([
        "bem de família",
        "caso fortuito",
        "contrato de locação",
        "fiador",
        "força maior",
        "obrigação civil",
        "pessoa jurídica",
        "propriedade",
        "posse",
        "titular a pretensão",
        "decadência",
      ]),
    ],
  },
  {
    subject: "Processo Civil",
    terms: [
      ...terms([
        "ações de despejo",
        "código de processo civil",
        "cumprir a sentença",
        "processo civil",
        "tutela provisória",
        "coisa julgada",
        "cumprimento de sentença",
        "petição inicial",
      ], 3),
      ...terms([
        "agravo de instrumento",
        "apelação",
        "cpc",
        "curadora especial",
        "intimação do devedor",
        "litisconsórcio",
        "oportunidade de se manifestar",
        "procedimentos judiciais",
        "execução civil",
        "recurso especial",
      ]),
    ],
  },
  {
    subject: "Direito Previdenciário",
    minimumScore: 3,
    terms: [
      ...terms([
        "auxílio acidente",
        "regime geral de previdência social",
        "regime próprio de previdência social",
        "segurado obrigatório",
      ], 4),
      ...terms([
        "carência previdenciária",
        "compensação previdenciária",
        "contribuições mensais",
        "previdência social",
        "rgps",
      ], 3),
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
    minimumScore: 3,
    terms: [
      ...terms([
        "agravo de petição",
        "empresa reclamada",
        "garantia do juízo",
        "juiz trabalhista",
        "justiça do trabalho",
        "processo do trabalho",
        "reclamação trabalhista",
        "recurso ordinário trabalhista",
        "tribunal regional do trabalho",
        "execução trabalhista",
      ], 3),
      ...terms([
        "audiência trabalhista",
        "custos legis",
        "dissídio coletivo",
        "competência trabalhista",
        "reclamado",
        "remessa de ofício",
        "revelia",
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
    minimumScore: 3,
    terms: [
      ...terms([
        "sociedade empresária",
        "recuperação judicial",
        "título de crédito",
        "estabelecimento empresarial",
        "sociedade anônima",
        "falência empresarial",
      ], 3),
      ...terms([
        "falência",
        "cheque",
        "duplicata",
      ], 3),
    ],
  },
  {
    subject: "Direitos Humanos",
    terms: [
      ...terms([
        "direitos humanos",
        "integridade física dos presos",
        "morte do detento",
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
    subject: "Atualidades",
    minimumScore: 3,
    terms: [
      ...terms([
        "emmanuel macron",
        "jean luc mélenchon",
        "marine le pen",
        "nicolás maduro",
        "primeiro turno das eleições",
        "sociedade francesa atual",
        "venezuelanos",
        "venezuela",
      ], 4),
    ],
  },
  {
    subject: "Língua Portuguesa",
    terms: [
      ...terms([
        "acentuação gráfica",
        "coerência textual",
        "correção gramatical",
        "forma verbal",
        "interpretação do texto",
        "leitura do texto",
        "modo subjuntivo",
        "período do texto",
        "redação oficial",
        "sentido do texto",
        "sua senhoria",
        "concordância verbal",
        "concordância nominal",
        "regência verbal",
      ], 5),
      ...terms([
        "crase",
        "memorando",
        "ortografia",
        "pontuação",
        "pronome",
        "próclise",
        "reescrito",
        "tipologia textual",
        "valor comparativo",
        "vocábulo",
        "oração subordinada",
        "partícula se",
        "coesão textual",
        "tipologia",
      ], 3),
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
        "célula selecionada",
        "compartilhar o chrome",
        "engenharia social",
        "google chrome",
        "navegação anônima",
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
    minimumScore: 3,
    terms: [
      ...terms([
        "código de ética odontológica",
        "conselho federal de odontologia",
        "conselho nacional de odontologia",
        "conselho regional de odontologia",
        "exercício da odontologia",
        "penalidade de cassação",
        "resolução cfo",
        "técnico em prótese dentária",
        "técnicos em prótese dentária",
        "técnico em saúde bucal",
        "técnicos em saúde bucal",
        "lei maria da penha",
        "estatuto da criança e do adolescente",
        "estatuto do idoso",
        "lei de drogas",
        "lavagem de dinheiro",
        "organização criminosa",
        "abuso de autoridade",
      ], 4),
      ...terms([
        "cfo",
        "cirurgião dentista",
        "especialidades na área da odontologia",
        "estagiário de odontologia",
        "exercício profissional",
        "infração ética",
        "legislação especial",
        "prontuário do paciente",
        "estatuto do desarmamento",
        "execução penal",
      ], 3),
      ...terms([
        "anualidade",
        "inscrição secundária",
      ], 2),
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

const forbiddenIsolatedTerms = new Set(
  FORBIDDEN_ISOLATED_CLASSIFICATION_TERMS.map(normalizeClassificationText),
);
for (const rule of RULES) {
  for (const term of rule.terms) {
    if (forbiddenIsolatedTerms.has(normalizeClassificationText(term.term))) {
      throw new Error(
        `Regra inválida: termo genérico isolado não permitido: ${term.term}.`,
      );
    }
  }
}

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
    const score = matched.reduce((total, term) => total + term.weight, 0);
    if (score < (rule.minimumScore ?? 1)) continue;
    scores.push({
      subject: rule.subject,
      score,
      matchedTerms: matched.map((term) => term.term),
    });
  }
  const previdenciario = scores.some((score) =>
    score.subject === "Direito Previdenciário"
  );
  if (previdenciario) {
    const trabalho = scores.findIndex((score) =>
      score.subject === "Direito do Trabalho"
    );
    if (trabalho >= 0) scores.splice(trabalho, 1);
  }
  scores.sort((left, right) => {
    const score = right.score - left.score;
    if (score !== 0) return score;
    return SUBJECT_TAXONOMY.indexOf(left.subject) -
      SUBJECT_TAXONOMY.indexOf(right.subject);
  });
  const portuguese = scores.findIndex((score) =>
    score.subject === "Língua Portuguesa" && score.score >= 5
  );
  if (portuguese > 0) scores.unshift(...scores.splice(portuguese, 1));
  const winner = scores[0];
  return {
    rulesetVersion: CLASSIFICATION_RULESET_VERSION,
    subject: winner?.subject ?? "Sem classificação",
    score: winner?.score ?? 0,
    matchedTerms: winner?.matchedTerms ?? [],
    scores,
  };
}
