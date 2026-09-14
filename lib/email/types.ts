/**
 * The one shape every email transport implements. Adding a provider means adding
 * a module that satisfies this and registering it in `lib/email/index.ts` — the
 * six call sites across the app only ever see `sendEmail`.
 */
export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  /** Sender address. Falls back to the configured default when omitted. */
  from?: string;
}

export interface SendResult {
  /** Provider's own id for the message, for correlating with their logs. */
  id: string;
  /** Which transport actually delivered it. */
  via: string;
}

export interface EmailTransport {
  readonly name: string;
  /** True when this transport has everything it needs to attempt a send. */
  configured(): boolean;
  send(message: EmailMessage): Promise<SendResult>;
}
