import type { ErrorCode, ErrorPayload } from '../shared/types';

/** Error with a stable code and a user-facing Spanish message (never containing financial data). */
export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function toErrorPayload(err: unknown): ErrorPayload {
  if (err instanceof AppError) return { code: err.code, message: err.message };
  const e = err as { code?: string; message?: string } | undefined;
  if (e?.code === 'ERR_SQLITE_ERROR' && /locked|busy/i.test(e.message ?? '')) {
    return { code: 'DB_BUSY', message: 'La base de datos está ocupada o bloqueada por otro proceso. Cierra otras instancias de Hormiga y vuelve a intentarlo.' };
  }
  return { code: 'INTERNAL', message: 'Se ha producido un error interno inesperado. Revisa el registro de la aplicación para más detalles.' };
}

export const notFound = (what: string) => new AppError('NOT_FOUND', `${what} no existe o ha sido eliminado.`);
export const invalid = (message: string) => new AppError('VALIDATION', message);
