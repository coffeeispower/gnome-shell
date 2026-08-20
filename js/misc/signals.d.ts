export class EventEmitter {
    connect(signal: string, callback: (...args: any[]) => void): number;
    disconnect(id: number): void;
    emit(signal: string, ...args: any[]): void;

    connectObject(...args: any[]): void;
    disconnectObject(target: object): void;
    connect_object(...args: any[]): void;
    disconnect_object(target: object): void;
}
