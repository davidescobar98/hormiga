import { contextBridge, ipcRenderer } from 'electron';
import type { HormigaBridge, Channel, EventName } from '../shared/api';
import { CHANNELS, EVENTS, IPC_PREFIX } from '../shared/channels';
import type { ErrorCode, IpcResult } from '../shared/types';

const allowedChannels = new Set<string>(CHANNELS);
const allowedEvents = new Set<string>(EVENTS);

class HormigaError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
    this.name = 'HormigaError';
  }
}

const toPlain = (e: HormigaError) => ({ name: e.name, code: e.code, message: e.message });

/**
 * The only surface exposed to the renderer: typed invoke over an allow-list of channels and
 * subscription to an allow-list of events. No Node, filesystem or ipcRenderer access leaks through.
 */
const bridge: HormigaBridge = {
  async invoke(channel: Channel, input?: unknown) {
    if (!allowedChannels.has(channel)) return Promise.reject(toPlain(new HormigaError('VALIDATION', `Canal no permitido: ${String(channel)}`)));
    const result = (await ipcRenderer.invoke(`${IPC_PREFIX}${channel}`, input)) as IpcResult<never>;
    if (result.ok) return result.data;
    // contextBridge only keeps `message` of Error objects; a plain object keeps the error code too.
    return Promise.reject(toPlain(new HormigaError(result.error.code, result.error.message)));
  },
  on(event: EventName, listener: (payload: never) => void) {
    if (!allowedEvents.has(event)) throw new Error(`Evento no permitido: ${String(event)}`);
    const wrapped = (_e: Electron.IpcRendererEvent, name: string, payload: unknown) => {
      if (name === event) listener(payload as never);
    };
    ipcRenderer.on(`${IPC_PREFIX}event`, wrapped);
    return () => {
      ipcRenderer.removeListener(`${IPC_PREFIX}event`, wrapped);
    };
  },
} as HormigaBridge;

contextBridge.exposeInMainWorld('hormiga', bridge);
