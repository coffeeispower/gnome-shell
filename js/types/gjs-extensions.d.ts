/*
 * APIs added by js/ui/environment.js at runtime. These are intentionally
 * separate from the generated GIR declarations, which only describe the
 * underlying C libraries.
 */

declare module 'gi://GObject?version=2.0' {
    export namespace GObject {
        interface Object {
            connectObject(...args: unknown[]): void;
            connect_object(...args: unknown[]): void;
            disconnectObject(target: object): void;
            disconnect_object(target: object): void;
        }
    }
}

declare module 'gi://Clutter?version=51' {
    export namespace Clutter {
        interface Actor {
            [Symbol.iterator](): Iterator<Actor>;
            ease(params: Record<string, unknown>): void;
            ease_property(
                propertyName: string,
                target: unknown,
                params: Record<string, unknown>
            ): void;
        }
    }
}

declare module 'gi://GLib?version=2.0' {
    export namespace GLib {
        function idle_add_once(priority: number, callback: () => void): number;
        function timeout_add_once(
            priority: number,
            interval: number,
            callback: () => void
        ): number;
    }
}

interface Math {
    clamp(value: number, lower: number, upper: number): number;
}
