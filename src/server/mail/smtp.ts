import nodemailer, { type Transporter } from 'nodemailer';
import type { MailMessage, MailProvider } from './types.js';

export interface SmtpOptions {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  password?: string;
  fromAddress: string;
  fromName: string;
}

/** Portable SMTP provider for self-hosters who do not use Elastic Email. */
export class SmtpProvider implements MailProvider {
  readonly name = 'smtp';
  private transporter: Transporter;
  constructor(
    private readonly opts: SmtpOptions,
    transporter?: Transporter,
  ) {
    this.transporter = transporter ?? nodemailer.createTransport({
      host: opts.host,
      port: opts.port,
      secure: opts.secure,
      auth: opts.user ? { user: opts.user, pass: opts.password ?? '' } : undefined,
    });
  }

  async send(message: MailMessage): Promise<{ id?: string }> {
    const info = await this.transporter.sendMail({
      from: { name: this.opts.fromName, address: this.opts.fromAddress },
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    return { id: info.messageId };
  }
}
