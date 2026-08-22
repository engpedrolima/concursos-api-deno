export const QUESTION_PAGE_SIZE = 100;

export function setText(target, value) {
  target.textContent = value === null || value === undefined
    ? ""
    : String(value);
}

export function formatPercent(value) {
  const number = Number(value);
  return `${
    Number.isFinite(number)
      ? number.toLocaleString("pt-BR", {
        maximumFractionDigits: 2,
        minimumFractionDigits: 0,
      })
      : "0"
  }%`;
}

function appendNonEmpty(parameters, name, value) {
  const normalized = value === null || value === undefined
    ? ""
    : String(value).trim();
  if (normalized !== "") parameters.set(name, normalized);
}

export function buildQuestionSearch(
  filters = {},
  { limit = QUESTION_PAGE_SIZE, offset = 0 } = {},
) {
  const parameters = new URLSearchParams();
  appendNonEmpty(parameters, "organizer", filters.organizer);
  appendNonEmpty(parameters, "year", filters.year);
  appendNonEmpty(parameters, "role", filters.role);
  appendNonEmpty(parameters, "subject", filters.subject);
  appendNonEmpty(parameters, "kind", filters.kind);
  if (filters.deduplicate === true) parameters.set("deduplicate", "true");
  parameters.set("limit", String(limit));
  parameters.set("offset", String(offset));
  return parameters.toString();
}

export function createQuestionPager({
  fetchPage,
  pageSize = QUESTION_PAGE_SIZE,
}) {
  if (typeof fetchPage !== "function") {
    throw new TypeError("fetchPage deve ser uma função.");
  }
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new RangeError("pageSize deve ser um inteiro positivo.");
  }

  const pages = new Map();
  let index = 0;
  let total = 0;
  let loaded = false;

  const offsetFor = (targetIndex) =>
    Math.floor(targetIndex / pageSize) * pageSize;

  function current() {
    if (!loaded || total === 0) return null;
    const offset = offsetFor(index);
    return pages.get(offset)?.[index - offset] ?? null;
  }

  function isCached(targetIndex) {
    if (!Number.isInteger(targetIndex) || targetIndex < 0) return false;
    const offset = offsetFor(targetIndex);
    return pages.get(offset)?.[targetIndex - offset] !== undefined;
  }

  function snapshot() {
    return {
      index,
      total,
      current: current(),
      counter: total === 0 ? "0 de 0" : `${index + 1} de ${total}`,
      cachedPageCount: pages.size,
    };
  }

  function reset() {
    pages.clear();
    index = 0;
    total = 0;
    loaded = false;
  }

  async function goTo(targetIndex) {
    if (!Number.isInteger(targetIndex) || targetIndex < 0) return false;
    if (loaded && targetIndex >= total) return false;

    const offset = offsetFor(targetIndex);
    if (!pages.has(offset)) {
      const result = await fetchPage({ limit: pageSize, offset });
      if (
        !result || !Array.isArray(result.items) ||
        !Number.isInteger(result.total) || result.total < 0
      ) {
        throw new Error("Resposta de paginação inválida.");
      }
      pages.set(offset, result.items);
      total = result.total;
      loaded = true;
    }

    if (targetIndex >= total) return false;
    if (!isCached(targetIndex)) {
      throw new Error("Página incompleta para o total informado.");
    }
    index = targetIndex;
    return true;
  }

  return {
    goTo,
    isCached,
    next: () => goTo(index + 1),
    previous: () => goTo(index - 1),
    reset,
    snapshot,
  };
}

export function buildStatisticsSearch(filters = {}) {
  const parameters = new URLSearchParams();
  appendNonEmpty(parameters, "organizer", filters.organizer);
  appendNonEmpty(parameters, "year", filters.year);
  appendNonEmpty(parameters, "role", filters.role);
  appendNonEmpty(parameters, "subject", filters.subject);
  appendNonEmpty(parameters, "kind", filters.kind);
  return parameters.toString();
}

export function feedbackPresentation(selectedLabel, correctLabel) {
  const isCorrect = selectedLabel === correctLabel;
  return {
    isCorrect,
    heading: isCorrect ? "Correto" : "Incorreto",
    message: `${
      isCorrect ? "Correto" : "Incorreto"
    }. Gabarito: ${correctLabel}.`,
  };
}

export function studyStateMessage(
  { loading = false, error = false, total = 0 },
) {
  if (loading) return "Carregando questões…";
  if (error) {
    return "Não foi possível carregar os dados. Verifique se o servidor local está disponível.";
  }
  if (total === 0) {
    return "Nenhuma questão encontrada. Gere um artefato e importe-o com deno task db:import antes de estudar.";
  }
  return "";
}

function readFilters(form) {
  const data = new FormData(form);
  return {
    organizer: data.get("organizer"),
    year: data.get("year"),
    role: data.get("role"),
    subject: data.get("subject"),
    kind: data.get("kind"),
    deduplicate: data.get("deduplicate") === "on",
  };
}

async function requestJson(path, options) {
  const response = await fetch(path, options);
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error("invalid-response");
  }
  if (!response.ok) throw new Error("api-error");
  return body;
}

function initialize() {
  const elements = {
    status: document.querySelector("#app-status"),
    reload: document.querySelector("#reload-button"),
    form: document.querySelector("#filters-form"),
    studyStatus: document.querySelector("#study-status"),
    card: document.querySelector("#question-card"),
    counter: document.querySelector("#question-counter"),
    meta: document.querySelector("#question-meta"),
    statement: document.querySelector("#question-statement"),
    alternatives: document.querySelector("#alternatives"),
    feedback: document.querySelector("#answer-feedback"),
    historySection: document.querySelector("#history-section"),
    history: document.querySelector("#attempt-history"),
    previous: document.querySelector("#previous-button"),
    next: document.querySelector("#next-button"),
    stats: {
      attempts: document.querySelector("#stat-attempts"),
      correct: document.querySelector("#stat-correct"),
      incorrect: document.querySelector("#stat-incorrect"),
      accuracy: document.querySelector("#stat-accuracy"),
      answered: document.querySelector("#stat-answered"),
      unanswered: document.querySelector("#stat-unanswered"),
    },
  };
  const state = {
    filters: {},
    feedback: null,
    history: [],
    loading: false,
    error: false,
    answering: false,
  };
  const pager = createQuestionPager({
    fetchPage: ({ limit, offset }) => {
      const query = buildQuestionSearch(state.filters, { limit, offset });
      return requestJson(`/api/questions?${query}`);
    },
  });

  function setApplicationStatus(message, tone = "ready") {
    setText(elements.status, message);
    elements.status.className = `status-pill status-pill--${tone}`;
  }

  function renderStatistics(statistics) {
    setText(elements.stats.attempts, statistics.attempts.total);
    setText(elements.stats.correct, statistics.attempts.correct);
    setText(elements.stats.incorrect, statistics.attempts.incorrect);
    setText(
      elements.stats.accuracy,
      formatPercent(statistics.attempts.accuracyPercent),
    );
    setText(elements.stats.answered, statistics.occurrences.answered);
    setText(elements.stats.unanswered, statistics.occurrences.unanswered);
  }

  function renderHistory() {
    elements.history.replaceChildren();
    if (!state.feedback) {
      elements.historySection.hidden = true;
      return;
    }
    elements.historySection.hidden = false;
    if (state.history.length === 0) {
      const item = document.createElement("li");
      setText(item, "Nenhuma tentativa anterior.");
      elements.history.append(item);
      return;
    }
    for (const attempt of state.history) {
      const item = document.createElement("li");
      const result = attempt.isCorrect ? "correta" : "incorreta";
      const date = new Date(attempt.answeredAt);
      const time = Number.isNaN(date.getTime())
        ? "horário indisponível"
        : date.toLocaleString("pt-BR");
      setText(
        item,
        `${time} — resposta ${attempt.selectedLabel}, ${result}; gabarito ${attempt.correctLabel}.`,
      );
      elements.history.append(item);
    }
  }

  function renderAlternatives(question) {
    elements.alternatives.replaceChildren();
    for (const alternative of question.alternatives) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "alternative";
      setText(button, `${alternative.label}. ${alternative.text}`);
      if (state.feedback) {
        if (alternative.label === state.feedback.correctLabel) {
          button.classList.add("alternative--correct");
        }
        if (alternative.label === state.feedback.selectedLabel) {
          button.classList.add("alternative--selected");
          if (!state.feedback.isCorrect) {
            button.classList.add("alternative--incorrect");
          }
        }
      }
      button.disabled = state.answering || state.feedback !== null;
      button.addEventListener("click", () => answerQuestion(alternative.label));
      elements.alternatives.append(button);
    }
  }

  function renderQuestion() {
    const page = pager.snapshot();
    const message = studyStateMessage({
      loading: state.loading,
      error: state.error,
      total: page.total,
    });
    setText(elements.studyStatus, message);
    elements.studyStatus.hidden = message === "";
    elements.card.hidden = message !== "";
    setText(elements.counter, page.counter);
    elements.previous.disabled = state.loading || state.answering ||
      page.index <= 0;
    elements.next.disabled = state.loading || state.answering ||
      page.total === 0 || page.index >= page.total - 1;
    if (message !== "") return;

    const question = page.current;
    const metadata = [
      question.exam.organizer,
      question.exam.year,
      question.exam.role,
      question.subject,
      `prova ${question.exam.externalId}`,
      `questão ${question.number}`,
    ].filter((value) =>
      value !== null && value !== undefined && String(value).trim() !== ""
    );
    setText(elements.meta, metadata.join(" · "));
    setText(elements.statement, question.statement);
    renderAlternatives(question);
    if (state.feedback) {
      const presentation = feedbackPresentation(
        state.feedback.selectedLabel,
        state.feedback.correctLabel,
      );
      setText(elements.feedback, presentation.message);
      elements.feedback.className = presentation.isCorrect
        ? "answer-feedback answer-feedback--correct"
        : "answer-feedback answer-feedback--incorrect";
    } else {
      setText(
        elements.feedback,
        state.answering ? "Registrando resposta…" : "",
      );
      elements.feedback.className = "answer-feedback";
    }
    renderHistory();
  }

  async function loadStatistics() {
    const query = buildStatisticsSearch(state.filters);
    const suffix = query === "" ? "" : `?${query}`;
    const statistics = await requestJson(`/api/statistics${suffix}`);
    renderStatistics(statistics);
  }

  async function loadData() {
    state.loading = true;
    state.error = false;
    state.feedback = null;
    state.history = [];
    pager.reset();
    renderQuestion();
    setApplicationStatus("Carregando", "loading");
    elements.reload.disabled = true;
    try {
      const statisticsQuery = buildStatisticsSearch(state.filters);
      const [, statistics] = await Promise.all([
        pager.goTo(0),
        requestJson(
          `/api/statistics${
            statisticsQuery === "" ? "" : `?${statisticsQuery}`
          }`,
        ),
      ]);
      state.loading = false;
      renderStatistics(statistics);
      renderQuestion();
      setApplicationStatus("Pronto", "ready");
    } catch {
      pager.reset();
      state.loading = false;
      state.error = true;
      renderQuestion();
      setApplicationStatus("Erro ao carregar", "error");
    } finally {
      elements.reload.disabled = false;
    }
  }

  async function answerQuestion(selectedLabel) {
    const question = pager.snapshot().current;
    if (state.answering || state.feedback || question === null) {
      return;
    }
    state.answering = true;
    elements.reload.disabled = true;
    renderQuestion();
    try {
      state.feedback = await requestJson(
        `/api/questions/${question.occurrenceId}/attempts`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ selectedLabel }),
        },
      );
      renderQuestion();
      const [history] = await Promise.all([
        requestJson(`/api/questions/${question.occurrenceId}/attempts`),
        loadStatistics(),
      ]);
      state.history = history;
      state.answering = false;
      elements.reload.disabled = false;
      renderQuestion();
      setApplicationStatus("Resposta registrada", "ready");
    } catch {
      state.answering = false;
      elements.reload.disabled = false;
      renderQuestion();
      setApplicationStatus(
        state.feedback
          ? "Resposta registrada; atualização incompleta"
          : "Erro ao responder",
        "error",
      );
    }
  }

  async function navigate(direction) {
    if (state.loading || state.answering) return;
    const page = pager.snapshot();
    const nextIndex = page.index + direction;
    if (nextIndex < 0 || nextIndex >= page.total) return;

    state.feedback = null;
    state.history = [];
    const needsFetch = !pager.isCached(nextIndex);
    if (needsFetch) {
      state.loading = true;
      renderQuestion();
      setApplicationStatus("Carregando", "loading");
    }
    try {
      await pager.goTo(nextIndex);
      state.loading = false;
      renderQuestion();
      setApplicationStatus("Pronto", "ready");
    } catch {
      state.loading = false;
      renderQuestion();
      setApplicationStatus("Erro ao carregar", "error");
    }
  }

  elements.form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (state.answering) return;
    state.filters = readFilters(elements.form);
    loadData();
  });
  elements.reload.addEventListener("click", loadData);
  elements.previous.addEventListener("click", () => navigate(-1));
  elements.next.addEventListener("click", () => navigate(1));
  loadData();
}

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", initialize, { once: true });
}
