import type { MailMessage, MailProvider } from './types.js';

/**
 * Elastic Email REST API v4 provider (API-key authentication, not SMTP).
 * POST {baseUrl}/emails/transactional with the X-ElasticEmail-ApiKey header.
 * Open and click tracking are explicitly disabled: OpenRampart does not track
 * recipients.
 *
 * The API key is read from server configuration only and is never sent to the
 * browser or written to logs.
 */
export interface ElasticEmailOptions {
  apiKey: string;
  baseUrl: string;
  fromAddress: string;
  fromName: string;
  fetchImpl?: typeof fetch;
}

export class ElasticEmailProvider implements MailProvider {
  readonly name = 'elasticemail';
  constructor(private readonly opts: ElasticEmailOptions) {}

  buildRequest(message: MailMessage): { url: string; init: RequestInit } {
    const body = {
      Recipients: { To: [message.to] },
      Content: {
        From: `${this.opts.fromName} <${this.opts.fromAddress}>`,
        Subject: message.subject,
        Body: [
          { ContentType: 'PlainText', Content: message.text, Charset: 'utf-8' },
          { ContentType: 'HTML', Content: message.html, Charset: 'utf-8' },
        ],
      },
      Options: { TrackOpens: false, TrackClicks: false },
    };
    return {
      url: `${this.opts.baseUrl.replace(/\/+$/, '')}/emails/transactional`,
      init: {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-ElasticEmail-ApiKey': this.opts.apiKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      },
    };
  }

  async send(message: MailMessage): Promise<{ id?: string }> {
    const { url, init } = this.buildRequest(message);
    const res = await (this.opts.fetchImpl ?? fetch)(url, init);
    const text = await res.text();
    if (!res.ok) {
      // Elastic Email error bodies describe the problem without echoing the key.
      throw new Error(`Elastic Email API returned ${res.status}: ${text.slice(0, 300)}`);
    }
    try {
      const parsed = JSON.parse(text) as { MessageID?: string; TransactionID?: string };
      return { id: parsed.MessageID ?? parsed.TransactionID };
    } catch {
      return {};
    }
  }
}
