export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface MailProvider {
  readonly name: string;
  send(message: MailMessage): Promise<{ id?: string }>;
}

export class MailNotConfiguredError extends Error {
  constructor() {
    super('Email delivery is not configured (MAIL_PROVIDER=none)');
    this.name = 'MailNotConfiguredError';
  }
}
