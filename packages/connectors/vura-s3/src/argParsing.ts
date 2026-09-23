/** Tokenizes `!<command> --flag value --other "quoted value"` style magic-command lines. */
export function tokenize(commandLine: string, commandRoot: string): string[] {
    const stripped = commandLine.replace(new RegExp('^' + commandRoot.replace('.', '\\.') + '\\s*'), '');
    return stripped.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
}

/** Reads `--kebab-flag value` pairs from tokens into a camelCase-keyed object. */
export function readFlags(tokens: string[], out: Record<string, string>): void {
    for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];
        if (tok.startsWith('--')) {
            const key = tok.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
            out[key] = unquote(tokens[++i] || '');
        }
    }
}

export function unquote(s: string): string {
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
        return s.slice(1, -1);
    }
    return s;
}
