export type CliResult<T> =
    | { success: true; data?: T }
    | { success: false; error: string };
