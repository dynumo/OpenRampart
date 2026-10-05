declare module 'virtual:pwa-register' {
  export function registerSW(opts?: { immediate?: boolean }): (reload?: boolean) => Promise<void>;
}
