export const colors = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    underline: '\x1b[4m',
    green: '\x1b[32m',
    // Warm Amber / Golden Orange (\x1b[38;2;245;158;11m)
    yellow: '\x1b[38;2;245;158;11m',
    red: '\x1b[31m',
    cyan: '\x1b[36m',
    magenta: '\x1b[35m',
    blue: '\x1b[34m',
    brightGreen: '\x1b[92m',
    // Warm Soft Amber Orange (\x1b[38;2;251;191;36m)
    brightYellow: '\x1b[38;2;245;158;11m',
    brightRed: '\x1b[91m',
    brightCyan: '\x1b[96m'
};

export function logSuccess(msg: string) {
    console.log(`${colors.bold}${colors.brightGreen}✅ ${msg}${colors.reset}`);
}

export function logWarning(msg: string) {
    console.warn(`${colors.bold}${colors.yellow}⚠️  ${msg}${colors.reset}`);
}

export function logError(msg: string) {
    console.error(`${colors.bold}${colors.brightRed}❌ ${msg}${colors.reset}`);
}

export function logInfo(msg: string) {
    console.log(`${colors.brightCyan}${msg}${colors.reset}`);
}
