import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { ElasticEmailProvider } from './elasticEmail.js';
import { SmtpProvider } from './smtp.js';
import { MailNotConfiguredError, type MailMessage, type MailProvider } from './types.js';

export * from './types.js';

/** Development provider: writes messages to the server log instead of sending. */
class LogProvider implements MailProvider {
  readonly name = 'log';
  readonly sent: MailMessage[] = [];
  async send(message: MailMessage) {
    this.sent.push(message);
    if (this.sent.length > 100) this.sent.shift();
    if (process.env.NODE_ENV !== 'test') {
      console.log(`\n--- email (MAIL_PROVIDER=log) to ${message.to}: ${message.subject}\n${message.text}\n---\n`);
    }
    return {};
  }
}

let provider: MailProvider | null | undefined;

export function mailProvider(): MailProvider | null {
  if (provider !== undefined) return provider;
  const c = config();
  switch (c.MAIL_PROVIDER) {
    case 'elasticemail':
      provider = new ElasticEmailProvider({
        apiKey: c.ELASTIC_EMAIL_API_KEY!,
        baseUrl: c.ELASTIC_EMAIL_API_URL,
        fromAddress: c.MAIL_FROM_ADDRESS!,
        fromName: c.MAIL_FROM_NAME,
      });
      break;
    case 'smtp':
      provider = new SmtpProvider({
        host: c.SMTP_HOST!,
        port: c.SMTP_PORT,
        secure: c.SMTP_SECURE,
        user: c.SMTP_USER,
        password: c.SMTP_PASSWORD,
        fromAddress: c.MAIL_FROM_ADDRESS!,
        fromName: c.MAIL_FROM_NAME,
      });
      break;
    case 'log':
      provider = new LogProvider();
      break;
    default:
      provider = null;
  }
  return provider;
}

export function setMailProvider(p: MailProvider | null): void {
  provider = p;
}

export function mailConfigured(): boolean {
  return mailProvider() !== null;
}

export async function sendMail(message: MailMessage): Promise<void> {
  const p = mailProvider();
  if (!p) throw new MailNotConfiguredError();
  const result = await p.send(message);
  // Log the fact of sending, never the body (which may contain one-time links).
  logger.info({ provider: p.name, subject: message.subject, messageId: result.id }, 'email sent');
}

/** Best-effort security notification; failures are logged, not thrown. */
export async function sendNotification(message: MailMessage): Promise<void> {
  if (!mailConfigured()) return;
  try {
    await sendMail(message);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'security notification could not be sent');
  }
}
