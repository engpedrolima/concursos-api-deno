const QUESTION_LIMIT = 100;

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

export function buildQuestionSearch(filters = {}) {
  const parameters = new URLSearchParams();
  appendNonEmpty(parameters, "organizer", filters.organizer);
  appendNonEmpty(parameters, "year", filters.year);
  appendNonEmpty(parameters, "role", filters.role);
  appendNonEmpty(parameters, "subject", filters.subject);
  appendNonEmpty(parameters, "kind", filters.kind);
  if (filters.deduplicate === true) parameters.set("deduplicate", "true");
  parameters.set("limit", String(QUESTION_LIMIT));
  return parameters.toString();
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
    questions: [],
    index: 0,
    feedback: null,
    history: [],
    loading: false,
    error: false,
    answering: false,
  };

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
    const message = studyStateMessage({
      loading: state.loading,
      error: state.error,
      total: state.questions.length,
    });
    setText(elements.studyStatus, message);
    elements.studyStatus.hidden = message === "";
    elements.card.hidden = message !== "";
    const total = state.questions.length;
    setText(
      elements.counter,
      total === 0 ? "0 de 0" : `${state.index + 1} de ${total}`,
    );
    elements.previous.disabled = state.loading || state.index <= 0;
    elements.next.disabled = state.loading || total === 0 ||
      state.index >= total - 1;
    if (message !== "") return;

    const question = state.questions[state.index];
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
    renderQuestion();
    setApplicationStatus("Carregando", "loading");
    elements.reload.disabled = true;
    try {
      const questionQuery = buildQuestionSearch(state.filters);
      const statisticsQuery = buildStatisticsSearch(state.filters);
      const [questions, statistics] = await Promise.all([
        requestJson(`/api/questions?${questionQuery}`),
        requestJson(
          `/api/statistics${
            statisticsQuery === "" ? "" : `?${statisticsQuery}`
          }`,
        ),
      ]);
      state.questions = questions.items;
      state.index = 0;
      state.loading = false;
      renderStatistics(statistics);
      renderQuestion();
      setApplicationStatus("Pronto", "ready");
    } catch {
      state.questions = [];
      state.index = 0;
      state.loading = false;
      state.error = true;
      renderQuestion();
      setApplicationStatus("Erro ao carregar", "error");
    } finally {
      elements.reload.disabled = false;
    }
  }

  async function answerQuestion(selectedLabel) {
    if (state.answering || state.feedback || state.questions.length === 0) {
      return;
    }
    const question = state.questions[state.index];
    state.answering = true;
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
      state.answering = false;
      renderQuestion();
      const [history] = await Promise.all([
        requestJson(`/api/questions/${question.occurrenceId}/attempts`),
        loadStatistics(),
      ]);
      state.history = history;
      renderQuestion();
      setApplicationStatus("Resposta registrada", "ready");
    } catch {
      state.answering = false;
      renderQuestion();
      setApplicationStatus(
        state.feedback
          ? "Resposta registrada; atualização incompleta"
          : "Erro ao responder",
        "error",
      );
    }
  }

  function navigate(direction) {
    const nextIndex = state.index + direction;
    if (nextIndex < 0 || nextIndex >= state.questions.length) return;
    state.index = nextIndex;
    state.feedback = null;
    state.history = [];
    renderQuestion();
  }

  elements.form.addEventListener("submit", (event) => {
    event.preventDefault();
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
