import type { MailMessage } from './types.js';

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function layout(title: string, paragraphs: string[], action?: { label: string; url: string }): string {
  const body = paragraphs.map((p) => `<p style="margin:0 0 16px">${escapeHtml(p)}</p>`).join('');
  const button = action
    ? `<p style="margin:24px 0"><a href="${escapeHtml(action.url)}" style="background:#546a80;color:#f7fbfe;padding:12px 20px;border-radius:6px;text-decoration:none;display:inline-block">${escapeHtml(action.label)}</a></p><p style="margin:0 0 16px;font-size:14px;color:#515f6e">If the button does not work, copy this address into your browser:<br>${escapeHtml(action.url)}</p>`
    : '';
  return `<!doctype html><html lang="en-GB"><body style="margin:0;background:#edf5fd;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#0a1622"><main style="max-width:560px;margin:0 auto;padding:32px 24px;background:#fcfeff"><h1 style="font-size:20px;margin:0 0 20px">${escapeHtml(title)}</h1>${body}${button}<p style="margin:32px 0 0;font-size:13px;color:#515f6e">Sent by OpenRampart, your personal record.</p></main></body></html>`;
}

function text(title: string, paragraphs: string[], action?: { label: string; url: string }): string {
  return [title, '', ...paragraphs.flatMap((p) => [p, '']), ...(action ? [`${action.label}: ${action.url}`, ''] : [])].join('\n');
}

export function invitationEmail(input: {
  to: string;
  ownerName: string;
  label: string;
  scopeSummary: string;
  url: string;
  expiresAt: Date;
}): MailMessage {
  const title = `${input.ownerName} has invited you to help with their OpenRampart record`;
  const paragraphs = [
    `${input.ownerName} would like you to be a Helper (${input.label}) on their OpenRampart record.`,
    `Access offered: ${input.scopeSummary}`,
    `This invitation can be used once and expires on ${input.expiresAt.toUTCString()}.`,
    'If you were not expecting this, you can ignore this email.',
  ];
  const action = { label: 'Review the invitation', url: input.url };
  return { to: input.to, subject: title, text: text(title, paragraphs, action), html: layout(title, paragraphs, action) };
}

export function passwordResetEmail(input: { to: string; url: string }): MailMessage {
  const title = 'Reset your OpenRampart password';
  const paragraphs = [
    'Someone asked to reset the password for your OpenRampart account.',
    'The link below works once and expires in one hour. You will still need your authenticator app or a recovery code to sign in.',
    'If you did not ask for this, you can ignore this email; your password has not changed.',
  ];
  const action = { label: 'Choose a new password', url: input.url };
  return { to: input.to, subject: title, text: text(title, paragraphs, action), html: layout(title, paragraphs, action) };
}

export function securityNotificationEmail(input: { to: string; summary: string; detail: string; url: string }): MailMessage {
  const title = `Security notice: ${input.summary}`;
  const paragraphs = [
    input.detail,
    'If this was you, no action is needed. If not, sign in and review your sessions and connections under Settings → Security.',
  ];
  const action = { label: 'Review security settings', url: input.url };
  return { to: input.to, subject: title, text: text(title, paragraphs, action), html: layout(title, paragraphs, action) };
}
