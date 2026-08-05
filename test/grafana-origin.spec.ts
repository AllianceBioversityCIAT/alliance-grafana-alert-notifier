import { describe, it, expect } from 'vitest';
import {
  applyGrafanaBaseUrl,
  normalizeGrafanaBaseUrl,
  rewriteGrafanaUrl,
} from '../src/grafana/grafana-origin.js';
import type { ParsedGrafanaAlert } from '../src/grafana/grafana-payload.types.js';

// The real shape of the mismatch: Grafana builds links from its internal
// root_url while developers reach it through the proxy.
const INTERNAL = 'http://grafana.example.com:3000/alerting/grafana/abc123/view?orgId=1';
const PUBLIC_BASE = 'https://grafana.example.com';

describe('normalizeGrafanaBaseUrl', () => {
  it('strips trailing slashes', () => {
    expect(normalizeGrafanaBaseUrl('https://grafana.example.com///')).toBe(
      'https://grafana.example.com',
    );
  });

  it('keeps a configured sub-path', () => {
    expect(normalizeGrafanaBaseUrl('https://host/grafana/')).toBe(
      'https://host/grafana',
    );
  });

  it('returns null when unset or unparseable', () => {
    expect(normalizeGrafanaBaseUrl(undefined)).toBeNull();
    expect(normalizeGrafanaBaseUrl('   ')).toBeNull();
    expect(normalizeGrafanaBaseUrl('not a url')).toBeNull();
  });
});

describe('rewriteGrafanaUrl', () => {
  it('replaces scheme, host and port while keeping path and query', () => {
    expect(rewriteGrafanaUrl(INTERNAL, PUBLIC_BASE)).toBe(
      'https://grafana.example.com/alerting/grafana/abc123/view?orgId=1',
    );
  });

  it('preserves the fragment', () => {
    expect(
      rewriteGrafanaUrl('http://internal:3000/d/panel/1?x=2#row-3', PUBLIC_BASE),
    ).toBe('https://grafana.example.com/d/panel/1?x=2#row-3');
  });

  it('prefixes a configured sub-path without doubling slashes', () => {
    expect(rewriteGrafanaUrl(INTERNAL, 'https://host/grafana')).toBe(
      'https://host/grafana/alerting/grafana/abc123/view?orgId=1',
    );
  });

  it('returns the URL untouched when no base URL is configured', () => {
    expect(rewriteGrafanaUrl(INTERNAL, undefined)).toBe(INTERNAL);
    expect(rewriteGrafanaUrl(INTERNAL, '  ')).toBe(INTERNAL);
  });

  it('returns the input untouched when it is not an absolute URL', () => {
    expect(rewriteGrafanaUrl('/alerting/list', PUBLIC_BASE)).toBe(
      '/alerting/list',
    );
    expect(rewriteGrafanaUrl(undefined, PUBLIC_BASE)).toBeUndefined();
  });
});

describe('applyGrafanaBaseUrl', () => {
  const alert: ParsedGrafanaAlert = {
    alertname: 'PRMS Test - Loki Error Alert',
    job: 'docker_prms_test',
    status: 'firing',
    panelURL: 'http://grafana.example.com:3000/d/panel/1',
    generatorURL: INTERNAL,
  };

  it('rewrites both Grafana links and leaves the rest of the alert alone', () => {
    const result = applyGrafanaBaseUrl(alert, PUBLIC_BASE);

    expect(result.generatorURL).toBe(
      'https://grafana.example.com/alerting/grafana/abc123/view?orgId=1',
    );
    expect(result.panelURL).toBe('https://grafana.example.com/d/panel/1');
    expect(result.alertname).toBe(alert.alertname);
    expect(result.job).toBe(alert.job);
  });

  it('returns the same alert when no base URL is configured', () => {
    expect(applyGrafanaBaseUrl(alert, undefined)).toBe(alert);
  });

  it('leaves absent links absent rather than inventing them', () => {
    const bare: ParsedGrafanaAlert = {
      alertname: 'X',
      job: 'y',
      status: 'firing',
    };

    const result = applyGrafanaBaseUrl(bare, PUBLIC_BASE);

    expect(result.generatorURL).toBeUndefined();
    expect(result.panelURL).toBeUndefined();
  });
});
