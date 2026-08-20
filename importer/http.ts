export interface HttpPolicy {
  timeoutMs: number;
  retries: number;
  minIntervalMs: number;
  maxRedirects: number;
  userAgent: string;
}

export type RedirectValidator = (url: URL) => URL;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const redirectStatus = new Set([301, 302, 303, 307, 308]);

/** Cliente sem cookies, login, bypass ou redirects implícitos. */
export class PoliteHttpClient {
  #lastRequestAt = 0;
  constructor(
    private readonly policy: HttpPolicy,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async #waitForRequestSlot() {
    const wait = this.policy.minIntervalMs - (Date.now() - this.#lastRequestAt);
    if (wait > 0) await pause(wait);
    this.#lastRequestAt = Date.now();
  }

  async get(
    rawUrl: string,
    validateRedirect: RedirectValidator,
  ): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.policy.retries; attempt++) {
      let current = new URL(rawUrl);
      try {
        for (let redirects = 0;; redirects++) {
          await this.#waitForRequestSlot();
          const controller = new AbortController();
          const timer = setTimeout(
            () => controller.abort(),
            this.policy.timeoutMs,
          );
          let response: Response;
          try {
            response = await this.fetcher(current.href, {
              headers: {
                "user-agent": this.policy.userAgent,
                accept: "application/pdf",
              },
              signal: controller.signal,
              redirect: "manual",
            });
          } finally {
            clearTimeout(timer);
          }

          if (!redirectStatus.has(response.status)) {
            if (response.ok) return response;
            lastError = new Error(
              `HTTP ${response.status} ao baixar ${current.href}`,
            );
            if (
              response.status >= 400 && response.status < 500 &&
              response.status !== 429
            ) break;
            throw lastError;
          }
          if (redirects >= this.policy.maxRedirects) {
            await response.body?.cancel();
            throw new Error(
              `Limite de ${this.policy.maxRedirects} redirecionamentos excedido.`,
            );
          }
          const location = response.headers.get("location");
          if (!location) {
            await response.body?.cancel();
            throw new Error("Redirecionamento sem cabeçalho Location.");
          }
          let next: URL;
          try {
            next = new URL(location, current);
          } catch {
            await response.body?.cancel();
            throw new Error("Location de redirecionamento inválido.");
          }
          // A validação ocorre antes de qualquer solicitação ao próximo destino.
          try {
            current = validateRedirect(next);
          } finally {
            await response.body?.cancel();
          }
        }
      } catch (error) {
        lastError = error;
      }
      if (attempt < this.policy.retries) await pause(250 * (attempt + 1));
    }
    throw lastError instanceof Error
      ? lastError
      : new Error("Falha de rede sem detalhe");
  }
}
