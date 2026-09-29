/** Provider-agnostic contracts for email ingestion (Gmail today; Outlook/IMAP can implement the same). */

export interface AttachmentMeta {
  /** Stable key within the message (the provider's attachment ids may change between calls). */
  key: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  /** Provider-specific reference used to download it. */
  ref: string | null;
  /** Some providers inline small attachments. */
  inlineData: string | null;
}

export interface EmailMessageMeta {
  id: string;
  subject: string;
  from: string;
  /** ISO timestamp. */
  date: string;
  attachments: AttachmentMeta[];
}

export interface EmailSearch {
  query: string;
  maxResults: number;
}

export interface EmailProvider {
  readonly id: string;
  /** Returns message ids matching the query, newest first. */
  search(search: EmailSearch): Promise<string[]>;
  getMessage(id: string): Promise<EmailMessageMeta>;
  downloadAttachment(messageId: string, attachment: AttachmentMeta): Promise<Uint8Array>;
  /** Address of the connected account. */
  getAccount(): Promise<string>;
}

/** OS-backed secret storage (DPAPI/Keychain/libsecret via Electron safeStorage in production). */
export interface SecretVault {
  isAvailable(): boolean;
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}
