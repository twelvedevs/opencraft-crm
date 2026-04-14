// import SpamScanner from 'spamscanner';
import { createLogger } from '@ortho/logger';
import type { DomainRepository } from '../repositories/domain-repository.js';

const log = createLogger('email-service:spam-checker');

export interface SpamCheckResult {
  score: number;
  threshold: number;
  passed: boolean;
  issues: Array<{ rule: string; description: string; score: number }>;
}

export class SpamCheckerService {
  constructor(
    private readonly domainRepo: DomainRepository,
    private readonly defaultThreshold: number,
  ) {}

  async check(opts: {
    locationId?: string;
    subject: string;
    html: string;
    text: string;
  }): Promise<SpamCheckResult> {
    // 1. Resolve threshold
    let threshold = this.defaultThreshold;
    if (opts.locationId) {
      const domain = await this.domainRepo.findByLocationId(opts.locationId);
      if (domain) {
        threshold = domain.spam_score_threshold;
      }
    }

    // temporarily turn-off spam checker, always allow all email
    log.info({ location_id: opts.locationId, score: 0, threshold, passed: true }, 'Mock spam check complete');
    return { score: 0, threshold, passed: 0 <= threshold, issues: [] };

    /*
    // 2. Run spam scan — build minimal RFC 2822 email string
    const emailSource = [
      `Subject: ${opts.subject}`,
      'From: noreply@example.com',
      'To: recipient@example.com',
      'Content-Type: text/html; charset=utf-8',
      '',
      opts.html || opts.text,
    ].join('\r\n');

    const scanner = new SpamScanner();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const report = await (scanner as any).scan(emailSource) as {
      results: {
        classification: { category: string; probability: number };
        phishing: Array<{ url?: string; description?: string }>;
        arbitrary: Array<{ name?: string; description?: string; score?: number }>;
        patterns: Array<{ name?: string; description?: string; score?: number }>;
      };
    };

    // 3. Map to SpamCheckResult
    // Scale probability (0–1) to a 0–10 score to match SpamAssassin-style thresholds
    const score = Number((report.results.classification.probability * 10).toFixed(2));

    const issues: SpamCheckResult['issues'] = [];

    for (const p of report.results.phishing ?? []) {
      issues.push({
        rule: 'PHISHING',
        description: p.description ?? `Phishing URL detected: ${p.url ?? ''}`,
        score: 2.0,
      });
    }

    for (const a of report.results.arbitrary ?? []) {
      issues.push({
        rule: a.name ?? 'ARBITRARY',
        description: a.description ?? '',
        score: a.score ?? 1.0,
      });
    }

    for (const p of report.results.patterns ?? []) {
      issues.push({
        rule: p.name ?? 'PATTERN',
        description: p.description ?? '',
        score: p.score ?? 0.5,
      });
    }

    const result = { score, threshold, passed: score <= threshold, issues };
    log.info({ location_id: opts.locationId, score, threshold, passed: result.passed }, 'spam check complete');
    return result;
    */
  }
}
