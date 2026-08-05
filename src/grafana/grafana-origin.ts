import type { ParsedGrafanaAlert } from './grafana-payload.types.js';

/**
 * Trim a configured Grafana base URL down to a usable prefix, keeping any
 * sub-path (Grafana can be served under one, e.g. https://host/grafana).
 * Returns null when unset or unparseable, so callers can fall back.
 */
export function normalizeGrafanaBaseUrl(
  baseUrl: string | undefined,
): string | null {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return null;
  }

  const withoutTrailingSlash = trimmed.replace(/\/+$/, '');

  try {
    new URL(withoutTrailingSlash);
  } catch {
    return null;
  }

  return withoutTrailingSlash;
}

/**
 * Re-home a URL Grafana generated onto the configured base URL, keeping path,
 * query and fragment.
 *
 * Grafana builds `generatorURL` and `panelURL` from its own `root_url`, which
 * behind a reverse proxy is the internal address — `http://host:3000/...` while
 * users reach it at `https://host/...`. Those links then fail to open from a
 * developer's browser. Left alone the alert also mixes origins: the Explore
 * link uses the configured base while these use the internal one.
 *
 * Returns the input untouched when there is nothing to apply, so a missing
 * GRAFANA_BASE_URL keeps today's behaviour.
 */
export function rewriteGrafanaUrl(
  url: string | undefined,
  grafanaBaseUrl: string | undefined,
): string | undefined {
  if (!url) {
    return url;
  }

  const base = normalizeGrafanaBaseUrl(grafanaBaseUrl);
  if (!base) {
    return url;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Relative or malformed: nothing reliable to re-home.
    return url;
  }

  return `${base}${parsed.pathname}${parsed.search}${parsed.hash}`;
}

/** Apply `rewriteGrafanaUrl` to every Grafana-generated link on an alert. */
export function applyGrafanaBaseUrl(
  alert: ParsedGrafanaAlert,
  grafanaBaseUrl: string | undefined,
): ParsedGrafanaAlert {
  if (!normalizeGrafanaBaseUrl(grafanaBaseUrl)) {
    return alert;
  }

  return {
    ...alert,
    panelURL: rewriteGrafanaUrl(alert.panelURL, grafanaBaseUrl),
    generatorURL: rewriteGrafanaUrl(alert.generatorURL, grafanaBaseUrl),
  };
}
