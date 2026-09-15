import * as vscode from 'vscode';

/**
 * Registers a command the same way vscode.commands.registerCommand does, but
 * never throws: VS Code throws synchronously if the command id is already
 * registered (e.g. a collision with another installed extension), and since
 * activate() has no top-level try/catch, an uncaught throw here would abort
 * the rest of activate() — including any registrations that haven't run yet.
 */
export function safeRegisterCommand(
    commandId: string,
    callback: (...args: any[]) => any
): vscode.Disposable {
    try {
        return vscode.commands.registerCommand(commandId, callback);
    } catch (err) {
        console.error(`Failed to register command "${commandId}" (likely a duplicate id):`, err);
        return { dispose: () => {} };
    }
}
