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
  appendNonEmpty(parameters, "examId", filters.examId);
  appendNonEmpty(parameters, "progress", filters.progress);
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
  appendNonEmpty(parameters, "examId", filters.examId);
  appendNonEmpty(parameters, "progress", filters.progress);
  return parameters.toString();
}

const KIND_LABELS = {
  "multiple-choice": "Múltipla escolha",
  "certo-errado": "Certo ou errado",
};

const simpleEntries = (values) =>
  values.map((value) => ({ value: String(value), label: String(value) }));

export function filterSelectEntries(options) {
  return {
    organizer: simpleEntries(options.organizers),
    year: simpleEntries(options.years),
    role: simpleEntries(options.roles),
    subject: simpleEntries(options.subjects),
    kind: options.kinds.map((kind) => ({
      value: kind,
      label: KIND_LABELS[kind] ?? kind,
    })),
    examId: options.exams.map((exam) => ({
      value: exam.externalId,
      label: exam.label,
    })),
  };
}

export function populateSelect(select, entries, optionFactory) {
  const previous = select.value;
  const options = [
    optionFactory("", "Todos"),
    ...entries.map((entry) => optionFactory(entry.value, entry.label)),
  ];
  select.replaceChildren(...options);
  select.value = entries.some((entry) => entry.value === previous)
    ? previous
    : "";
}

export function resetStudyState(state, pager) {
  pager.reset();
  state.feedback = null;
  state.history = [];
  state.openedQuestion = null;
  state.similarItems = [];
  state.similarLoading = false;
  state.similarError = false;
  state.similarVisible = false;
  state.similarToken = (state.similarToken ?? 0) + 1;
}

export function statementExcerpt(statement, maximumLength = 180) {
  const normalized = String(statement).replace(/\s+/gu, " ").trim();
  return normalized.length <= maximumLength
    ? normalized
    : `${normalized.slice(0, maximumLength - 1).trimEnd()}…`;
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
    examId: data.get("examId"),
    progress: data.get("progress"),
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
    clearFilters: document.querySelector("#clear-filters-button"),
    filterSelects: {
      organizer: document.querySelector("#organizer-filter"),
      year: document.querySelector("#year-filter"),
      role: document.querySelector("#role-filter"),
      subject: document.querySelector("#subject-filter"),
      kind: document.querySelector("#kind-filter"),
      examId: document.querySelector("#exam-filter"),
    },
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
    similarButton: document.querySelector("#similar-button"),
    backToList: document.querySelector("#back-to-list-button"),
    similarSection: document.querySelector("#similar-section"),
    similarStatus: document.querySelector("#similar-status"),
    similarList: document.querySelector("#similar-list"),
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
    openedQuestion: null,
    similarItems: [],
    similarLoading: false,
    similarError: false,
    similarVisible: false,
    similarToken: 0,
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

  const currentQuestion = () =>
    state.openedQuestion ?? pager.snapshot().current;

  function clearQuestionTransient() {
    state.feedback = null;
    state.history = [];
    state.similarItems = [];
    state.similarLoading = false;
    state.similarError = false;
    state.similarVisible = false;
    state.similarToken++;
  }

  function renderSimilar() {
    elements.similarSection.hidden = !state.similarVisible;
    elements.similarList.replaceChildren();
    if (!state.similarVisible) return;
    const message = state.similarLoading
      ? "Buscando questões semelhantes…"
      : state.similarError
      ? "Não foi possível carregar questões semelhantes."
      : state.similarItems.length === 0
      ? "Nenhuma questão semelhante encontrada."
      : "";
    setText(elements.similarStatus, message);
    elements.similarStatus.hidden = message === "";
    for (const item of state.similarItems) {
      const listItem = document.createElement("li");
      const metadata = document.createElement("p");
      metadata.className = "similar-item-meta";
      setText(
        metadata,
        [
          item.exam.organizer,
          item.exam.year,
          item.subject,
          `prova ${item.exam.externalId}`,
          `questão ${item.number}`,
        ].filter(Boolean).join(" · "),
      );
      const excerpt = document.createElement("p");
      setText(excerpt, statementExcerpt(item.statement));
      const openButton = document.createElement("button");
      openButton.type = "button";
      openButton.className = "button button--secondary";
      setText(openButton, "Abrir questão");
      openButton.addEventListener(
        "click",
        () => openSimilarQuestion(item.occurrenceId),
      );
      listItem.append(metadata, excerpt, openButton);
      elements.similarList.append(listItem);
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
    const opened = state.openedQuestion !== null;
    const message = studyStateMessage({
      loading: state.loading,
      error: state.error,
      total: opened ? 1 : page.total,
    });
    setText(elements.studyStatus, message);
    elements.studyStatus.hidden = message === "";
    elements.card.hidden = message !== "";
    setText(elements.counter, opened ? "Questão semelhante" : page.counter);
    elements.previous.disabled = state.loading || state.answering ||
      opened || page.index <= 0;
    elements.next.disabled = state.loading || state.answering ||
      opened || page.total === 0 || page.index >= page.total - 1;
    elements.backToList.hidden = !opened;
    elements.similarButton.disabled = state.loading || state.answering ||
      state.similarLoading;
    if (message !== "") return;

    const question = currentQuestion();
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
    renderSimilar();
  }

  async function loadFilterOptions() {
    const options = await requestJson("/api/filter-options");
    const entries = filterSelectEntries(options);
    const optionFactory = (value, label) => {
      const option = document.createElement("option");
      option.value = value;
      setText(option, label);
      return option;
    };
    for (const [name, select] of Object.entries(elements.filterSelects)) {
      populateSelect(select, entries[name], optionFactory);
    }
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
    resetStudyState(state, pager);
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
      resetStudyState(state, pager);
      state.loading = false;
      state.error = true;
      renderQuestion();
      setApplicationStatus("Erro ao carregar", "error");
    } finally {
      elements.reload.disabled = false;
    }
  }

  async function answerQuestion(selectedLabel) {
    const question = currentQuestion();
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

  async function loadSimilarQuestions() {
    const question = currentQuestion();
    if (!question || state.similarLoading || state.answering) return;
    const token = ++state.similarToken;
    state.similarVisible = true;
    state.similarLoading = true;
    state.similarError = false;
    state.similarItems = [];
    renderQuestion();
    try {
      const items = await requestJson(
        `/api/questions/${question.occurrenceId}/similar?limit=10`,
      );
      if (token !== state.similarToken) return;
      state.similarItems = items;
      state.similarLoading = false;
      renderQuestion();
    } catch {
      if (token !== state.similarToken) return;
      state.similarLoading = false;
      state.similarError = true;
      renderQuestion();
    }
  }

  async function openSimilarQuestion(occurrenceId) {
    if (state.loading || state.answering) return;
    state.loading = true;
    elements.reload.disabled = true;
    renderQuestion();
    try {
      const question = await requestJson(`/api/questions/${occurrenceId}`);
      clearQuestionTransient();
      state.openedQuestion = question;
      state.loading = false;
      renderQuestion();
      setApplicationStatus("Questão semelhante aberta", "ready");
    } catch {
      state.loading = false;
      renderQuestion();
      setApplicationStatus("Erro ao abrir questão", "error");
    } finally {
      elements.reload.disabled = false;
    }
  }

  function backToFilteredList() {
    if (state.loading || state.answering || !state.openedQuestion) return;
    state.openedQuestion = null;
    clearQuestionTransient();
    renderQuestion();
    setApplicationStatus("Lista filtrada", "ready");
  }

  async function navigate(direction) {
    if (state.loading || state.answering || state.openedQuestion) return;
    const page = pager.snapshot();
    const nextIndex = page.index + direction;
    if (nextIndex < 0 || nextIndex >= page.total) return;

    clearQuestionTransient();
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
    if (state.answering || state.loading) return;
    state.filters = readFilters(elements.form);
    loadData();
  });
  elements.clearFilters.addEventListener("click", () => {
    if (state.answering || state.loading) return;
    elements.form.reset();
    state.filters = {};
    loadData();
  });
  elements.reload.addEventListener("click", async () => {
    if (state.answering || state.loading) return;
    try {
      await loadFilterOptions();
      await loadData();
    } catch {
      state.loading = false;
      state.error = true;
      renderQuestion();
      setApplicationStatus("Erro ao carregar", "error");
    }
  });
  elements.previous.addEventListener("click", () => navigate(-1));
  elements.next.addEventListener("click", () => navigate(1));
  elements.similarButton.addEventListener("click", loadSimilarQuestions);
  elements.backToList.addEventListener("click", backToFilteredList);
  loadFilterOptions().then(loadData).catch(() => {
    state.loading = false;
    state.error = true;
    renderQuestion();
    setApplicationStatus("Erro ao carregar", "error");
  });
}

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", initialize, { once: true });
}
