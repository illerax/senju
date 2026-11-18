declare const __SENJU_BUILD__: string | undefined;

/** Identifies the code of a build, so the UI can tell when the running daemon is older. */
export const BUILD_ID: string = typeof __SENJU_BUILD__ === 'string' ? __SENJU_BUILD__ : 'dev';
