import type { AttachmentMeta, EmailMessageMeta, EmailProvider, EmailSearch } from './types';
import { mapGoogleError } from './gmailAuth';

/** Minimal HTTP surface used by the provider (an authorized google-auth-library client in production). */
export interface GmailHttp {
  get<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T>;
}

export const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me/';

interface GmailPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailPart[];
}

interface GmailMessage {
  id: string;
  internalDate?: string;
  payload?: GmailPart;
}

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export function decodeBase64Url(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
}

function collectAttachments(part: GmailPart | undefined, out: AttachmentMeta[]): void {
  if (!part) return;
  if (part.filename && (part.body?.attachmentId || part.body?.data)) {
    out.push({
      key: `${part.partId ?? out.length}:${part.filename}`,
      fileName: part.filename,
      mimeType: (part.mimeType ?? 'application/octet-stream').toLowerCase(),
      sizeBytes: part.body?.size ?? 0,
      ref: part.body?.attachmentId ?? null,
      inlineData: part.body?.attachmentId ? null : (part.body?.data ?? null),
    });
  }
  for (const p of part.parts ?? []) collectAttachments(p, out);
}

/** Gmail implementation of EmailProvider. Read-only calls only (list, get, attachments.get, profile). */
export class GmailEmailProvider implements EmailProvider {
  readonly id = 'gmail';

  constructor(private readonly http: GmailHttp) {}

  private async call<T>(path: string, params?: Record<string, string | number | undefined>): Promise<T> {
    try {
      return await this.http.get<T>(path, params);
    } catch (err) {
      throw mapGoogleError(err);
    }
  }

  async getAccount(): Promise<string> {
    const p = await this.call<{ emailAddress: string }>('profile');
    return p.emailAddress;
  }

  async search(s: EmailSearch): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const page = await this.call<{ messages?: { id: string }[]; nextPageToken?: string }>('messages', {
        q: s.query,
        maxResults: Math.min(100, s.maxResults - ids.length),
        pageToken,
      });
      for (const m of page.messages ?? []) ids.push(m.id);
      pageToken = page.nextPageToken;
    } while (pageToken && ids.length < s.maxResults);
    return ids;
  }

  async getMessage(id: string): Promise<EmailMessageMeta> {
    const m = await this.call<GmailMessage>(`messages/${encodeURIComponent(id)}`, { format: 'full' });
    const headers = m.payload?.headers ?? [];
    const header = (name: string) => headers.find((h) => h.name.toLowerCase() === name)?.value ?? '';
    const attachments: AttachmentMeta[] = [];
    collectAttachments(m.payload, attachments);
    const dateMs = m.internalDate ? Number(m.internalDate) : Date.parse(header('date'));
    return {
      id: m.id,
      subject: header('subject'),
      from: header('from'),
      date: Number.isFinite(dateMs) ? new Date(dateMs).toISOString() : new Date(0).toISOString(),
      attachments,
    };
  }

  async downloadAttachment(messageId: string, a: AttachmentMeta): Promise<Uint8Array> {
    if (a.sizeBytes > MAX_ATTACHMENT_BYTES) throw new Error('Adjunto demasiado grande');
    if (a.inlineData) return decodeBase64Url(a.inlineData);
    if (!a.ref) throw new Error('Adjunto sin referencia');
    const r = await this.call<{ data: string; size: number }>(`messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(a.ref)}`);
    return decodeBase64Url(r.data);
  }
}
