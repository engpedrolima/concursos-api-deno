import type { ExamIdentity } from "./types.ts";

type Answer = string | "ANULADA" | "AMBIGUA";

export interface ParsedQuestion {
  number: number;
  statement: string;
  alternatives: Record<string, string>;
  annulled: boolean;
  subject?: string;
}

export interface ParseDiagnostics {
  questionHeaders: number;
  multipleChoiceCandidates: number;
  certoErradoCandidates: number;
  bookletCharacters: number;
  answerKeyCharacters: number;
}

export class DuplicateQuestionNumberError extends Error {
  constructor(readonly duplicateNumbers: number[]) {
    super(`Números de questão duplicados: ${duplicateNumbers.join(", ")}.`);
    this.name = "DuplicateQuestionNumberError";
  }
}

const normalize = (value: string) =>
  value.replace(/\r/g, "").replace(/[ \t]+/g, " ").trim();

const labeledHeader =
  /(?:^|\n)\s*(?:QUEST(?:[A-Z\u00c0-\u024f]+)?|ITEM)\s*(\d+)\s*[-:.]?\s*/gim;

/** A prova discursiva não integra o caderno objetivo. */
function objectiveSection(text: string): string {
  const heading = /(?:^|[\n\f])\s*PROVA\s+DISCURSIVA\b/im.exec(text);
  return heading?.index === undefined ? text : text.slice(0, heading.index);
}

function toQuestion(
  number: number,
  body: string,
  certoErrado: boolean,
): ParsedQuestion {
  const alternativeMatches = [
    ...body.matchAll(
      /(?:^|\n)\s*([A-E])\s*[\)\.-]\s*([\s\S]*?)(?=(?:\n\s*[A-E]\s*[\)\.-])|$)/g,
    ),
  ];
  const firstAlternative = alternativeMatches[0]?.index ?? -1;
  const multipleChoiceAlternatives = Object.fromEntries(
    alternativeMatches.map((item) => [item[1], normalize(item[2])]),
  );
  const certo = /\bCERTO\b/i.exec(body);
  const errado = /\bERRADO\b/i.exec(body);
  const hasCertoErradoLabels = certo !== null && errado !== null;
  const isCertoErrado = Object.keys(multipleChoiceAlternatives).length < 2 &&
    (certoErrado || hasCertoErradoLabels);
  const firstCertoErrado = hasCertoErradoLabels
    ? Math.min(certo!.index, errado!.index)
    : -1;
  return {
    number,
    statement: normalize(
      firstAlternative >= 0
        ? body.slice(0, firstAlternative)
        : firstCertoErrado >= 0
        ? body.slice(0, firstCertoErrado)
        : body,
    ),
    alternatives: isCertoErrado
      ? { C: "Certo", E: "Errado" }
      : multipleChoiceAlternatives,
    annulled: /\b(?:ANULADA|ANULADO|NULA)\b/i.test(body),
  };
}

function parseLabeledQuestions(
  text: string,
  certoErradoNumbers: ReadonlySet<number>,
) {
  const headers = [...text.matchAll(labeledHeader)];
  return headers.map((header, index) => {
    const bodyStart = header.index! + header[0].length;
    const bodyEnd = index + 1 < headers.length
      ? headers[index + 1].index!
      : text.length;
    const number = Number(header[1]);
    return toQuestion(
      number,
      text.slice(bodyStart, bodyEnd),
      certoErradoNumbers.has(number),
    );
  });
}

/** Numeric Quadrix items are trusted only when the final answer key contains C/E. */
function parseNumericCertoErradoQuestions(
  text: string,
  certoErradoNumbers: ReadonlySet<number>,
): ParsedQuestion[] {
  if (certoErradoNumbers.size === 0) return [];
  const allNumericLines = [
    ...text.matchAll(/(?:^|\n)\s*(\d{1,4})(?=[ \t]+(\S[^\n]*))/g),
  ];
  const headers = allNumericLines.filter((match) =>
    certoErradoNumbers.has(Number(match[1])) &&
    /^\p{Lu}/u.test(match[2])
  );
  return headers.map((header, index) => {
    const bodyStart = header.index! + header[0].length;
    const bodyEnd = index + 1 < headers.length
      ? headers[index + 1].index!
      : text.length;
    return toQuestion(Number(header[1]), text.slice(bodyStart, bodyEnd), true);
  });
}

export function parseQuestionBooklet(
  text: string,
  answers: ReadonlyMap<number, Answer> = new Map(),
): ParsedQuestion[] {
  const objectiveText = objectiveSection(text);
  const certoErradoNumbers = new Set(
    [...answers].flatMap(([number, answer]) =>
      answer === "C" || answer === "E" ? [number] : []
    ),
  );
  const labeled = parseLabeledQuestions(objectiveText, certoErradoNumbers);
  const labeledNumbers = new Set(labeled.map((question) => question.number));
  // An annulled item has no C/E answer, but remains part of a C/E booklet and
  // must be recognized so it can be explicitly rejected instead of ignored.
  const numericNumbers = certoErradoNumbers.size > 0
    ? new Set(
      [...answers].filter(([, answer]) => answer !== "AMBIGUA").map((
        [number],
      ) => number),
    )
    : new Set<number>();
  const numeric = parseNumericCertoErradoQuestions(
    objectiveText,
    numericNumbers,
  )
    .filter((question) => !labeledNumbers.has(question.number));
  const questions = [...labeled, ...numeric].sort((left, right) =>
    left.number - right.number
  );
  const occurrences = new Map<number, number>();
  for (const question of questions) {
    occurrences.set(
      question.number,
      (occurrences.get(question.number) ?? 0) + 1,
    );
  }
  const duplicateNumbers = [...occurrences].flatMap(([number, count]) =>
    count > 1 ? [number] : []
  );
  if (duplicateNumbers.length > 0) {
    throw new DuplicateQuestionNumberError(duplicateNumbers);
  }
  return questions;
}

function canonical(value: string) {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toUpperCase();
}

function parseQuadrixTableAnswerKey(
  text: string,
  identity?: ExamIdentity,
): Map<number, Answer> {
  if (!identity?.role) return new Map();
  const role = canonical(identity.role);
  const lines = text.split(/(?<=\n)/);
  let sectionStart = 0;
  let foundRole = false;
  for (const line of lines) {
    if (canonical(line).includes(role)) {
      foundRole = true;
      break;
    }
    sectionStart += line.length;
  }
  if (!foundRole) return new Map();
  const nextPage = text.indexOf("\f", sectionStart + 1);
  const section = text.slice(
    sectionStart,
    nextPage < 0 ? text.length : nextPage,
  );
  const rows = section.split(/\r?\n/).map((row) => row.trim()).filter(Boolean);
  const answers = new Map<number, Answer>();
  for (let index = 0; index + 1 < rows.length; index++) {
    const numbers = rows[index].match(/^\d+(?:\s+\d+)+$/)?.[0].split(/\s+/).map(
      Number,
    );
    const values = rows[index + 1].match(/^[CE*](?:\s+[CE*])+$/i)?.[0].split(
      /\s+/,
    );
    if (!numbers || !values || numbers.length !== values.length) continue;
    numbers.forEach((number, valueIndex) => {
      answers.set(
        number,
        values[valueIndex] === "*"
          ? "ANULADA"
          : values[valueIndex].toUpperCase(),
      );
    });
    index++;
  }
  return answers;
}

export function parseFinalAnswerKey(
  text: string,
  identity?: ExamIdentity,
): Map<number, Answer> {
  const answers = new Map<number, Answer>();
  for (
    const match of text.matchAll(
      /(?:^|\n)[ \t]*(\d{1,4})[ \t]*(?:[-:;]|[ \t])[ \t]*(ANULADA|ANULADO|NULA|[A-E])\b/gim,
    )
  ) {
    const number = Number(match[1]);
    const answer = /^ANUL|^NULA/i.test(match[2])
      ? "ANULADA"
      : match[2].toUpperCase();
    const existing = answers.get(number);
    answers.set(number, existing && existing !== answer ? "AMBIGUA" : answer);
  }
  for (const [number, answer] of parseQuadrixTableAnswerKey(text, identity)) {
    answers.set(number, answer);
  }
  return answers;
}

export function diagnoseParsing(
  booklet: string,
  answerKey: string,
  answers: ReadonlyMap<number, Answer> = parseFinalAnswerKey(answerKey),
): ParseDiagnostics {
  const candidates = parseQuestionBooklet(booklet, answers);
  return {
    questionHeaders: candidates.length,
    multipleChoiceCandidates:
      candidates.filter((question) =>
        Object.keys(question.alternatives).some((key) =>
          !["C", "E"].includes(key)
        )
      ).length,
    certoErradoCandidates:
      candidates.filter((question) =>
        question.alternatives.C === "Certo" &&
        question.alternatives.E === "Errado"
      ).length,
    bookletCharacters: booklet.length,
    answerKeyCharacters: answerKey.length,
  };
}

export function buildQuestions(
  booklet: string,
  answerKey: string,
  identity: ExamIdentity,
) {
  const answers = parseFinalAnswerKey(answerKey, identity);
  const rejected: string[] = [];
  const questions = parseQuestionBooklet(booklet, answers).flatMap(
    (question) => {
      const answer = answers.get(question.number);
      if (question.annulled || answer === "ANULADA") {
        rejected.push(`Questão ${question.number}: anulada`);
        return [];
      }
      if (answer === "AMBIGUA" || !answer) {
        rejected.push(
          `Questão ${question.number}: gabarito ausente ou ambíguo`,
        );
        return [];
      }
      if (
        !question.statement || Object.keys(question.alternatives).length < 2 ||
        !question.alternatives[answer]
      ) {
        rejected.push(
          `Questão ${question.number}: enunciado, alternativas ou gabarito incompletos`,
        );
        return [];
      }
      return [{
        ...question,
        answer,
        organizer: identity.organizer,
        year: identity.year,
        role: identity.role,
        subject: question.subject ?? identity.subject,
      }];
    },
  );
  return {
    questions,
    rejected,
    diagnostics: diagnoseParsing(booklet, answerKey, answers),
  };
}
