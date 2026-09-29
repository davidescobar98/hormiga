import type { HormigaBridge } from '../shared/api';

declare global {
  interface Window {
    hormiga: HormigaBridge;
  }
}

export {};
