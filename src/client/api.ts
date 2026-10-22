async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`);
  return data as T;
}

export const api = {
  launch: (repo: string) => call<{ agent: { id: string } }>('POST', '/api/agents', { repo }),
  prompt: (id: string, text: string) => call('POST', `/api/agents/${encodeURIComponent(id)}/prompt`, { text }),
  takeover: (id: string) => call('POST', `/api/agents/${encodeURIComponent(id)}/takeover`),
  kill: (id: string) => call('POST', `/api/agents/${encodeURIComponent(id)}/kill`),
  screen: (id: string) => call<{ screen: string }>('GET', `/api/agents/${encodeURIComponent(id)}/screen`),
};
