import { normalizeGrafanaBaseUrl } from './grafana-origin.js';
import type { TimeWindow } from './grafana-payload.types.js';

const DEFAULT_ORG_ID = '1';

/** Any stable key works; Grafana only uses it to name the pane. */
const PANE_KEY = 'alert';

export interface BuildLokiExploreUrlInput {
  /** Explicit Grafana origin from the secret. Wins over the alert URL. */
  grafanaBaseUrl?: string;
  lokiDatasourceUid?: string;
  /** Grafana's own alert-rule link, used to infer origin and orgId. */
  generatorURL?: string;
  query: string;
  window: TimeWindow;
}

/**
 * Loki timestamps are nanosecond strings; Grafana ranges are epoch millis.
 * String slicing avoids the precision loss of Number on 19-digit values.
 */
function nsToMs(timestampNs: string): string {
  const digits = timestampNs.replace(/\D/g, '');
  const ms = digits.slice(0, -6);
  return ms === '' ? '0' : ms;
}

function resolveBaseUrl(input: BuildLokiExploreUrlInput): string | null {
  const configured = normalizeGrafanaBaseUrl(input.grafanaBaseUrl);
  if (configured) {
    return configured;
  }

  if (!input.generatorURL) {
    return null;
  }

  try {
    return new URL(input.generatorURL).origin;
  } catch {
    return null;
  }
}

function resolveOrgId(generatorURL?: string): string {
  if (!generatorURL) {
    return DEFAULT_ORG_ID;
  }

  try {
    return new URL(generatorURL).searchParams.get('orgId') ?? DEFAULT_ORG_ID;
  } catch {
    return DEFAULT_ORG_ID;
  }
}

/**
 * Deep link to Grafana Explore with the LogQL query and the alert's own time
 * window already applied, so a developer lands on the log lines instead of on
 * the alert rule definition.
 *
 * Returns null whenever the origin or the datasource UID is unknown: the link
 * is additive, and a missing one must never break the notification.
 */
export function buildLokiExploreUrl(
  input: BuildLokiExploreUrlInput,
): string | null {
  const baseUrl = resolveBaseUrl(input);
  const datasourceUid = input.lokiDatasourceUid?.trim();

  if (!baseUrl || !datasourceUid || input.query.trim() === '') {
    return null;
  }

  const panes = {
    [PANE_KEY]: {
      datasource: datasourceUid,
      queries: [
        {
          refId: 'A',
          expr: input.query,
          queryType: 'range',
          datasource: { type: 'loki', uid: datasourceUid },
        },
      ],
      range: {
        from: nsToMs(input.window.startNs),
        to: nsToMs(input.window.endNs),
      },
    },
  };

  // encodeURIComponent, not URLSearchParams: the latter encodes spaces as "+",
  // which survives form-urlencoded parsing but turns into a literal plus under
  // decodeURIComponent — enough to corrupt the LogQL expression.
  const query = [
    'schemaVersion=1',
    `orgId=${encodeURIComponent(resolveOrgId(input.generatorURL))}`,
    `panes=${encodeURIComponent(JSON.stringify(panes))}`,
  ].join('&');

  return `${baseUrl}/explore?${query}`;
}
