import type Shell from 'gi://Shell';

declare global {
    var global: Shell.Global;

    var _: (message: string) => string;
    var C_: (context: string, message: string) => string;
    var N_: (message: string) => string;
    var ngettext: (singular: string, plural: string, count: number) => string;

    var log: typeof console.log;
    var logError: (error: unknown, message?: string) => void;
}

export {};
