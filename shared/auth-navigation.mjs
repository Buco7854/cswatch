/** One browser/server policy for authentication redirects. Paths name application
 * views, never authentication loops, server actions or caller-selected origins. */
export function safeAuthReturnPath(value, fallback = '/library') {
  if (
    typeof value !== 'string' ||
    value.length > 1024 ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    /[\\\u0000-\u001f\u007f]/.test(value)
  )
    return fallback;
  try {
    const url = new URL(value, 'https://cswatch.invalid');
    if (
      url.origin !== 'https://cswatch.invalid' ||
      !/^\/(?:library|account(?:\/connections)?|admin|watch\/[A-Za-z0-9_-]+)?\/?$/.test(
        url.pathname,
      )
    )
      return fallback;
    return url.pathname + url.search + url.hash;
  } catch {
    return fallback;
  }
}
