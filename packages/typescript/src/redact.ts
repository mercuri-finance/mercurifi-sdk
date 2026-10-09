/** Host only (no path, query or credentials): RPC URLs often carry an API key in the path. */
export const redactUrl = (url: string): string => {
  try {
    return new URL(url).host || 'invalid URL';
  } catch {
    return 'invalid URL';
  }
};

// Hierarchical schemes match anywhere (no leading word boundary: "x:https://k@h/KEY" must not slip through);
// data:/javascript: only after a non-alphanumeric so ordinary words such as "metadata:" are left alone.
const URL_PATTERN = /(?:(?:https?|wss?|ftps?):\/\/|(?<![A-Za-z0-9])(?:data|javascript):)[^\s"'<>)]*/gi;

/** Replaces every URL in a message with its host ("invalid URL" for schemes without one). */
export const redactUrlsIn = (message: string): string => message.replace(URL_PATTERN, (u) => redactUrl(u));
