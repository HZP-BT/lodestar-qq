export type TokenScheme = 'Bearer' | 'Token';
export type TokenPlacement = 'header' | 'query' | 'both';

/**
 * aiocqhttp validates Authorization with /(?:Token|Bearer) <token>/.
 * Sending the header is therefore required for AstrBot, while the query form
 * is kept for other OneBot implementations.
 */
export function buildAuthHeaders(
  token: string | undefined,
  scheme: TokenScheme = 'Bearer',
): Record<string, string> {
  if (!token) {
    return {};
  }

  return { Authorization: `${scheme} ${token}` };
}

export function withQueryToken(
  url: string,
  token: string | undefined,
  placement: TokenPlacement = 'header',
): string {
  if (!token || placement === 'header') {
    return url;
  }

  const parsed = new URL(url);
  parsed.searchParams.set('access_token', token);
  return parsed.toString();
}
