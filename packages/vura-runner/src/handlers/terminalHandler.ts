import * as path from 'path';
import { spawn } from 'child_process';
import { ProviderRegistry } from '@vura-data-os/core-sdk';
import { IVuraEnvironment, ICellLogger, FlownbCell } from '../interfaces';
import { handleFileIngestion } from './ingestionHandler';
import { ensurePythonVenv } from '../utils/pythonVenv';

export async function handleTerminal(
    cell: FlownbCell,
    env: IVuraEnvironment,
    logger: ICellLogger
): Promise<void> {
    const textLines = cell.value.split('\n');

    for (const line of textLines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed.startsWith('--') || trimmed.startsWith('#')) continue;

        if (trimmed.startsWith('!')) {
            const commandRoot = trimmed.split(' ')[0];

            if (commandRoot === '!ingest-file') {
                const match = trimmed.match(
                    /^!ingest-file\s+"([^"]+)"\s+(csv|excel|parquet|json)(?:\s+"([^"]+)")?\s+->\s+([^\s]+)$/
                );
                if (match) {
                    await handleFileIngestion(match[1], match[2], match[4], match[3], env, logger);
                    continue;
                } else {
                    throw new Error('Invalid !ingest-file command syntax');
                }
            }

            const provider = ProviderRegistry.getInstance().getProviderForCommand(commandRoot);
            if (provider) {
                await provider.handleCommand(commandRoot, cell, logger, env, trimmed);
                continue;
            }

            const shellCommand = trimmed.substring(1).trim();
            if (!shellCommand) continue;

            try {
                const envToUse = { ...process.env };
                if (/^(pip|python)(3(\.\d+)?)?\s/.test(shellCommand)) {
                    // Ensure the venv exists (it may not, if this pip/python command
                    // runs before any Python cell has executed) so its bin directory
                    // actually resolves the command instead of silently falling
                    // through to the system pip/python on PATH.
                    const pythonBin = await ensurePythonVenv(env, logger);
                    const venvBin = path.dirname(pythonBin);
                    envToUse['PATH'] = `${venvBin}${path.delimiter}${envToUse['PATH']}`;
                }

                await new Promise<void>((resolve, reject) => {
                    const child = spawn(shellCommand, {
                        cwd: env.notebookDir || process.cwd(),
                        env: envToUse,
                        shell: true
                    });

                    child.stdout.on('data', async (data: any) => {
                        await logger.logText(data.toString());
                    });

                    child.stderr.on('data', async (data: any) => {
                        await logger.logError(data.toString());
                    });

                    child.on('close', (code: number) => {
                        if (code === 0) resolve();
                        else reject(new Error(`Command exited with code ${code}`));
                    });
                });
            } catch (err: any) {
                throw new Error(`Terminal command execution failed for "${trimmed}": ${err.message}`);
            }
        } else {
            throw new Error(`Unknown syntax: "${trimmed}". Terminal cells expect commands starting with '!'.`);
        }
    }
}
