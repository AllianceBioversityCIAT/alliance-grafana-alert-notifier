import { describe, it, expect } from 'vitest';
import { buildLokiExploreUrl } from '../src/grafana/build-explore-url.js';

const window = {
  startNs: '1785767580244000000',
  endNs: '1785767880244000000',
};

const baseInput = {
  grafanaBaseUrl: 'http://grafana.example.com:3000',
  lokiDatasourceUid: 'loki-uid-1',
  query: '{job="docker_example_test"} |= "ERROR"',
  window,
};

function panesOf(url: string): Record<string, any> {
  const panes = new URL(url).searchParams.get('panes');
  return JSON.parse(panes ?? '{}') as Record<string, any>;
}

describe('buildLokiExploreUrl', () => {
  it('builds an Explore link carrying the LogQL query and the alert window', () => {
    const url = buildLokiExploreUrl(baseInput);

    expect(url).toBeTypeOf('string');
    const parsed = new URL(url!);
    expect(parsed.origin).toBe('http://grafana.example.com:3000');
    expect(parsed.pathname).toBe('/explore');
    expect(parsed.searchParams.get('schemaVersion')).toBe('1');

    const pane = panesOf(url!).alert;
    expect(pane.queries[0].expr).toBe('{job="docker_example_test"} |= "ERROR"');
    expect(pane.queries[0].datasource).toEqual({
      type: 'loki',
      uid: 'loki-uid-1',
    });
    // Nanoseconds converted to epoch millis without precision loss.
    expect(pane.range).toEqual({ from: '1785767580244', to: '1785767880244' });
  });

  it('infers origin and orgId from the alert URL when no base URL is configured', () => {
    const url = buildLokiExploreUrl({
      ...baseInput,
      grafanaBaseUrl: undefined,
      generatorURL:
        'http://grafana.example.com:3000/alerting/grafana/abc123/view?orgId=7',
    });

    const parsed = new URL(url!);
    expect(parsed.origin).toBe('http://grafana.example.com:3000');
    expect(parsed.searchParams.get('orgId')).toBe('7');
  });

  it('prefers the configured base URL over the alert URL origin', () => {
    const url = buildLokiExploreUrl({
      ...baseInput,
      grafanaBaseUrl: 'https://grafana.internal/',
      generatorURL: 'http://grafana.example.com:3000/alerting/grafana/a/view',
    });

    expect(new URL(url!).origin).toBe('https://grafana.internal');
  });

  it('encodes spaces as %20 so the LogQL survives decodeURIComponent', () => {
    const url = buildLokiExploreUrl(baseInput);

    expect(url).not.toContain('+');
    expect(url).toContain('%20');

    // Both parsers must recover the same expression.
    const rawPanes = url!.split('panes=')[1];
    expect(JSON.parse(decodeURIComponent(rawPanes)).alert.queries[0].expr).toBe(
      '{job="docker_example_test"} |= "ERROR"',
    );
    expect(panesOf(url!).alert.queries[0].expr).toBe(
      '{job="docker_example_test"} |= "ERROR"',
    );
  });

  it('defaults orgId to 1 when the alert URL carries none', () => {
    const url = buildLokiExploreUrl(baseInput);

    expect(new URL(url!).searchParams.get('orgId')).toBe('1');
  });

  it('returns null when the datasource UID is missing', () => {
    expect(
      buildLokiExploreUrl({ ...baseInput, lokiDatasourceUid: undefined }),
    ).toBeNull();
    expect(
      buildLokiExploreUrl({ ...baseInput, lokiDatasourceUid: '   ' }),
    ).toBeNull();
  });

  it('returns null when no origin can be resolved', () => {
    expect(
      buildLokiExploreUrl({
        ...baseInput,
        grafanaBaseUrl: undefined,
        generatorURL: undefined,
      }),
    ).toBeNull();
  });

  it('returns null when the alert URL is unparseable and no base URL is set', () => {
    expect(
      buildLokiExploreUrl({
        ...baseInput,
        grafanaBaseUrl: undefined,
        generatorURL: 'not a url',
      }),
    ).toBeNull();
  });
});
