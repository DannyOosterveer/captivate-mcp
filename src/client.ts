const BASE_URL = process.env.CAPTIVATE_API_URL ?? "https://api.captivate.fm";

export class CaptivateError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/**
 * Minimal client for the Captivate.fm API (https://docs.captivate.fm).
 * Exchanges the user ID + API token for a bearer token on first use and
 * re-authenticates once when the token is rejected.
 */
export class CaptivateClient {
  private token: string | undefined;

  constructor(
    readonly userId: string,
    private readonly apiToken: string,
  ) {}

  private async authenticate(): Promise<string> {
    const form = new FormData();
    form.append("username", this.userId);
    form.append("token", this.apiToken);

    const res = await fetch(`${BASE_URL}/authenticate/token`, {
      method: "POST",
      body: form,
    });
    const body = await readBody(res);
    const token = (body as { user?: { token?: string } })?.user?.token;
    if (!res.ok || !token) {
      throw new CaptivateError(
        `Authentication failed (HTTP ${res.status}). Check CAPTIVATE_USER_ID and CAPTIVATE_API_TOKEN.`,
        res.status,
      );
    }
    this.token = token;
    return token;
  }

  async request<T = unknown>(
    method: "GET" | "POST",
    path: string,
    options: { query?: Record<string, string | number | boolean | undefined>; body?: unknown } = {},
  ): Promise<T> {
    const url = new URL(path, BASE_URL);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const send = async (token: string) =>
      fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });

    let res = await send(this.token ?? (await this.authenticate()));
    if (res.status === 401 || res.status === 403) {
      res = await send(await this.authenticate());
    }

    const body = await readBody(res);
    if (!res.ok) {
      const detail = typeof body === "string" ? body : JSON.stringify(body);
      throw new CaptivateError(`Captivate API ${method} ${url.pathname} failed (HTTP ${res.status}): ${detail.slice(0, 500)}`, res.status);
    }
    return body as T;
  }
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
